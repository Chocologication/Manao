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
                new AiProperties(true, PROJECT, new AiProperties.Worker("http://worker.invalid", "worker-token"),
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
    void anEnabledStageWithoutAProjectIdFailsClosedAtConfiguration() {
        assertThatThrownBy(() -> new AiProperties(true, "  ",
            new AiProperties.Worker("http://worker.invalid", "worker-token"),
            new AiProperties.Internal("internal-token")))
            .isInstanceOf(IllegalArgumentException.class);
        // A disabled stage may omit the project id (the AI beans never exist then).
        new AiProperties(false, "", null, null);
    }

    @Test
    void aSubmissionToANonEnabledProjectIsRefused() {
        try (Harness h = new Harness()) {
            assertThatThrownBy(() -> h.service.submit(OWNER, "other-project", h.request()))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_PROJECT_NOT_ENABLED"));
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
            org.mockito.Mockito.when(h.builds.close(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
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
                var service = new AgentTaskService(tasks, h.gate, h.worker, tools,
                    new AiProperties(true, PROJECT, null, null));
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
            // the project stays occupied, and the report stays recorded as the
            // to-be-verified terminal event in the progress envelope.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(h.jdbc.queryForObject("SELECT summary FROM agent_task WHERE id = ?", String.class, h.taskId))
                .isEqualTo("done");
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            assertThat(h.progressCount()).isEqualTo(1);
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
    void aLeftoverRunningBuildFromARestartIsClosedByIdentityAndReleases() {
        try (Harness h = new Harness()) {
            h.submit();
            // A RUNNING build row with a bound identity whose executing thread is gone
            // (a backend restart): no live claim exists in this process, so the close
            // finishes the durable row by its recorded identity.
            h.insertBoundBuildCall("call-build", "manao-dev-x");
            org.mockito.Mockito.when(h.builds.close(org.mockito.ArgumentMatchers.any(),
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
            org.mockito.Mockito.when(h.builds.close(org.mockito.ArgumentMatchers.any(),
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
