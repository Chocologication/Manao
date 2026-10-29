package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
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
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"ACKED", "CLOSING"})
    void pauseKeepsOccupancyUntilTerminalAckAndWorkerSlotRelease(String deliveryState) throws Exception {
        try (var h = new Harness()) {
            h.submit();
            var mvc = pauseMvc(h);
            var paused = pause(mvc, h.taskId, OWNER);
            assertThat(paused.getStatus()).isEqualTo(200);
            assertThat(paused.getContentAsString()).contains("\"closeReasonCode\":\"AI_PAUSED_BY_OWNER\"", "\"writesLocked\":true");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            String reportId = AgentTaskStore.terminalReportId(h.taskId, 1, h.tasks.requestSha256Of(h.taskId));
            var report = new AgentContracts.TerminalReport(1, reportId, AgentContracts.TaskState.FAILED, "aborted", "AI_ABORTED");
            var ack = h.service.recordTerminal(h.taskId, INSTANCE, 1, report);
            assertThat(ack.disposition()).isEqualTo(AgentContracts.TerminalDisposition.CLOSING);
            h.worker.frozenStatus = new WorkerStatus(h.taskId, INSTANCE, "FAILED", 1, 1L,
                h.tasks.requestSha256Of(h.taskId), "FAILED",
                new AgentContracts.WorkerTerminalDelivery(deliveryState, reportId, ack.reportSha256(), report));
            h.worker.activeTaskId = h.taskId;
            pause(mvc, h.taskId, OWNER);
            new AgentTaskSettlementService(h.tasks, h.gate, h.worker, h.tools).reconcile(h.taskId);
            assertThat(h.tasks.currentForOwner(OWNER, PROJECT)).isPresent();
            h.worker.activeTaskId = null;
            pause(mvc, h.taskId, OWNER);
            new AgentTaskSettlementService(h.tasks, h.gate, h.worker, h.tools).reconcile(h.taskId);
            assertThat(h.tasks.currentForOwner(OWNER, PROJECT)).isEmpty();
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.worker.starts).hasSize(1);
        }
    }

    @Test void pauseUnknownWorkerEvidenceKeepsLockAndEndPreservesPauseReason() throws Exception {
        try (var h = new Harness()) {
            h.submit();
            h.worker.statusBroken = true;
            assertThat(pause(pauseMvc(h), h.taskId, OWNER).getStatus()).isEqualTo(200);
            h.service.close(h.taskId, "AI_CLOSED", "closed");
            assertThat(h.tasks.currentForOwner(OWNER, PROJECT)).isPresent();
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isEqualTo("AI_PAUSED_BY_OWNER");
        }
    }

    @Test void pauseRejectsUnboundStartupWithoutRecordingIntent() throws Exception {
        try (var h = new Harness()) {
            h.tasks.create(OWNER, PROJECT, new TaskRequest(h.taskId, "goal", 7));
            var response = pause(pauseMvc(h), h.taskId, OWNER);
            assertThat(response.getStatus()).isEqualTo(409);
            assertThat(response.getContentAsString()).contains("AI_TASK_STARTING");
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isNull();
            h.service.close(h.taskId, "AI_CLOSED", "closed");
            assertThat(h.rowState()).isEqualTo("FAILED");
        }
    }

    @Test void pauseDeadlineAndExistingTerminalDecisionWin() throws Exception {
        try (var h = new Harness()) {
            h.submit();
            h.jdbc.update("UPDATE agent_task SET deadline_at=? WHERE id=?", Timestamp.from(java.time.Instant.now().minusSeconds(1)), h.taskId);
            assertThat(pause(pauseMvc(h), h.taskId, OWNER).getStatus()).isEqualTo(200);
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
        }
        try (var h = new Harness()) {
            h.submit();
            h.service.close(h.taskId, "AI_CLOSED", "closed");
            assertThat(pause(pauseMvc(h), h.taskId, OWNER).getStatus()).isEqualTo(200);
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isEqualTo("AI_CLOSED");
            assertThat(h.rowState()).isEqualTo("FAILED");
        }
    }

    @Test void pauseIsOwnerScopedAndGateBusyCanRetry() throws Exception {
        try (var h = new Harness()) {
            h.submit();
            var mvc = pauseMvc(h);
            assertThat(pause(mvc, h.taskId, "foreign").getStatus()).isEqualTo(404);
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var holder = new Thread(() -> {
                try (var lease = h.gate.tryAcquire(PROJECT).orElseThrow()) {
                    entered.countDown();
                    release.await();
                } catch (InterruptedException ex) { Thread.currentThread().interrupt(); }
            });
            holder.start();
            try {
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                assertThat(pause(mvc, h.taskId, OWNER).getStatus()).isEqualTo(409);
            } finally { release.countDown(); holder.join(3000); }
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isNull();
            assertThat(pause(mvc, h.taskId, OWNER).getStatus()).isEqualTo(200);
            assertThat(h.worker.starts).hasSize(1);
        }
    }

    @Test void aPersistedSuccessReceiptWinsBeforePauseAndKeepsItsOutcome() throws Exception {
        try (var h = new Harness()) {
            h.submit();
            String id = AgentTaskStore.terminalReportId(h.taskId, 1, h.tasks.requestSha256Of(h.taskId));
            h.service.recordTerminal(h.taskId, INSTANCE, 1, new AgentContracts.TerminalReport(
                1, id, AgentContracts.TaskState.COMPLETED, "done", null));
            assertThat(pause(pauseMvc(h), h.taskId, OWNER).getStatus()).isEqualTo(200);
            new AgentTaskSettlementService(h.tasks, h.gate, h.worker, h.tools).reconcile(h.taskId);
            assertThat(h.tasks.settlementView(h.taskId).closeReasonCode()).isNull();
            assertThat(h.rowState()).isEqualTo("COMPLETED");
        }
    }

    @Test void pausedTaskBlocksDeletionUntilVerifiedThenOriginalCleanupRemovesOwnedRows() {
        try (var h = new Harness()) {
            h.submit();
            var tx = new DataSourceTransactionManager(h.jdbc.getDataSource());
            var gateway = new com.manao.poc4.kubernetes.FakeKubernetesGateway();
            var cleaner = new com.manao.poc4.project.ProjectCleanupService(
                new com.manao.poc4.project.ProjectDeletionRepository(h.jdbc, tx), h.gate,
                org.mockito.Mockito.mock(com.manao.poc4.project.ProjectRuntimeCleaner.class), gateway, new WorkspaceJdbcStore(h.jdbc,tx));
            h.service.pause(h.taskId);
            assertThatThrownBy(() -> cleaner.delete(OWNER, PROJECT)).isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("PROJECT_BUSY"));
            assertThat(gateway.deletedProjects).isEmpty();
            String reportId = AgentTaskStore.terminalReportId(h.taskId,1,h.tasks.requestSha256Of(h.taskId));
            var report = new AgentContracts.TerminalReport(1,reportId,AgentContracts.TaskState.FAILED,"aborted","AI_ABORTED");
            var ack = h.service.recordTerminal(h.taskId,INSTANCE,1,report);
            h.worker.frozenStatus = new WorkerStatus(h.taskId,INSTANCE,"FAILED",1,1L,h.tasks.requestSha256Of(h.taskId),
                "FAILED",new AgentContracts.WorkerTerminalDelivery("CLOSING",reportId,ack.reportSha256(),report));
            new AgentTaskSettlementService(h.tasks,h.gate,h.worker,h.tools).reconcile(h.taskId);
            cleaner.delete(OWNER,PROJECT);
            assertThat(gateway.deletedProjects).containsExactly(PROJECT);
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM project WHERE id=?",Integer.class,PROJECT)).isZero();
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=?",Integer.class,h.taskId)).isZero();
        }
    }

    private static org.springframework.test.web.servlet.MockMvc pauseMvc(Harness h) {
        return org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(new AgentTaskController(h.service))
            .setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
    }

    private static org.springframework.mock.web.MockHttpServletResponse pause(org.springframework.test.web.servlet.MockMvc mvc,
            String taskId, String owner) throws Exception {
        return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .post("/api/v1/projects/" + PROJECT + "/agent-tasks/" + taskId + "/pause")
            .principal(new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(owner, "unused")))
            .andReturn().getResponse();
    }

    @Test void startsWithThePersistedDefaultEffort() {
        try (var h = new Harness()) {
            h.submit();
            assertThat(JSON.valueToTree(h.worker.starts.get(0)).path("reasoningEffort").asText()).isEqualTo("high");
        }
    }
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
        WorkerStatus frozenStatus;
        String activeTaskId;
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
            return frozenStatus != null ? frozenStatus : new WorkerStatus(taskId, statusInstance, statusState);
        }

        @Override public AgentContracts.WorkerProcessStatus processStatus() {
            return new AgentContracts.WorkerProcessStatus("1", INSTANCE, activeTaskId, null, null, true);
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
        final com.manao.poc4.run.RunService runs = org.mockito.Mockito.mock(com.manao.poc4.run.RunService.class);
        final com.manao.poc4.run.RunStore runStore = org.mockito.Mockito.mock(com.manao.poc4.run.RunStore.class);
        final ProjectApplicationProbe probe = org.mockito.Mockito.mock(ProjectApplicationProbe.class);
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
            tools = new AgentProjectTools(tasks, store, workspace, operations, gate, builds,
                new AgentApplicationTools(tasks, runs, runStore,
                    org.mockito.Mockito.mock(com.manao.poc4.log.RunLogService.class), probe, gate));
            service = new AgentTaskService(tasks, gate, worker, tools);
        }

        void completedStart(String call, String runId) {
            tasks.registerToolCall(taskId, call, "a".repeat(64), "application", "{\"action\":\"start\"}", 7,
                UUID.randomUUID().toString());
            jdbc.update("UPDATE agent_tool_call SET workspace_operation_id=? WHERE task_id=? AND tool_call_id=?",
                runId, taskId, call);
            tasks.completeToolCall(taskId, call, "{}");
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

        /** A write_file call row whose outcome is still unsettled (no receipt half needed here). */
        void insertUnsettledWriteCall(String callId, String operationId) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                    INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                        state, workspace_operation_id, expected_revision, created_at, updated_at)
                    VALUES (?, ?, ?, 'write_file', '{"path":"src/Demo.java"}', 'NEEDS_ATTENTION', ?, 7, ?, ?)
                    """,
                taskId, callId, "a".repeat(64), operationId, now, now);
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

        String closeReasonCode() {
            return jdbc.queryForObject("SELECT close_reason_code FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String callRowState(String callId) {
            return jdbc.queryForObject(
                "SELECT state FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                String.class, taskId, callId);
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
    void closingAValidationRejectedStopNeverTouchesTheExistingApplication() {
        try (Harness h = new Harness()) {
            h.submit();
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "old-run"))
                .thenReturn(applicationRun("old-run", "RUNNING", true));
            org.mockito.Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "invalid-stop", "old-run"))
                .thenAnswer(call -> {
                    org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "old-run"))
                        .thenReturn(applicationRun("old-run", "CANCELLED", false));
                    return applicationRun("old-run", "CANCELLED", false);
                });
            var request = new ToolRequest("invalid-stop", "application", 7,
                JSON.createObjectNode().put("action", "stop").put("runId", "old-run").put("waitSeconds", 11));
            var rejected = h.tools.invoke(h.taskId, request);
            assertThat(rejected.data().path("error").path("code").asText()).isEqualTo("VALIDATION_ERROR");
            assertThat(h.callRowState("invalid-stop")).isEqualTo("COMPLETED");
            assertThat(h.tools.invoke(h.taskId, request)).isEqualTo(rejected);
            org.mockito.Mockito.verifyNoInteractions(h.runs);

            h.service.close(h.taskId, "AI_CLOSED", "closed");

            org.mockito.Mockito.verifyNoInteractions(h.runs);
            assertThat(h.rowState()).isEqualTo("FAILED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void anAmbiguousStopStillRequiresCleanupBeforeCloseCanRelease() {
        for (boolean completedError : List.of(false, true)) {
            try (Harness h = new Harness()) {
                h.submit();
                org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "stop-target"))
                    .thenReturn(applicationRun("stop-target", "STOPPING", false));
                if (completedError) {
                    h.tasks.registerToolCall(h.taskId, "uncertain-stop", "a".repeat(64), "application",
                        "{\"action\":\"stop\",\"runId\":\"stop-target\",\"waitSeconds\":0}", 7, UUID.randomUUID().toString());
                    h.tasks.completeToolCall(h.taskId, "uncertain-stop",
                        "{\"data\":{\"error\":{\"code\":\"AI_APPLICATION_UNAVAILABLE\"}}}");
                } else {
                    org.mockito.Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "uncertain-stop", "stop-target"))
                        .thenThrow(new ApiException("PROJECT_BUSY", 409, "outcome unknown"));
                    assertThatThrownBy(() -> h.tools.invoke(h.taskId, new ToolRequest("uncertain-stop", "application", 7,
                        JSON.createObjectNode().put("action", "stop").put("runId", "stop-target").put("waitSeconds", 0))))
                        .isInstanceOfSatisfying(ApiException.class,
                            ex -> assertThat(ex.code()).isEqualTo("AI_APPLICATION_UNAVAILABLE"));
                    assertThat(h.callRowState("uncertain-stop")).isEqualTo("NEEDS_ATTENTION");
                }
                org.mockito.Mockito.doAnswer(call -> {
                    org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "stop-target"))
                        .thenReturn(applicationRun("stop-target", "CANCELLED", false));
                    return applicationRun("stop-target", "CANCELLED", false);
                }).when(h.runs).stopForAgent(OWNER, PROJECT, h.taskId, "uncertain-stop", "stop-target");

                h.service.close(h.taskId, "AI_CLOSED", "closed");

                org.mockito.Mockito.verify(h.runs, org.mockito.Mockito.times(completedError ? 1 : 2))
                    .stopForAgent(OWNER, PROJECT, h.taskId, "uncertain-stop", "stop-target");
                assertThat(h.rowState()).isEqualTo("FAILED");
                h.tasks.requireBrowserWritable(PROJECT);
            }
        }
    }

    @Test
    void failedTerminalStopsEvenACompletedStartAndRetainsTheOriginalFailureOnRetry() {
        try (Harness h = new Harness()) {
            h.submit();
            h.completedStart("start-done", "run-created");
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "run-created"))
                .thenReturn(applicationRun("run-created", "STOPPING", false));
            org.mockito.Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "start-done", "run-created"))
                .thenThrow(new ApiException("INTERNAL_ERROR", 503, "temporarily unavailable"));
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal",
                "{\"state\":\"FAILED\",\"failureCode\":\"PROVIDER_FAILED\",\"summary\":\"original failure\"}"));
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(),
                h.item(2, "terminal", "{\"state\":\"COMPLETED\"}"))).isInstanceOf(ApiException.class);
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "run-created"))
                .thenReturn(applicationRun("run-created", "CANCELLED", false));
            h.service.close(h.taskId, "AI_CLOSED", "replacement summary");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("PROVIDER_FAILED");
            assertThat(h.jdbc.queryForObject("SELECT summary FROM agent_task WHERE id=?", String.class, h.taskId))
                .isEqualTo("original failure");
            org.mockito.Mockito.verify(h.runs).stopForAgent(OWNER, PROJECT, h.taskId, "start-done", "run-created");
        }
    }

    @Test
    void untouchedOldApplicationSurvivesProviderFailureAndReadyNewRunSurvivesSuccess() {
        try (Harness h = new Harness()) {
            h.submit();
            org.mockito.Mockito.when(h.runs.active(OWNER, PROJECT))
                .thenReturn(java.util.Optional.of(applicationRun("old", "RUNNING", true)));
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal",
                "{\"state\":\"FAILED\",\"failureCode\":\"PROVIDER_FAILED\"}"));
            assertThat(h.rowState()).isEqualTo("FAILED");
            org.mockito.Mockito.verify(h.runs, org.mockito.Mockito.never()).stopForAgent(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        }
        try (Harness h = new Harness()) {
            h.submit();
            h.completedStart("start-ready", "ready");
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "ready"))
                .thenReturn(applicationRun("ready", "RUNNING", true));
            org.mockito.Mockito.when(h.runs.active(OWNER, PROJECT))
                .thenReturn(java.util.Optional.of(applicationRun("ready", "RUNNING", true)));
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", "{\"state\":\"COMPLETED\"}"));
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            org.mockito.Mockito.verify(h.runs, org.mockito.Mockito.never()).stopForAgent(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        }
    }

    /**
     * The fast close contract (repair design section 6): the close persists its intent
     * and returns promptly WITHOUT waiting for the run to settle — an unsettled run
     * leaves the task NEEDS_ATTENTION with the occupancy retained and the next close
     * (or reconcile) round finishes the verified cessation. The 120s budget wait is
     * gone: no close step ever waits on a run inside the close.
     */
    @Test
    void closeReturnsPromptlyWithTheIntentPersistedAndFinishesInLaterSteps() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            h.completedStart("start-done", "run-created");
            // The stop is accepted but the run is still withdrawing: nobody may wait for it.
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "run-created"))
                .thenReturn(applicationRun("run-created", "STOPPING", false));
            org.mockito.Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "start-done", "run-created"))
                .thenReturn(applicationRun("run-created", "STOPPING", false));
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<?> closing = pool.submit(() -> h.service.close(h.taskId, "AI_CLOSED", "closed"));
                closing.get(10, TimeUnit.SECONDS);
                // The intent is durably accepted; the occupancy is retained for the next round.
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
                assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
                assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
                // The later step finishes: the run reached its terminal state off-thread.
                org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "run-created"))
                    .thenReturn(applicationRun("run-created", "CANCELLED", false));
                h.service.close(h.taskId, "AI_CLOSED", "retry");
                assertThat(h.rowState()).isEqualTo("FAILED");
                assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
                assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
                h.tasks.requireBrowserWritable(PROJECT);
            } finally {
                pool.shutdownNow();
            }
        }
    }

    /**
     * A repeated close never overwrites the persisted reason, and a close of an already
     * settled task is a final no-op: the state, the failure code and the reason stay
     * exactly as the first close decided them.
     */
    @Test
    void repeatedCloseKeepsTheFirstReasonAndIsAFinalNoOp() {
        try (Harness h = new Harness()) {
            h.submit();
            h.service.close(h.taskId, "AI_CLOSED", "closed by the owner");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
            h.service.close(h.taskId, "AI_TASK_BUDGET_EXCEEDED", "a different reason must not land");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void closeDoesNotHoldTheProjectGateOrStoreMonitorWhileWaitingForRunSettlement() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            h.completedStart("start-done", "run-created");
            CountDownLatch stopEntered = new CountDownLatch(1);
            CountDownLatch observed = new CountDownLatch(1);
            java.util.concurrent.atomic.AtomicBoolean terminal = new java.util.concurrent.atomic.AtomicBoolean();
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "run-created")).thenAnswer(call ->
                applicationRun("run-created", terminal.get() ? "CANCELLED" : "STOPPING", false));
            org.mockito.Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "start-done", "run-created"))
                .thenAnswer(call -> {
                    stopEntered.countDown();
                    assertThat(observed.await(5, TimeUnit.SECONDS)).isTrue();
                    return applicationRun("run-created", "CANCELLED", false);
                });
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<?> closing = pool.submit(() -> h.service.close(h.taskId, "AI_CLOSED", "closed"));
                assertThat(stopEntered.await(5, TimeUnit.SECONDS)).isTrue();
                try (var lease = h.gate.tryAcquire(PROJECT).orElseThrow()) {
                    synchronized (h.tasks) { terminal.set(true); }
                }
                // Another close sees a terminal Run but must not release while the first control IO is still live.
                h.service.close(h.taskId, "AI_CLOSED", "concurrent retry");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.callRowState("start-done")).isEqualTo("COMPLETED");
                observed.countDown();
                closing.get(5, TimeUnit.SECONDS);
                assertThat(h.rowState()).isEqualTo("FAILED");
            } finally { observed.countDown(); pool.shutdownNow(); }
        }
    }

    private static com.manao.poc4.run.RunSummary applicationRun(String id, String state, boolean ready) {
        return new com.manao.poc4.run.RunSummary(id, state, "7", JSON.createObjectNode(),
            "2026-10-16T00:00:00Z", null, "CANCELLED".equals(state) ? "2026-10-16T00:01:00Z" : null,
            null, null, false, 0, null, ready ? "2026-10-16T00:00:00Z" : null, null);
    }

    @Test
    void aStartingApplicationDefersSuccessAndAnUnknownTaskCanStillBeClosed() {
        try (Harness h = new Harness()) {
            h.submit();
            h.completedStart("start-pending", "pending");
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "pending"))
                .thenReturn(applicationRun("pending", "STARTING", false));
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", "{\"state\":\"COMPLETED\"}"));
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "pending"))
                .thenReturn(applicationRun("pending", "CANCELLED", false));
            h.jdbc.update("UPDATE agent_task SET failure_code='AI_APPLICATION_UNAVAILABLE' WHERE id=?", h.taskId);
            h.service.close(h.taskId, "AI_CLOSED", "close unknown");
            assertThat(h.rowState()).isEqualTo("FAILED");
        }
    }

    @Test
    void closeCannotReleaseWhileApplicationStartOrItsResultSettlementIsStillExecuting() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            org.mockito.Mockito.when(h.runs.startForAgent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenAnswer(call -> {
                    entered.countDown();
                    assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                    return applicationRun(call.getArgument(4), "STARTING", false);
                });
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<?> starting = pool.submit(() -> h.tools.invoke(h.taskId, new ToolRequest("live-start", "application", 7,
                    JSON.createObjectNode().put("action", "start"))));
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                h.service.close(h.taskId, "AI_CLOSED", "close during create");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.callRowState("live-start")).isEqualTo("RUNNING");
                org.mockito.Mockito.verify(h.runs, org.mockito.Mockito.never()).stopForAgent(
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
                release.countDown();
                starting.get(5, TimeUnit.SECONDS);
                var row = h.tasks.findToolCall(h.taskId, "live-start").orElseThrow();
                org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, row.workspaceOperationId()))
                    .thenReturn(applicationRun(row.workspaceOperationId(), "CANCELLED", false));
                h.service.close(h.taskId, "AI_CLOSED", "retry");
                assertThat(h.rowState()).isEqualTo("FAILED");
            } finally { release.countDown(); pool.shutdownNow(); }
        }
    }

    @Test
    void orphanHttpCloseRetiresUnknownWithoutRetransmittingOrStoppingTheUntouchedRun() {
        try (Harness h = new Harness()) {
            h.submit();
            h.tasks.registerToolCall(h.taskId, "http", "a".repeat(64), "app_http_get", "{\"runId\":\"old\",\"path\":\"/\"}", 7, null);
            h.jdbc.update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=? AND tool_call_id='http'", h.taskId);
            h.service.close(h.taskId, "AI_CLOSED", "close after restart");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.callRowState("http")).isEqualTo("NEEDS_ATTENTION");
            org.mockito.Mockito.verifyNoInteractions(h.probe, h.runs);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void unfinishedHttpKeepsOccupancyThroughIoAndDurableSettlement() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            var ready = ProjectApplicationProbeTest.readyRun(PROJECT, "run", "uid");
            org.mockito.Mockito.when(h.runStore.findRunForOwner(OWNER, PROJECT, "run")).thenReturn(java.util.Optional.of(ready));
            org.mockito.Mockito.when(h.runStore.findActiveRun(PROJECT)).thenReturn(java.util.Optional.of(ready));
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            org.mockito.Mockito.when(h.probe.get(ready, "/slow")).thenAnswer(call -> {
                entered.countDown();
                assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                return new AgentContracts.AppHttpGetData("app_http_get", "run", "/slow", 200, "text/plain", "ok", false, null);
            });
            var pool = Executors.newSingleThreadExecutor();
            try {
                var request = new ToolRequest("http", "app_http_get", 7, JSON.createObjectNode().put("runId", "run").put("path", "/slow"));
                var pending = pool.submit(() -> h.tools.invoke(h.taskId, request));
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                // While the network is live, another thread can acquire both short authorities.
                try (var lease = h.gate.tryAcquire(PROJECT).orElseThrow()) { synchronized (h.tasks) { } }
                assertThatThrownBy(() -> h.tools.invoke(h.taskId, request)).isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_CALL_RUNNING"));
                h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", "{\"state\":\"COMPLETED\"}"));
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.tasks.hasLiveToolClaims(h.taskId)).isTrue();
                h.service.close(h.taskId, "AI_CLOSED", "close during HTTP");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.callRowState("http")).isEqualTo("RUNNING");
                release.countDown();
                assertThat(pending.get(5, TimeUnit.SECONDS).data().path("statusCode").asInt()).isEqualTo(200);
                assertThat(h.callRowState("http")).isEqualTo("COMPLETED");
                h.service.close(h.taskId, "AI_CLOSED", "close after HTTP");
                assertThat(h.rowState()).isEqualTo("FAILED");
                h.tasks.requireBrowserWritable(PROJECT);
                org.mockito.Mockito.verify(h.probe, org.mockito.Mockito.times(1)).get(ready, "/slow");
            } finally { release.countDown(); pool.shutdownNow(); }
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
    void conversationIdentityAndNativeHistorySurviveServiceReconstructionAndClose() {
        for (String outcome : List.of("COMPLETED", "FAILED", "CLOSED")) {
            try (Harness h = new Harness()) {
                String conversationId = UUID.randomUUID().toString();
                var transactions = new DataSourceTransactionManager(h.jdbc.getDataSource());
                var conversations = new AgentConversationStore(h.jdbc, transactions, Clock.systemUTC(), h.tasks);
                conversations.create(OWNER, PROJECT, new AgentConversationContracts.CreateConversationRequest(conversationId));
                h.service.submit(OWNER, PROJECT, h.request(), conversationId);
                assertThat(h.worker.starts.get(0).conversationId()).isEqualTo(conversationId);
                var page = conversations.readForTask(h.taskId, INSTANCE, h.rowEpoch(), 0, null);
                var entry = new ObjectMapper().createObjectNode().put("type", "message").put("id", UUID.randomUUID().toString())
                    .put("parentId", h.taskId).put("timestamp", "2026-10-19T00:00:00Z");
                entry.putObject("message").put("role", "assistant").putArray("content")
                    .addObject().put("type", "text").put("text", "真实回答 " + outcome);
                conversations.appendForTask(h.taskId, INSTANCE, h.rowEpoch(),
                    new AgentConversationContracts.ContextAppend(1, page.header(), List.of(entry), null));
                var rebuiltTasks = new AgentTaskStore(h.jdbc, transactions, Clock.systemUTC());
                var rebuilt = new AgentConversationStore(h.jdbc, transactions, Clock.systemUTC(), rebuiltTasks);
                assertThat(rebuilt.history(OWNER, PROJECT, conversationId, null, 50).items())
                    .anySatisfy(item -> assertThat(item.kind()).isEqualTo("user"));
                var rebuiltService = new AgentTaskService(rebuiltTasks, h.gate, h.worker, h.tools);
                if ("CLOSED".equals(outcome)) rebuiltService.close(h.taskId, "AI_CLOSED", "explicitly closed");
                else rebuiltService.applyProgress(h.taskId, INSTANCE, h.rowEpoch(),
                    h.item(1, "terminal", "{\"state\":\"" + outcome + "\",\"summary\":\"settled\",\"failureCode\":null}"));
                assertThat(rebuilt.history(OWNER, PROJECT, conversationId, null, 50).items())
                    .anySatisfy(item -> assertThat(item.kind()).isEqualTo("user"));
                assertThat(rebuilt.history(OWNER, PROJECT, conversationId, null, 50).items())
                    .anySatisfy(item -> assertThat(item.text()).isEqualTo("真实回答 " + outcome));
                assertThat(h.worker.starts).hasSize(1);
            }
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
    void resubmittingTheSameRequestReturnsTheExistingTaskWithoutRedriving() {
        try (Harness h = new Harness()) {
            h.submit();
            assertThat(h.rowEpoch()).isEqualTo(1);
            // The same id, the same request: the ORIGINAL task is the answer. The epoch
            // was persisted exactly once at creation; a re-submission never bumps it,
            // never re-drives the worker and never re-prompts the model.
            h.service.submit(OWNER, PROJECT, h.request());
            assertThat(h.worker.starts).hasSize(1);
            assertThat(h.rowEpoch()).isEqualTo(1);
            // A late ACK of a superseded attempt (a different epoch) cannot bind.
            h.service.onStartAck(h.taskId, 2, new WorkerStatus(h.taskId, "stale-worker", "RUNNING"));
            assertThat(h.rowInstance()).isEqualTo(INSTANCE);
            assertThat(h.rowEpoch()).isEqualTo(1);
        }
    }

    @Test
    void anEnabledStageDoesNotRequireASingleProjectId() {
        assertThatCode(() -> new AiProperties(true, "  ",
            new AiProperties.Worker("http://worker.invalid", "worker-token"),
            new AiProperties.Internal("internal-token"))).doesNotThrowAnyException();
    }

    @Test
    void anotherOwnedReadyProjectCanSubmit() {
        try (Harness h = new Harness()) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                    + " VALUES ('other-project', ?, 'other-project', 'READY', 7, ?, ?)", OWNER, now, now);

            assertThatCode(() -> h.service.submit(OWNER, "other-project", h.request()))
                .doesNotThrowAnyException();
            assertThat(h.tasks.findForOwner(OWNER, "other-project", h.taskId)).isPresent();
            assertThat(h.tasks.findForOwner(OWNER, PROJECT, h.taskId)).isEmpty();
            assertThat(h.jdbc.queryForObject("SELECT project_id FROM agent_task WHERE id = ?", String.class, h.taskId))
                .isEqualTo("other-project");
        }
    }

    @Test
    void removingThePilotRestrictionStillRejectsAForeignOwner() {
        try (Harness h = new Harness()) {
            assertThatThrownBy(() -> h.service.submit("foreign-owner", PROJECT, h.request()))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
            assertThat(h.worker.starts).isEmpty();
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task", Integer.class)).isZero();
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
            // Repair task 2: the late report carries the SAME stable legacy report id with
            // DIFFERENT canonical content, so the receipt entry answers the explicit
            // identity conflict instead of the generic not-active refusal — the settled
            // task stays settled either way.
            assertThatThrownBy(() -> h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(2, "terminal", late)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_MISMATCH"));
            assertThat(h.rowState()).isEqualTo("COMPLETED");
        }
    }

    @Test
    void theInternalQueryContractDistinguishesExecutingFromSettledCalls() {
        try (Harness h = new Harness()) {
            h.submit();
            // Unknown call: the 404 territory of the internal contract.
            assertThat(h.service.toolCallStatus(h.taskId, "call-x", INSTANCE, h.rowEpoch())).isEmpty();
            // A settled call answers COMPLETED with its durable result.
            h.service.invokeTool(h.taskId, "call-1", INSTANCE, h.rowEpoch(),
                new ToolRequest("call-1", "list_files", 7, JSON.createObjectNode()));
            var settled = h.service.toolCallStatus(h.taskId, "call-1", INSTANCE, h.rowEpoch()).orElseThrow();
            assertThat(settled.state()).isEqualTo("COMPLETED");
            assertThat(settled.result().toolCallId()).isEqualTo("call-1");
            // A registered-but-unsettled call reads as RUNNING — never as absent, so a
            // long build can never be misread as an unregistered submission.
            h.insertUnrecordedBuildCall("call-2", "RUNNING");
            var running = h.service.toolCallStatus(h.taskId, "call-2", INSTANCE, h.rowEpoch()).orElseThrow();
            assertThat(running.state()).isEqualTo("RUNNING");
            assertThat(running.result()).isNull();
            // An unknown-outcome call reads as NEEDS_ATTENTION with the same honesty.
            h.tasks.markToolCallNeedsAttention(h.taskId, "call-2");
            var undecided = h.service.toolCallStatus(h.taskId, "call-2", INSTANCE, h.rowEpoch()).orElseThrow();
            assertThat(undecided.state()).isEqualTo("NEEDS_ATTENTION");
            assertThat(undecided.result()).isNull();
        }
    }

    @Test
    void theOwnerBrowserReadsASettledToolResultWithoutInternalIdentity() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            // A settled build the browser can actually read: real exit facts and the
            // cleanup proof, bounded output — the data path the panel renders (I9).
            org.mockito.Mockito.when(h.builds.build(org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    1, "Completed", "BUILD FAILURE tail", false, List.of(), true));
            h.service.invokeTool(h.taskId, "call-build", INSTANCE, h.rowEpoch(),
                new ToolRequest("call-build", "build", 7,
                    JSON.createObjectNode().put("goal", "test")));
            var view = h.service.browserToolCall(OWNER, PROJECT, h.taskId, "call-build");
            assertThat(view.toolCallId()).isEqualTo("call-build");
            assertThat(view.toolName()).isEqualTo("build");
            String json = JSON.writeValueAsString(view);
            // The browser DTO never carries internal execution identity.
            assertThat(json).doesNotContain("jobName", "jobUid", "podUid", "namespace");
            assertThat(view.data().path("exitCode").asInt()).isEqualTo(1);
            assertThat(view.data().path("cleanupConfirmed").asBoolean()).isTrue();
            // A tool call that never settled reads as 404, never as partial data.
            assertThatThrownBy(() -> h.service.browserToolCall(OWNER, PROJECT, h.taskId, "call-build-2"))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
            // A foreign task id reads as 404 (owner/project scoping is the boundary).
            assertThatThrownBy(() -> h.service.browserToolCall(OWNER, PROJECT,
                    UUID.randomUUID().toString(), "call-build"))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }
    }

    @Test
    void anOversizedBuildOutputIsBoundedForTheBrowser() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            String hugeOutput = "m".repeat(300 * 1024);
            org.mockito.Mockito.when(h.builds.build(org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    0, "Completed", hugeOutput, true, List.of(), true));
            h.service.invokeTool(h.taskId, "call-build", INSTANCE, h.rowEpoch(),
                new ToolRequest("call-build", "build", 7,
                    JSON.createObjectNode().put("goal", "compile")));
            var view = h.service.browserToolCall(OWNER, PROJECT, h.taskId, "call-build");
            assertThat(view.data().path("output").asText().getBytes(StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(8 * 1024);
            assertThat(view.data().path("outputTruncated").asBoolean()).isTrue();
            assertThat(view.data().path("exitCode").asInt()).isEqualTo(0);
        }
    }

    @Test
    void aLiveClaimIsNotRetiredBeforeTheBuildRowSettles() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            CountDownLatch bindingReached = new CountDownLatch(1);
            CountDownLatch closeVerified = new CountDownLatch(1);
            // The spy holds the executing thread at the exact post-build, pre-settlement
            // point (the durable identity binding) while a close runs concurrently.
            var tasksSpy = org.mockito.Mockito.spy(h.tasks);
            org.mockito.Mockito.doAnswer(invocation -> {
                bindingReached.countDown();
                if (!closeVerified.await(5, TimeUnit.SECONDS)) {
                    throw new AssertionError("the concurrent close never finished");
                }
                return invocation.callRealMethod();
            }).when(tasksSpy).bindToolCallIdentity(org.mockito.ArgumentMatchers.eq(h.taskId),
                org.mockito.ArgumentMatchers.eq("call-build"),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any());
            org.mockito.Mockito.when(h.builds.build(org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity(null, null, null),
                    0, "Completed", "", false, List.of(), true));
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "BUILD_CLOSED", "", false, List.of(), true));
            var store = new WorkspaceJdbcStore(h.jdbc,
                new DataSourceTransactionManager(h.jdbc.getDataSource()));
            var operations = new WorkspaceOperationService(store, h.agent, h.gate);
            var workspace = new WorkspaceService(store, operations, h.agent, h.gate, tasksSpy);
            var tools = new AgentProjectTools(tasksSpy, store, workspace, operations, h.gate, h.builds);
            var service = new AgentTaskService(tasksSpy, h.gate, h.worker, tools);
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<?> builder = pool.submit(() -> {
                    service.invokeTool(h.taskId, "call-build", INSTANCE, h.rowEpoch(),
                        new ToolRequest("call-build", "build", 7,
                            JSON.createObjectNode().put("goal", "compile")));
                    return null;
                });
                assertThat(bindingReached.await(5, TimeUnit.SECONDS)).isTrue();
                // The thread is past builds.build() but its call row is NOT settled yet:
                // the live claim is still held, so the close must take the active path
                // and keep the project occupied — never misread the build as a restart
                // leftover and never close/settle it concurrently.
                service.close(h.taskId, "AI_CLOSED", "close during settlement");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
                assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
                org.mockito.Mockito.verify(h.builds, org.mockito.Mockito.never())
                    .close(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
                closeVerified.countDown();
                builder.get(5, TimeUnit.SECONDS);
                // The executing thread settled its row (and only then retired its claim).
                assertThat(h.callRowState("call-build")).isEqualTo("COMPLETED");
                service.close(h.taskId, "AI_CLOSED", "retry after settlement");
                assertThat(h.rowState()).isEqualTo("FAILED");
                h.tasks.requireBrowserWritable(PROJECT);
            } finally {
                closeVerified.countDown();
                pool.shutdownNow();
            }
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
            h.tasks.markToolCallNeedsAttention(h.taskId, "call-build");
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(),
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
    void aBoundRunningClaimBlocksReleaseUntilTheExecutingThreadSettles() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            CountDownLatch bound = new CountDownLatch(1);
            CountDownLatch settle = new CountDownLatch(1);
            org.mockito.Mockito.when(h.builds.build(org.mockito.ArgumentMatchers.any())).thenAnswer(invocation -> {
                h.tasks.bindToolCallIdentity(h.taskId, "call-build", "manao-dev-x", "uid-job", "uid-pod");
                bound.countDown();
                assertThat(settle.await(10, TimeUnit.SECONDS)).isTrue();
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    0, "Completed", "", false, List.of(), true);
            });
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "BUILD_CLOSED", "", false, List.of(), true));
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<?> builder = pool.submit(() -> h.service.invokeTool(h.taskId, "call-build", INSTANCE,
                    h.rowEpoch(), new ToolRequest("call-build", "build", 7,
                        JSON.createObjectNode().put("goal", "compile"))));
                assertThat(bound.await(5, TimeUnit.SECONDS)).isTrue();
                h.service.close(h.taskId, "AI_CLOSED", "close while bound execution is paused");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
                settle.countDown();
                builder.get(5, TimeUnit.SECONDS);
                h.service.close(h.taskId, "AI_CLOSED", "retry after settlement");
                assertThat(h.rowState()).isEqualTo("FAILED");
            } finally {
                settle.countDown();
                pool.shutdownNow();
            }
        }
    }

    @Test
    void aClaimNewerThanTheEvidenceSnapshotIsReReadBeforeRelease() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnrecordedBuildCall("call-build", "REGISTERED");
            var snapshotTaken = new CountDownLatch(1);
            var claimDone = new CountDownLatch(1);
            var pool = Executors.newSingleThreadExecutor();
            try {
                var claimant = pool.submit(() -> {
                    assertThat(snapshotTaken.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThat(h.tasks.markToolCallRunning(h.taskId, "call-build")).isTrue();
                    claimDone.countDown();
                    return null;
                });
                var stale = h.tasks.unsettledCalls(h.taskId);
                snapshotTaken.countDown();
                assertThat(claimDone.await(5, TimeUnit.SECONDS)).isTrue();
                claimant.get(5, TimeUnit.SECONDS);
                // Inject only the stale read, not the DB claim or release decision.
                var tasks = org.mockito.Mockito.spy(h.tasks);
                org.mockito.Mockito.doReturn(stale).when(tasks).unsettledCalls(h.taskId);
                var store = new WorkspaceJdbcStore(h.jdbc,
                    new DataSourceTransactionManager(h.jdbc.getDataSource()));
                var operations = new WorkspaceOperationService(store, h.agent, h.gate);
                var workspace = new WorkspaceService(store, operations, h.agent, h.gate, tasks);
                var tools = new AgentProjectTools(tasks, store, workspace, operations, h.gate, h.builds);
                var service = new AgentTaskService(tasks, h.gate, h.worker, tools);
                service.close(h.taskId, "AI_CLOSED", "stale snapshot must not release");
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
                assertThat(h.tasks.markToolCallRunning(h.taskId, "call-build")).isFalse();
            } finally {
                pool.shutdownNow();
            }
        }
    }

    @Test
    void closeKeepsTheTaskOccupiedWhenTheBuildCleanupIsNotConfirmed() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            h.tasks.markToolCallNeedsAttention(h.taskId, "call-build");
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(),
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
            // NEEDS_ATTENTION: the row is not claimed (no in-flight build path), so a
            // successful cluster query proving no Job and no pod was ever created is
            // the missing half of the release condition.
            h.insertUnrecordedBuildCall("call-build", "NEEDS_ATTENTION");
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(false);
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void aTerminalReportOverUnsettledSideEffectsKeepsTheTaskOccupied() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnsettledWriteCall("call-write", "op-unsettled");
            String terminal = JSON.createObjectNode()
                .put("state", "COMPLETED").put("summary", "done").putNull("failureCode")
                .toString();
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", terminal));
            // The verdict is arbitrated by the backend: with an unsettled write side
            // effect the task stays NEEDS_ATTENTION under the pending-terminal marker,
            // the project stays occupied, and the report stays recorded as the durable
            // terminal receipt (repair task 2) — the display envelope keeps its real
            // message head and never carries the terminal.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(h.jdbc.queryForObject("SELECT summary FROM agent_task WHERE id = ?", String.class, h.taskId))
                .isEqualTo("done");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            assertThat(h.progressCount()).isEqualTo(0);
        }
    }

    @Test
    void aCloseResolvesATaskBlockedByATerminalReport() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertUnrecordedBuildCall("call-build", "NEEDS_ATTENTION");
            org.mockito.Mockito.when(h.builds.hasRecordedSideEffect(org.mockito.ArgumentMatchers.any()))
                .thenReturn(false);
            String terminal = JSON.createObjectNode()
                .put("state", "COMPLETED").put("summary", "done").putNull("failureCode")
                .toString();
            h.service.applyProgress(h.taskId, INSTANCE, h.rowEpoch(), h.item(1, "terminal", terminal));
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            // Every side effect later proves settled: the close arms its own marker
            // over the pending-terminal one, finishes the evidence and releases.
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void concurrentCloseCannotDuplicateBuildCleanupOrReleaseItsLiveClaim() throws Exception {
        for (String state : List.of("RUNNING", "NEEDS_ATTENTION", "UNBOUND_RUNNING")) {
            try (Harness h = new Harness()) {
                h.submit();
                if ("UNBOUND_RUNNING".equals(state)) {
                    h.insertUnrecordedBuildCall("call-build", "RUNNING");
                } else {
                    h.insertBoundBuildCall("call-build", "manao-dev-x");
                    if ("NEEDS_ATTENTION".equals(state)) h.tasks.markToolCallNeedsAttention(h.taskId, "call-build");
                }
                CountDownLatch entered = new CountDownLatch(1);
                CountDownLatch release = new CountDownLatch(1);
                java.util.concurrent.atomic.AtomicInteger cleanupCalls = new java.util.concurrent.atomic.AtomicInteger();
                org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenAnswer(call -> {
                        if (cleanupCalls.incrementAndGet() == 1) {
                            entered.countDown();
                            assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                        }
                        return new AgentContracts.BuildResult(
                            new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                            null, "BUILD_CLOSED", "collected tail", false, List.of(), true);
                    });
                ExecutorService pool = Executors.newSingleThreadExecutor();
                try {
                    Future<?> first = pool.submit(() -> h.service.close(h.taskId, "AI_CLOSED", "first close"));
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    h.service.close(h.taskId, "AI_CLOSED", "concurrent close");
                    assertThat(cleanupCalls.get()).as(state).isEqualTo(1);
                    assertThat(h.tasks.isBuildClaimLive(h.taskId, "call-build")).isTrue();
                    assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                    assertThat(h.callRowState("call-build")).isEqualTo("NEEDS_ATTENTION".equals(state)
                        ? "NEEDS_ATTENTION" : "RUNNING");
                    assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT)).isInstanceOf(ApiException.class);
                    release.countDown();
                    first.get(5, TimeUnit.SECONDS);
                    assertThat(h.tasks.hasLiveToolClaims(h.taskId)).isFalse();
                    assertThat(h.rowState()).isEqualTo("FAILED");
                    assertThat(h.callRowState("call-build")).isEqualTo("NEEDS_ATTENTION".equals(state)
                        ? "NEEDS_ATTENTION" : "COMPLETED");
                    h.tasks.requireBrowserWritable(PROJECT);
                } finally { release.countDown(); pool.shutdownNow(); }
            }
        }
    }

    @Test
    void aLeftoverRunningBuildFromARestartIsClosedByIdentityAndReleases() {
        try (Harness h = new Harness()) {
            h.submit();
            // A RUNNING build row with a bound identity whose executing thread is gone
            // (a backend restart): no live claim exists in this process, so the close
            // finishes the durable row by its recorded identity.
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "BUILD_CLOSED", "the collected tail", false, List.of(), true));
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            // The closed evidence is settled on the row, never left RUNNING.
            assertThat(h.callRowState("call-build")).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void aLeftoverRunningBuildWithAnUnconfirmedCleanupKeepsTheTaskOccupied() {
        try (Harness h = new Harness()) {
            h.submit();
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            org.mockito.Mockito.when(h.builds.closeStep(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any()))
                .thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-x", "uid-job", "uid-pod"),
                    null, "BUILD_CLOSED", "", false, List.of(), false));
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void aSettledWorkerStatusLeavesTheTaskUndecidedInsteadOfBindingRunning() {
        try (Harness h = new Harness()) {
            h.worker.unreachable = true;
            h.worker.statusState = "COMPLETED";
            h.service.submit(OWNER, PROJECT, h.request());
            // A legacy state alone is not a terminal report or a reason to close.
            assertThat(h.rowState()).isEqualTo("QUEUED");
            assertThat(h.rowFailureCode()).isNull();
            assertThat(h.closeReasonCode()).isNull();
            assertThat(h.tasks.storedTerminalReport(h.taskId)).isEmpty();
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void lostStartImportsTheFrozenCompletedReportAndPreservesTheReadyApplication() {
        assertLostStartPreservesCompletedApplication(false);
    }

    @Test
    void lostStartSettlesAnAlreadyParkedCompletedReceiptAndPreservesTheReadyApplication() {
        assertLostStartPreservesCompletedApplication(true);
    }

    @Test
    void lostStartRejectsAForeignFrozenReportWithoutInventingAClose() {
        try (Harness h = new Harness()) {
            h.worker.startBehavior = start -> {
                h.worker.frozenStatus = frozenCompletedStatus(start, "foreign-task");
                throw new ApiException("AI_WORKER_UNREACHABLE", 502, "start ACK lost");
            };
            h.submit();
            assertThat(h.rowState()).isEqualTo("QUEUED");
            assertThat(h.rowFailureCode()).isNull();
            assertThat(h.closeReasonCode()).isNull();
            assertThat(h.rowInstance()).isNull();
            assertThat(h.tasks.storedTerminalReport(h.taskId)).isEmpty();
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            assertThat(h.worker.starts).hasSize(1);
            assertThat(h.worker.stops).isEmpty();
        }
    }

    @Test
    void lostStartCannotReverseAnOwnerCloseThatAlreadyWon() {
        try (Harness h = new Harness()) {
            h.worker.startBehavior = start -> {
                h.tasks.requireWorkerIdentity(h.taskId, start.workerEpoch(), INSTANCE);
                h.tasks.beginClose(h.taskId, "AI_OWNER_CLOSED");
                h.worker.frozenStatus = frozenCompletedStatus(start, h.taskId);
                throw new ApiException("AI_WORKER_UNREACHABLE", 502, "start ACK lost");
            };
            h.submit();
            assertThat(h.rowState()).isIn("NEEDS_ATTENTION", "FAILED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_OWNER_CLOSED");
            assertThat(h.worker.starts).hasSize(1);
            assertThat(h.tasks.storedTerminalReport(h.taskId)).isEmpty();
        }
    }

    private static WorkerStatus frozenCompletedStatus(WorkerStart start, String observedTaskId) {
        String reportId = AgentTaskStore.terminalReportId(start.taskId(), start.workerEpoch(), start.requestSha256());
        var report = new AgentContracts.TerminalReport(1, reportId, AgentContracts.TaskState.COMPLETED, "completed before ACK", null);
        return new WorkerStatus(observedTaskId, INSTANCE, "COMPLETED", 1, start.workerEpoch(), start.requestSha256(),
            "COMPLETED", new AgentContracts.WorkerTerminalDelivery("PENDING", reportId,
                AgentTaskStore.terminalContentSha256(reportId, report.state(), report.summary(), null), report));
    }

    private void assertLostStartPreservesCompletedApplication(boolean alreadyParked) {
        try (Harness h = new Harness()) {
            org.mockito.Mockito.when(h.runs.get(OWNER, PROJECT, "ready"))
                .thenReturn(applicationRun("ready", "RUNNING", true));
            org.mockito.Mockito.when(h.runs.active(OWNER, PROJECT))
                .thenReturn(java.util.Optional.of(applicationRun("ready", "RUNNING", true)));
            h.worker.startBehavior = start -> {
                h.tasks.requireWorkerIdentity(h.taskId, start.workerEpoch(), INSTANCE);
                h.completedStart("start-ready", "ready");
                h.worker.frozenStatus = frozenCompletedStatus(start, h.taskId);
                var report = h.worker.frozenStatus.terminalDelivery().report();
                if (alreadyParked) {
                    h.tasks.recordTerminal(h.taskId, start.workerEpoch(), INSTANCE, report.reportId(),
                        "{\"protocolVersion\":1,\"state\":\"COMPLETED\",\"summary\":\"completed before ACK\",\"failureCode\":null}",
                        report.state(), report.summary(), null);
                    assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                }
                throw new ApiException("AI_WORKER_UNREACHABLE", 502, "start ACK lost after acceptance");
            };

            h.submit();
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.rowFailureCode()).isNull();
            assertThat(h.closeReasonCode()).isNull();
            assertThat(h.tasks.storedTerminalReport(h.taskId).orElseThrow().summary()).isEqualTo("completed before ACK");
            assertThat(h.runs.get(OWNER, PROJECT, "ready").state()).isEqualTo("RUNNING");
            assertThat(h.runs.get(OWNER, PROJECT, "ready").firstReadyAt()).isNotNull();
            assertThatCode(() -> h.tasks.requireBrowserWritable(PROJECT)).doesNotThrowAnyException();
            h.submit();
            assertThat(h.worker.starts).hasSize(1);
            assertThat(h.worker.stops).isEmpty();
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_tool_call WHERE task_id=?", Integer.class, h.taskId)).isEqualTo(1);
            assertThat(h.callRowState("start-ready")).isEqualTo("COMPLETED");
            org.mockito.Mockito.verify(h.runs, org.mockito.Mockito.never()).stopForAgent(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
            org.mockito.Mockito.verifyNoInteractions(h.builds);
        }
    }

    @Test
    void aBuildClaimedBeforeCloseCannotCreateAfterTheCloseArms() throws Exception {
        try (Harness h = new Harness()) {
            h.submit();
            java.util.concurrent.CountDownLatch buildEntered = new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.CountDownLatch closeFinished = new java.util.concurrent.CountDownLatch(1);
            // The executor mock stands at the exact "claimed and paused before create"
            // point of the REAL invoke path (gate released, row RUNNING); when it
            // resumes after the close, it answers what the real closing fence answers:
            // an abort with no side effect.
            org.mockito.Mockito.when(h.builds.build(org.mockito.ArgumentMatchers.any()))
                .thenAnswer(invocation -> {
                    buildEntered.countDown();
                    if (!closeFinished.await(5, TimeUnit.SECONDS)) {
                        throw new AssertionError("the close never finished");
                    }
                    return new AgentContracts.BuildResult(new AgentContracts.BuildIdentity(null, null, null),
                        null, "BUILD_CLOSING_ABORTED", "", false, List.of(), true);
                });
            ExecutorService pool = Executors.newSingleThreadExecutor();
            Future<?> builder = pool.submit(() -> {
                h.service.invokeTool(h.taskId, "call-build", INSTANCE, h.rowEpoch(),
                    new ToolRequest("call-build", "build", 7,
                        JSON.createObjectNode().put("goal", "compile")));
                return null;
            });
            assertThat(buildEntered.await(5, TimeUnit.SECONDS)).isTrue();
            // The claim is in flight: the row is RUNNING while nothing exists anywhere.
            assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
            // The close arms its marker, stops the worker, and must NOT release: the
            // negative cluster query is irrelevant while the claim is unsettled.
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            // The paused thread resumes; the closing fence aborts it before any create.
            closeFinished.countDown();
            builder.get(5, TimeUnit.SECONDS);
            // The call settled deterministically without a side effect.
            assertThat(h.callRowState("call-build")).isEqualTo("COMPLETED");
            // The retry close releases: no in-flight claim and no cluster resources.
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
            pool.shutdownNow();
        }
    }

    @Test
    void aFailedEvidenceCloseCanBeRetriedAfterTheEvidenceRecovers() {        try (Harness h = new Harness()) {
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
            Future<Boolean> closer = pool.submit(() -> {
                ready.countDown();
                ready.await(5, TimeUnit.SECONDS);
                try {
                    h.service.close(h.taskId, "AI_CLOSED", "raced close");
                    return false;
                } catch (ApiException expected) {
                    assertThat(expected.code()).isEqualTo("PROJECT_BUSY");
                    return true;
                }
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
            boolean busy = closer.get(10, TimeUnit.SECONDS);
            registrar.get(10, TimeUnit.SECONDS);
            // The close phases use the documented nonblocking gate. Retry the same close
            // once, after its sole contender has exited; no execution identity is replayed.
            if (busy) h.service.close(h.taskId, "AI_CLOSED", "raced close");
            pool.shutdownNow();
            assertThat(h.rowState()).isEqualTo("FAILED");
            org.mockito.Mockito.verifyNoInteractions(h.runs, h.probe, h.builds);
            // At most one of the two effects: a refused registration never registered a row.
            Integer rows = h.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                Integer.class, h.taskId, "call-race");
            assertThat(rows).isLessThanOrEqualTo(1);
        }
    }
}
