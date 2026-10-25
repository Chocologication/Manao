package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.ai.AgentContracts.ProgressItem;
import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.ai.AgentContracts.ToolRequest;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.run.JdbcRunStore;
import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunRecoveryService;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * The terminal settlement regression fixtures (repair plan 2026-10-25, task 1). They replay
 * the diagnosed incident (evidence: terminal-settlement-race-safe.json) against the real
 * store and the real project gate on a disposable MySQL schema — only the external
 * {@link JobCoordinator} is mocked. RED baseline: the authenticated terminal report is
 * refused 409 PROJECT_BUSY whenever anything (the Run recovery scan, most visibly) holds
 * the project gate, the refusal leaves no durable receipt, a terminal behind a missing
 * display message is intercepted by the seq check, and the task then stays undecided
 * RUNNING with its occupancy held. After the receipt entry lands (task 2), each report is
 * receipted without the gate, frozen against new side effects, and settled by exactly one
 * durable terminal decision.
 */
class AgentTerminalSettlementTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "settlement-owner";
    private static final String PROJECT = "settlement-project";
    private static final String INSTANCE = "settlement-worker";
    private static final String SUMMARY = "the model has finished the task";

    /**
     * The diagnosed race (acceptance case A): the Run recovery pauses inside its
     * identity-verified observation while holding the project gate; on another thread the
     * worker submits its authenticated terminal report. Desired: the report is receipted
     * without waiting for that gate, new tool admission is blocked, the project's writes
     * stay locked, and when the recovery resumes and its checks pass, ONE terminal decision
     * releases the occupancy.
     */
    @Test
    void terminalReportIsDurableWhileRunRecoveryHoldsTheProjectGate() throws Exception {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            String runId = h.seedRunningServiceRun();
            CountDownLatch observationEntered = new CountDownLatch(1);
            CountDownLatch releaseObservation = new CountDownLatch(1);
            CountDownLatch recoveryFinished = new CountDownLatch(1);
            JobCoordinator coordinator = Mockito.mock(JobCoordinator.class);
            Mockito.when(coordinator.observe(Mockito.any())).thenAnswer(invocation -> {
                observationEntered.countDown();
                if (!releaseObservation.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("the paused observation was never released");
                }
                return new JobCoordinator.JobObservation(JobCoordinator.ObservationKind.FOUND,
                    new JobCoordinator.JobFacts(true, false, false, false, null,
                        "diagnostic-pod", "diagnostic-uid", true, false), null);
            });
            RunRecoveryService recovery = new RunRecoveryService(h.runStore(), coordinator,
                null, null, h.gate, null);
            ExecutorService pool = Executors.newCachedThreadPool();
            try {
                pool.submit(() -> {
                    try {
                        recovery.recoverRuns();
                    } finally {
                        recoveryFinished.countDown();
                    }
                });
                assertThat(observationEntered.await(10, TimeUnit.SECONDS)).isTrue();
                // The recovery now holds the project gate from inside its paused observation.
                assertThat(h.runState(runId)).isEqualTo("RECOVERING");

                // The worker's delivery thread submits the authenticated terminal report.
                Future<Throwable> delivery = pool.submit(() -> {
                    try {
                        h.submitTerminal(37, "COMPLETED");
                        return null;
                    } catch (RuntimeException failure) {
                        return failure;
                    }
                });
                Throwable refusal = delivery.get(10, TimeUnit.SECONDS);
                assertThat(refusal)
                    .as("the authenticated terminal report must be receipted without waiting"
                        + " for the project gate (refused with: %s)", refusal)
                    .isNull();
                // The receipt is durable: a recorded terminal decision frozen for
                // verification — never a bare undecided RUNNING.
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                // New tool admission is blocked while the receipt is unverified.
                assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "post-terminal-call",
                        INSTANCE, 1, new ToolRequest("post-terminal-call", "list_files", 7,
                            JSON.createObjectNode())))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
                // Writes remain locked until the original effects are verified.
                assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));

                // Recovery resumes; its identity-verified observation passes and the run
                // returns to RUNNING.
                releaseObservation.countDown();
                assertThat(recoveryFinished.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(h.runState(runId)).isEqualTo("RUNNING");

                // ONE terminal decision releases the occupancy: the persisted receipt is
                // settled exactly once (the re-delivered identical report is the repaired
                // worker's retry that carries the settlement).
                h.submitTerminal(37, "COMPLETED");
                assertThat(h.rowState()).isEqualTo("COMPLETED");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                h.tasks.requireBrowserWritable(PROJECT);
            } finally {
                releaseObservation.countDown();
                // The recovery thread must finish its own durable writes before this test
                // releases the schema; the bound wait keeps a stuck observation from hanging.
                try {
                    recoveryFinished.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                pool.shutdownNow();
            }
        }
    }

    /**
     * The incident's delivery failure (acceptance case A/J): with the project gate held,
     * the last display message and the terminal are both refused — and the refusing
     * backend must never let that failed delivery end as a claimed acknowledgement. A
     * refused delivery records nothing and settles nothing; the SAME authenticated report
     * re-delivered while the gate is STILL held must be receipted instead of depending on
     * gate luck, and the one durable decision settles the task afterwards.
     */
    @Test
    void terminalDeliveryFailureNeverClaimsAcknowledgement() throws Exception {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            ExecutorService pool = Executors.newSingleThreadExecutor();
            // The contended gate of the incident, held by this thread; every delivery
            // below runs on a DIFFERENT thread — the gate is reentrant for its owner and
            // a same-thread submission would never see the contention.
            try (ProjectLifecycleGate.Lease contention = h.gate.tryAcquire(PROJECT).orElseThrow()) {
                // The refused deliveries of the incident (race-safe.json failedDeliveries).
                Throwable messageRefusal = pool.submit(
                    () -> catchThrowable(() -> h.recordProgress(37))).get(10, TimeUnit.SECONDS);
                assertThat(messageRefusal).isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("PROJECT_BUSY"));
                Throwable terminalRefusal = pool.submit(
                    () -> catchThrowable(() -> h.submitTerminal(38, "COMPLETED"))).get(10, TimeUnit.SECONDS);
                assertThat(terminalRefusal).isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("PROJECT_BUSY"));
                // A refused delivery claims no acknowledgement: no receipt, no settlement,
                // the display head never moved, the project stays occupied.
                assertThat(h.rowState()).isEqualTo("RUNNING");
                assertThat(h.progressLastSeq()).isEqualTo(36);
                assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));

                // The repaired delivery retries the SAME authenticated report while the
                // gate is still held: it must be receipted, not refused again.
                Throwable retryRefusal = pool.submit(
                    () -> catchThrowable(() -> h.submitTerminal(38, "COMPLETED"))).get(10, TimeUnit.SECONDS);
                assertThat(retryRefusal)
                    .as("the re-delivered terminal report must be receipted without the"
                        + " project gate (refused with: %s)", retryRefusal)
                    .isNull();
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            } finally {
                pool.shutdownNow();
            }
            // The gate contention is over: the persisted receipt settles exactly once.
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The terminal receipt must not depend on display-progress continuity (acceptance case
     * B): seq 37 was lost in delivery and the terminal arrives at seq 38. Desired: the
     * receipt lands independently and the missing message is never fabricated. RED
     * baseline: the seq check intercepts the terminal before anything is recorded.
     */
    @Test
    void missingDisplayProgressDoesNotBlockTerminalReceipt() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            Throwable refusal = catchThrowable(() -> h.submitTerminal(38, "COMPLETED"));
            assertThat(refusal)
                .as("the terminal receipt must not depend on display-progress continuity"
                    + " (refused with: %s)", refusal)
                .isNull();
            // The receipt is durable and the gap is never fabricated into the envelope.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            assertThat(h.progressCount()).isEqualTo(36);
            // One terminal decision settles the task; the envelope stays at its real head.
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.progressCount()).isEqualTo(36);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * Real store, real gate, real project tools over mocked transports; only the external
     * cluster boundary stays mocked per test. Mirrors {@link AgentTaskServiceTest} Harness.
     */
    private static final class SettlementHarness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final JdbcTemplate jdbc = db.jdbc();
        final String taskId = UUID.randomUUID().toString();
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final AgentProjectTools tools;
        final AgentTaskService service;
        private final JdbcRunStore runStore;

        SettlementHarness() {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'unused', ?)",
                OWNER, OWNER, now);
            jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                    + " VALUES (?, ?, ?, 'READY', 7, ?, ?)", PROJECT, OWNER, PROJECT, now, now);
            tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()),
                Clock.systemUTC());
            WorkspaceAgent agent = Mockito.mock(WorkspaceAgent.class);
            Mockito.when(agent.tree(Mockito.eq(PROJECT), Mockito.anyString()))
                .thenReturn(new WorkspaceAgent.Tree("", List.of()));
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(jdbc,
                new DataSourceTransactionManager(jdbc.getDataSource()));
            WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, gate);
            WorkspaceService workspace = new WorkspaceService(store, operations, agent, gate, tasks);
            tools = new AgentProjectTools(tasks, store, workspace, operations, gate,
                Mockito.mock(DevelopmentBuildExecutor.class));
            service = new AgentTaskService(tasks, gate, Mockito.mock(PiWorkerClient.class), tools);
            runStore = new JdbcRunStore(jdbc);
            // A RUNNING task with its worker identity bound — the authenticated callback state.
            tasks.create(OWNER, PROJECT, new TaskRequest(taskId, "settle the diagnosed race", 7));
            tasks.bindWorkerInstance(taskId, 1, INSTANCE);
        }

        /** One authenticated in-order display progress item from the bound worker. */
        void recordProgress(long seq) {
            service.applyProgress(taskId, INSTANCE, 1,
                new ProgressItem(seq, "message", "existing event " + seq, false));
        }

        /** One authenticated terminal report from the bound worker at the given seq. */
        void submitTerminal(long seq, String state) {
            String payload = JSON.createObjectNode()
                .put("state", state)
                .put("summary", SUMMARY)
                .putNull("failureCode")
                .toString();
            service.applyProgress(taskId, INSTANCE, 1, new ProgressItem(seq, "terminal", payload, false));
        }

        /** A RUNNING SERVICE run row over the real run store, ready for recovery. */
        String seedRunningServiceRun() {
            var budget = new RunPolicy.Resources(1000, 1073741824L, 1073741824L);
            var policy = new RunPolicy("java-spring-boot-web", new RunPolicy.RuntimeInfo.Java(17, 3),
                "mvn -q -DskipTests spring-boot:run", 1800, "SERVICE", 1800, 7200, budget, budget);
            long fence = runStore.acquireFencingToken().orElseThrow();
            String runId = UUID.randomUUID().toString();
            var created = new RunRecord(runId, PROJECT, 7, RunState.STARTING, policy.toJson(),
                null, null, null, null, null, null, 0, Instant.now(), fence);
            runStore.insertRun(created, fence);
            runStore.markRunning(runId, PROJECT, 0);
            return runId;
        }

        JdbcRunStore runStore() {
            return runStore;
        }

        String rowState() {
            return jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowFailureCode() {
            return jdbc.queryForObject("SELECT failure_code FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowSummary() {
            return jdbc.queryForObject("SELECT summary FROM agent_task WHERE id = ?", String.class, taskId);
        }

        int progressCount() {
            Integer count = jdbc.queryForObject(
                "SELECT JSON_LENGTH(JSON_EXTRACT(progress_json, '$.items')) FROM agent_task WHERE id = ?",
                Integer.class, taskId);
            return count == null ? 0 : count;
        }

        long progressLastSeq() {
            Integer lastSeq = jdbc.queryForObject(
                "SELECT JSON_EXTRACT(progress_json, '$.lastSeq') FROM agent_task WHERE id = ?",
                Integer.class, taskId);
            return lastSeq == null ? 0 : lastSeq;
        }

        String runState(String runId) {
            return jdbc.queryForObject("SELECT state FROM run WHERE id = ?", String.class, runId);
        }

        @Override public void close() {
            db.close();
        }
    }
}
