package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.ai.AgentContracts.ProgressItem;
import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.ai.AgentContracts.TaskSnapshot;
import com.manao.poc4.ai.AgentContracts.ToolRequest;
import com.manao.poc4.ai.AgentContracts.WorkerStart;
import com.manao.poc4.ai.AgentContracts.WorkerStatus;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.AiConfig.AiProperties;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * The stage-one task lifecycle over the real store and real project tools: the task and its
 * fencing epoch are persisted inside the shared gate before the worker is called, the first
 * correct (instance, epoch) callback or start ACK binds the instance, progress is a monotonic
 * idempotent sequence with gap answers, a provider error that settles normally becomes FAILED,
 * and the close flow refuses new tool calls before releasing the project. The Pi worker is a
 * fake; every durable decision is observed in the database.
 */
class AgentTaskServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "ai-owner";
    private static final String PROJECT = "ai-project";
    private static final String INSTANCE = "worker-1";

    private static final class FakePiWorkerClient implements PiWorkerClient {
        final List<WorkerStart> starts = new ArrayList<>();
        final List<String> stops = new ArrayList<>();
        boolean notConfigured;
        boolean unreachable;
        boolean statusBroken;
        String statusInstance = INSTANCE;
        String statusState = "RUNNING";
        StartBehavior startBehavior = this::defaultStart;

        interface StartBehavior {
            WorkerStatus start(WorkerStart start);
        }

        WorkerStatus defaultStart(WorkerStart start) {
            return new WorkerStatus(start.taskId(), INSTANCE, "RUNNING");
        }

        @Override public WorkerStatus start(WorkerStart start) {
            starts.add(start);
            if (notConfigured) {
                throw new ApiException("AI_WORKER_NOT_CONFIGURED", 503, "the worker has no model configuration");
            }
            if (unreachable) {
                throw new ApiException("AI_WORKER_UNREACHABLE", 502, "the worker could not be reached");
            }
            return startBehavior.start(start);
        }

        @Override public WorkerStatus status(String taskId) {
            if (statusBroken) {
                throw new ApiException("AI_WORKER_UNREACHABLE", 502, "the worker could not be reached");
            }
            return new WorkerStatus(taskId, statusInstance, statusState);
        }

        @Override public WorkerStatus stop(String taskId) {
            stops.add(taskId);
            return new WorkerStatus(taskId, INSTANCE, "STOPPING");
        }
    }

    /** Real store, real gate, real project tools over mocked transports, fake worker. */
    private static final class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final JdbcTemplate jdbc = db.jdbc();
        final String taskId = UUID.randomUUID().toString();
        final FakePiWorkerClient worker = new FakePiWorkerClient();
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final WorkspaceAgent agent = org.mockito.Mockito.mock(WorkspaceAgent.class);
        final DevelopmentBuildExecutor builds = org.mockito.Mockito.mock(DevelopmentBuildExecutor.class);
        final AgentProjectTools tools;
        final AgentTaskService service;

        Harness() {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, 'ai-owner', 'unused', ?)",
                OWNER, now);
            jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                    + " VALUES (?, ?, 'ai-project', 'READY', 7, ?, ?)", PROJECT, OWNER, now, now);
            tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            org.mockito.Mockito.when(agent.tree(org.mockito.ArgumentMatchers.eq(PROJECT),
                    org.mockito.ArgumentMatchers.anyString()))
                .thenReturn(new WorkspaceAgent.Tree("", List.of()));
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, gate);
            WorkspaceService workspace = new WorkspaceService(store, operations, agent, gate, tasks);
            tools = new AgentProjectTools(tasks, store, workspace, operations, gate, builds);
            service = new AgentTaskService(tasks, gate, worker, tools,
                new AiProperties(true, "", new AiProperties.Worker("http://worker.invalid", "worker-token"),
                    new AiProperties.Internal("internal-token")));
        }

        /** A write_file call row carrying an unresolved PENDING workspace receipt. */
        void insertUnverifiedWriteCall(String callId, String operationId) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                    INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                        state, workspace_operation_id, expected_revision, created_at, updated_at)
                    VALUES (?, ?, ?, 'write_file', '{"path":"src/Demo.java"}', 'NEEDS_ATTENTION', ?, 7, ?, ?)
                    """,
                taskId, callId, "a".repeat(64), operationId, now, now);
            jdbc.update("""
                    INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256,
                        receipt_path, receipt_sha256, state, created_at)
                    VALUES (?, ?, 7, ?, ?, ?, ?, 'PENDING', ?)
                    """,
                operationId, PROJECT, "b".repeat(64), "c".repeat(64),
                ".manao/receipts/" + operationId + ".json", "d".repeat(64), now);
        }

        /** A build call row carrying a recorded Kubernetes identity. */
        void insertBoundBuildCall(String callId, String jobName) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                    INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                        state, workspace_operation_id, expected_revision, job_name, job_uid, pod_uid,
                        created_at, updated_at)
                    VALUES (?, ?, ?, 'build', '{"goal":"compile"}', 'RUNNING', ?, 7, ?, 'uid-job', 'uid-pod', ?, ?)
                    """,
                taskId, callId, "a".repeat(64), "cmd-" + callId, jobName, now, now);
        }

        /** A build call row whose identity was never bound — the outcome is unknown. */
        void insertUnrecordedBuildCall(String callId, String state) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                    INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                        state, workspace_operation_id, expected_revision, created_at, updated_at)
                    VALUES (?, ?, ?, 'build', '{"goal":"compile"}', ?, ?, 7, ?, ?)
                    """,
                taskId, callId, "a".repeat(64), state, "cmd-" + callId, now, now);
        }

        TaskRequest request() {
            return new TaskRequest(taskId, "repair the failing demo controller", 7);
        }

        TaskSnapshot submit() {
            return service.submit(OWNER, PROJECT, request());
        }

        ProgressItem item(long seq, String kind, String text) {
            return new ProgressItem(seq, kind, text, false);
        }

        String rowState() {
            return jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowFailureCode() {
            return jdbc.queryForObject("SELECT failure_code FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowInstance() {
            return jdbc.queryForObject("SELECT worker_instance_id FROM agent_task WHERE id = ?", String.class, taskId);
        }

        long rowEpoch() {
            return jdbc.queryForObject("SELECT worker_epoch FROM agent_task WHERE id = ?", Long.class, taskId);
        }

        int progressCount() {
            Integer count = jdbc.queryForObject(
                "SELECT JSON_LENGTH(JSON_EXTRACT(progress_json, '$.items')) FROM agent_task WHERE id = ?",
                Integer.class, taskId);
            return count == null ? 0 : count;
        }

        @Override public void close() {
            db.close();
        }
    }

    @Test
    void theTaskAndItsEpochArePersistedBeforeTheWorkerIsCalled() {
        try (Harness h = new Harness()) {
            List<long[]> observed = new ArrayList<>();
            h.worker.startBehavior = start -> {
                Long epoch = h.jdbc.queryForObject(
                    "SELECT worker_epoch FROM agent_task WHERE id = ?", Long.class, start.taskId());
                observed.add(new long[] { epoch == null ? -1 : epoch });
                return new WorkerStatus(start.taskId(), INSTANCE, "RUNNING");
            };
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(observed).hasSize(1);
            assertThat(observed.get(0)[0]).isGreaterThanOrEqualTo(1);
            assertThat(h.rowEpoch()).isEqualTo(1);
        }
    }

    @Test
    void theStartAckBindsTheInstanceAndRunsTheTask() {
        try (Harness h = new Harness()) {
            assertThat(h.submit().state()).isEqualTo(AgentContracts.TaskState.QUEUED);
            assertThat(h.rowState()).isEqualTo("RUNNING");
            assertThat(h.rowInstance()).isEqualTo(INSTANCE);
        }
    }

    @Test
    void resubmittingTheSameRequestReDrivesStartWithANewEpochAndALateAckCannotRegress() {
        try (Harness h = new Harness()) {
            h.submit();
            assertThat(h.rowEpoch()).isEqualTo(1);
            // The same request re-drives the start under a new fencing epoch.
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(h.rowEpoch()).isEqualTo(2);
            // A late ACK from the superseded attempt must not move the durable state.
            h.service.onStartAck(h.taskId, 1, new WorkerStatus(h.taskId, "stale-worker", "RUNNING"));
            assertThat(h.rowInstance()).isEqualTo(INSTANCE);
            assertThat(h.rowEpoch()).isEqualTo(2);
        }
    }

    @Test
    void aCallbackBeforeTheStartAckBindsTheInstance() {
        try (Harness h = new Harness()) {
            // Both the start response and the reconciliation read are lost, but the
            // worker accepted and starts calling back.
            h.worker.unreachable = true;
            h.worker.statusBroken = true;
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(h.rowState()).isEqualTo("QUEUED");
            h.service.invokeTool(h.taskId, "call-1", INSTANCE, h.rowEpoch(),
                new ToolRequest("call-1", "list_files", 7, JSON.createObjectNode()));
            assertThat(h.rowState()).isEqualTo("RUNNING");
            assertThat(h.rowInstance()).isEqualTo(INSTANCE);
        }
    }

    @Test
    void aMissingModelConfigurationFailsTheTaskBeforeAnySessionStarts() {
        try (Harness h = new Harness()) {
            h.worker.notConfigured = true;
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_WORKER_NOT_CONFIGURED");
            // The failure releases the project's writes.
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void aLostStartResponseIsReconciledAgainstTheWorker() {
        try (Harness h = new Harness()) {
            // The start response is lost, but the worker accepted and is running.
            h.worker.unreachable = true;
            h.worker.statusInstance = "worker-2";
            h.service.submit(OWNER, PROJECT, h.request());
            // The explicit reconciliation bound the running session under the current
            // epoch instead of leaving the task undecided.
            assertThat(h.rowState()).isEqualTo("RUNNING");
            assertThat(h.rowInstance()).isEqualTo("worker-2");
        }
    }

    @Test
    void anUnreachableWorkerKeepsTheQueuedTaskForARedrive() {
        try (Harness h = new Harness()) {
            h.worker.unreachable = true;
            h.worker.statusBroken = true;
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(h.rowState()).isEqualTo("QUEUED");
            // The retained task still occupies the project: no browser write may slip in.
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void wrongEpochOrInstanceNeverTriggersATool() {
        try (Harness h = new Harness()) {
            h.submit();
            ToolRequest request = new ToolRequest("call-1", "list_files", 7, JSON.createObjectNode());
            assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "call-1", INSTANCE, 999, request))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_EPOCH_MISMATCH"));
            Integer rows = h.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ?", Integer.class, h.taskId);
            assertThat(rows).isZero();
            // A different instance id under the correct epoch is refused after the ACK binding.
            assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "call-2", "other-worker", h.rowEpoch(), request))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_INSTANCE_MISMATCH"));
            rows = h.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ?", Integer.class, h.taskId);
            assertThat(rows).isZero();
        }
    }

    @Test
    void progressIsMonotonicIdempotentAndAnswersGapsWithTheExpectedSeq() {
        try (Harness h = new Harness()) {
            h.submit();
            // A gap is refused with the expected seq.
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(2, "message", "second")))
                .isInstanceOfSatisfying(com.manao.poc4.ai.ProgressGapException.class,
                    ex -> assertThat(ex.expectedSeq()).isEqualTo(1));
            // In-order items append.
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "message", "first"));
            assertThat(h.progressCount()).isEqualTo(1);
            // The same seq with the same payload is an idempotent replay.
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "message", "first"));
            assertThat(h.progressCount()).isEqualTo(1);
            // The same seq with a different payload is refused and never appended.
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "message", "forged")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_PROGRESS_MISMATCH"));
            assertThat(h.progressCount()).isEqualTo(1);
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(2, "message", "second"));
            assertThat(h.progressCount()).isEqualTo(2);
            // A replay of an OLDER retained seq with different bytes is a forgery, not an idempotent replay.
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "message", "forged-old")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_PROGRESS_MISMATCH"));
            assertThat(h.progressCount()).isEqualTo(2);
            String lastSha = h.jdbc.queryForObject(
                "SELECT JSON_UNQUOTE(JSON_EXTRACT(progress_json, '$.lastPayloadSha')) FROM agent_task WHERE id = ?",
                String.class, h.taskId);
            assertThat(lastSha).hasSize(64);
        }
    }

    @Test
    void aProviderErrorThatSettlesNormallyIsRecordedAsFailed() {
        try (Harness h = new Harness()) {
            h.submit();
            String terminal = JSON.createObjectNode()
                .put("state", "FAILED")
                .put("summary", "provider overloaded (503)")
                .put("failureCode", "AI_PROVIDER_ERROR")
                .toString();
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", terminal));
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_PROVIDER_ERROR");
            String summary = h.jdbc.queryForObject("SELECT summary FROM agent_task WHERE id = ?", String.class, h.taskId);
            assertThat(summary).isEqualTo("provider overloaded (503)");
            // The failure releases the project's writes.
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void aWorkerTerminalCannotOverwriteASettledTask() {
        try (Harness h = new Harness()) {
            h.submit();
            String terminal = JSON.createObjectNode()
                .put("state", "COMPLETED").put("summary", "done").putNull("failureCode")
                .toString();
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", terminal));
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            String late = JSON.createObjectNode()
                .put("state", "FAILED").put("summary", "late").put("failureCode", "AI_PROVIDER_ERROR")
                .toString();
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(2, "terminal", late)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
            assertThat(h.rowState()).isEqualTo("COMPLETED");
        }
    }

    @Test
    void closeStopsTheWorkerRefusesNewCallsAndReleasesTheProject() {
        try (Harness h = new Harness()) {
            h.submit();
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.worker.stops).containsExactly(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
            // A brand-new tool call is refused after the close.
            assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "call-late", INSTANCE, h.rowEpoch(),
                    new ToolRequest("call-late", "list_files", 7, JSON.createObjectNode())))
                .isInstanceOf(ApiException.class);
        }
    }

    @Test
    void closeKeepsTheTaskOccupiedWhileAFileReceiptIsUnverifiable() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnverifiedWriteCall("call-write", "op-unverified");
            // The agent receipt cannot be produced: the shared reconcile path fails closed.
            org.mockito.Mockito.when(h.agent.receipt(org.mockito.ArgumentMatchers.eq(PROJECT),
                    org.mockito.ArgumentMatchers.anyString()))
                .thenReturn(java.util.Optional.empty());
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            // The worker was stopped, but the unknown file state keeps the project occupied.
            assertThat(h.worker.stops).containsExactly(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void closeReleasesAfterTheBuildCleanupIsConfirmed() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            org.mockito.Mockito.when(h.builds.close(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "closed", "", false, List.of(), true));
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void closeKeepsTheTaskOccupiedWhenTheBuildCleanupIsNotConfirmed() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            org.mockito.Mockito.when(h.builds.close(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "closed", "", false, List.of(), false));
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void closeKeepsTheTaskOccupiedWhileAnUnrecordedBuildMayExist() {
        try (Harness h = new Harness()) {
            h.submit();
            // The build started abnormally: no identity was ever bound and the row was
            // left NEEDS_ATTENTION — the Job may still exist.
            h.insertUnrecordedBuildCall("call-build", "NEEDS_ATTENTION");
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(true);
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void closeReleasesWhenAnUnrecordedBuildIsProvenAbsent() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnrecordedBuildCall("call-build", "RUNNING");
            // A successful cluster query proves no Job and no pod was ever created.
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(false);
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void aSettledWorkerStatusLeavesTheTaskUndecidedInsteadOfBindingRunning() {
        try (Harness h = new Harness()) {
            h.worker.unreachable = true;
            h.worker.statusState = "COMPLETED";
            h.service.submit(OWNER, PROJECT, h.request());
            // The worker settled but no terminal reached the ledger: the explicit
            // undecided state keeps the project occupied; RUNNING is never bound over
            // a settled worker and no outcome is fabricated.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void aFailedEvidenceCloseCanBeRetriedAfterTheEvidenceRecovers() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnrecordedBuildCall("call-build", "NEEDS_ATTENTION");
            // First close: the cluster answer is unclear (a Job may exist) — the close
            // stays armed and the project stays occupied.
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(true);
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThat(h.worker.stops).hasSize(1);
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            // The evidence recovers: a later successful query proves the build never
            // existed; the re-entrant close finishes and releases.
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(false);
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.worker.stops).hasSize(2);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void closeAndToolRegistrationRaceWithoutDeadlockOrDoubleRegistration() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            ExecutorService pool = Executors.newFixedThreadPool(2);
            CountDownLatch ready = new CountDownLatch(2);
            Future<?> closer = pool.submit(() -> {
                ready.countDown();
                ready.await(5, TimeUnit.SECONDS);
                h.service.close(h.taskId, "AI_CLOSED", "raced close");
                return null;
            });
            Future<?> registrar = pool.submit(() -> {
                ready.countDown();
                ready.await(5, TimeUnit.SECONDS);
                try {
                    h.service.invokeTool(h.taskId, "call-race", INSTANCE, h.rowEpoch(),
                        new ToolRequest("call-race", "list_files", 7, JSON.createObjectNode()));
                } catch (ApiException expected) {
                    // Losing the race to the close marker is a refusal, not a failure.
                }
                return null;
            });
            closer.get(10, TimeUnit.SECONDS);
            registrar.get(10, TimeUnit.SECONDS);
            pool.shutdownNow();
            assertThat(h.rowState()).isEqualTo("FAILED");
            // At most one of the two effects: a refused registration never registered a row.
            Integer rows = h.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                Integer.class, h.taskId, "call-race");
            assertThat(rows).isLessThanOrEqualTo(1);
        }
    }
}
