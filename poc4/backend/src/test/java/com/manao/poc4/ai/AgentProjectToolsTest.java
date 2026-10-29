package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.ai.AgentContracts.ToolRequest;
import com.manao.poc4.ai.AgentContracts.ToolResult;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceAgentException;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * Real-MySQL behavior of the receipt-backed project file tools, observed only through the tool
 * interface: one durable (taskId, toolCallId) answer per call, one agent mutation per request,
 * receipt-only resume after a lost first response, persisted deterministic rejections that Pi
 * can read and retry from, and NEEDS_ATTENTION (never a fake answer) for ambiguous outcomes.
 * The build executor stays a mock: its dispatch contract, identity binding and the
 * cleanup-confirmed settlement are verified here, the Fabric8 executor itself in
 * {@link DevelopmentBuildExecutorTest}.
 */
class AgentProjectToolsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "ai-owner";
    private static final String PROJECT = "ai-project";
    private static final String PATH = "src/main/java/com/example/app/DemoController.java";

    /** The shared stage: disposable schema, seeded occupied task, mocked agent, one shared gate. */
    private static final class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final JdbcTemplate jdbc = db.jdbc();
        final String taskId = UUID.randomUUID().toString();
        final WorkspaceAgent agent = mock(WorkspaceAgent.class);
        final DevelopmentBuildExecutor builds = mock(DevelopmentBuildExecutor.class);
        final com.manao.poc4.run.RunService runs = mock(com.manao.poc4.run.RunService.class);
        final com.manao.poc4.run.RunStore runStore = mock(com.manao.poc4.run.RunStore.class);
        final com.manao.poc4.log.RunLogService logs = mock(com.manao.poc4.log.RunLogService.class);
        final ProjectApplicationProbe probe = mock(ProjectApplicationProbe.class);
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final WorkspaceJdbcStore store;
        final WorkspaceOperationService operations;
        final WorkspaceService workspace;
        final AgentProjectTools tools;

        Harness() {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, 'ai-owner', 'unused', ?)",
                OWNER, now);
            jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                    + " VALUES (?, ?, 'ai-project', 'READY', 7, ?, ?)", PROJECT, OWNER, now, now);
            tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            tasks.create(OWNER, PROJECT, new TaskRequest(taskId, "repair the failing demo controller", 7));
            store = new WorkspaceJdbcStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            operations = new WorkspaceOperationService(store, agent, gate);
            workspace = new WorkspaceService(store, operations, agent, gate, tasks);
            tools = new AgentProjectTools(tasks, store, workspace, operations, gate, builds,
                new AgentApplicationTools(tasks, runs, runStore, logs, probe, gate));
        }

        /** The agent answers meta for a live file and echoes every mutate exactly like the real agent. */
        void stubLiveFile(String path, String content) {
            when(agent.meta(PROJECT, path)).thenReturn(new WorkspaceAgent.FileMeta(path,
                path.substring(path.lastIndexOf('/') + 1),
                (long) content.getBytes(StandardCharsets.UTF_8).length,
                "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha256Hex(content)));
            stubMutateEcho();
        }

        void stubMutateEcho() {
            when(agent.mutate(eq(PROJECT), any(WorkspaceAgent.Command.class))).thenAnswer(invocation -> {
                WorkspaceAgent.Command command = invocation.getArgument(1);
                return new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
                    command.expectedBeforeSha256(), command.expectedAfterSha256(),
                    WorkspaceOperationService.RECEIPT_PATH_PREFIX + command.operationId() + ".json",
                    command.expectedReceiptSha256());
            });
        }

        ToolRequest writeRequest(String callId, String path, String content, String expectedSha256, long revision) {
            ObjectNode args = JSON.createObjectNode().put("path", path).put("content", content);
            if (expectedSha256 != null) {
                args.put("expectedSha256", expectedSha256);
            }
            return new ToolRequest(callId, "write_file", revision, args);
        }

        ToolRequest readRequest(String callId, String path) {
            return new ToolRequest(callId, "read_file", 7, JSON.createObjectNode().put("path", path));
        }

        ToolRequest listRequest(String callId, String directory) {
            return new ToolRequest(callId, "list_files", 7, JSON.createObjectNode().put("directory", directory));
        }

        String rowState(String callId) {
            return jdbc.queryForObject(
                "SELECT state FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                String.class, taskId, callId);
        }

        long revision() {
            return jdbc.queryForObject("SELECT workspace_revision FROM project WHERE id = ?", Long.class, PROJECT);
        }

        String sha256Hex(String content) {
            return sha256Hex(content.getBytes(StandardCharsets.UTF_8));
        }

        String sha256Hex(byte[] bytes) {
            try {
                StringBuilder builder = new StringBuilder();
                for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) {
                    builder.append(String.format("%02x", b));
                }
                return builder.toString();
            } catch (Exception ex) {
                throw new IllegalStateException(ex);
            }
        }

        String entryDigest(String kind, String path, String contentSha256) {
            String payload = kind + "\n" + path + (contentSha256 == null ? "" : "\n" + contentSha256);
            return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
        }

        @Override public void close() {
            db.close();
        }
    }

    @Test
    void httpCallsSettleOnceAndOrphansNeverReplayTheRequest() {
        try (var h = new Harness()) {
            var ready = ProjectApplicationProbeTest.readyRun(PROJECT, "run", "uid");
            when(h.runStore.findRunForOwner(OWNER, PROJECT, "run")).thenReturn(Optional.of(ready));
            when(h.runStore.findActiveRun(PROJECT)).thenReturn(Optional.of(ready));
            when(h.probe.get(ready, "/demo")).thenReturn(new AgentContracts.AppHttpGetData("app_http_get", "run", "/demo",
                500, "text/plain", "real failure", false, null));
            var request = new ToolRequest("http", "app_http_get", 7, JSON.createObjectNode().put("runId", "run").put("path", "/demo"));
            var first = h.tools.invoke(h.taskId, request);
            assertThat(first.data().path("statusCode").asInt()).isEqualTo(500);
            assertThat(h.tools.invoke(h.taskId, request)).isEqualTo(first);
            verify(h.probe, times(1)).get(ready, "/demo");
            var orphan = new ToolRequest("orphan", "app_http_get", 7, request.args());
            h.tasks.registerToolCall(h.taskId, "orphan", AgentProjectTools.callDigest(h.taskId, orphan),
                "app_http_get", AgentProjectTools.canonicalArgsJson(orphan.args()), 7, null);
            h.jdbc.update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=? AND tool_call_id='orphan'", h.taskId);
            assertThat(h.tools.invoke(h.taskId, orphan).data().path("error").path("code").asText()).isEqualTo("AI_APP_HTTP_UNAVAILABLE");
            verify(h.probe, times(1)).get(ready, "/demo");
            assertThat(h.rowState("orphan")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void browserHttpProjectionDropsInternalFieldsAndUsesFixedErrors() throws Exception {
        try (var h = new Harness()) {
            var args = JSON.createObjectNode().put("runId", "run").put("path", "/");
            h.tasks.registerToolCall(h.taskId, "http", "a".repeat(64), "app_http_get", args.toString(), 7, null);
            var data = JSON.createObjectNode().put("kind", "app_http_get").put("runId", "run").put("path", "/")
                .putNull("statusCode").putNull("contentType").put("body", "").put("truncated", false)
                .put("clusterIP", "10.0.0.1").put("namespace", "private").put("podUid", "secret-uid");
            data.putObject("error").put("code", "http://user:password@internal/").put("message", "private password");
            h.tasks.completeToolCall(h.taskId, "http", JSON.writeValueAsString(new ToolResult("http", "7", data, false)));
            var safe = h.tools.browserToolCall(h.taskId, "http").orElseThrow().data();
            assertThat(safe.size()).isEqualTo(8);
            assertThat(safe.path("error").path("code").asText()).isEqualTo("AI_APP_HTTP_UNAVAILABLE");
            assertThat(safe.toString()).doesNotContain("password", "private", "internal", "secret-uid", "10.0.0.1");
            verifyNoInteractions(h.probe);
        }
    }

    @Test
    void aStopReplayReturnsTheRecordedSnapshotAndNeverChangesItsTarget() {
        try (var h = new Harness()) {
            ToolRequest request = new ToolRequest("stop-original", "application", 7,
                JSON.createObjectNode().put("action", "stop").put("runId", "run-0").put("waitSeconds", 0));
            when(h.runs.get(OWNER, PROJECT, "run-0"))
                .thenThrow(new ApiException("RUN_NOT_FOUND", 404, "http://user:password@internal/secret"));
            ToolResult first = h.tools.invoke(h.taskId, request);
            assertThat(h.tools.invoke(h.taskId, request)).isEqualTo(first);
            assertThat(first.data().path("error").path("code").asText()).isEqualTo("AI_RUN_NOT_FOUND");
            assertThat(h.tools.browserToolCall(h.taskId, "stop-original").orElseThrow().data().toString())
                .doesNotContain("password", "internal", "secret");
            verify(h.runs, times(1)).get(OWNER, PROJECT, "run-0");
        }
    }

    @Test
    void concurrentApplicationStartIsClaimedOnceUntilItsResultIsDurable() throws Exception {
        try (var h = new Harness()) {
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            when(h.runs.startForAgent(any(), any(), any(), any(), any(), any())).thenAnswer(call -> {
                entered.countDown();
                assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                return appRun(call.getArgument(4), "STARTING", false);
            });
            ToolRequest request = new ToolRequest("start-once", "application", 7,
                JSON.createObjectNode().put("action", "start"));
            ExecutorService pool = Executors.newSingleThreadExecutor();
            try {
                Future<ToolResult> winner = pool.submit(() -> h.tools.invoke(h.taskId, request));
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> h.tools.invoke(h.taskId, request))
                    .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_CALL_RUNNING"));
                assertThat(h.tools.getCall(h.taskId, "start-once")).isEmpty();
                release.countDown();
                ToolResult result = winner.get(5, TimeUnit.SECONDS);
                assertThat(h.tools.invoke(h.taskId, request)).isEqualTo(result);
                assertThat(h.tasks.isBuildClaimLive(h.taskId, "start-once")).isFalse();
                verify(h.runs, times(1)).startForAgent(any(), any(), any(), any(), any(), eq("7"));
            } finally {
                release.countDown();
                pool.shutdownNow();
            }
        }
    }

    @Test
    void applicationRejectsIdReuseAndProjectsOnlySafeBrowserFields() throws Exception {
        try (var h = new Harness()) {
            when(h.runs.get(OWNER, PROJECT, "run-0")).thenReturn(appRun("run-0", "RUNNING", true));
            ToolRequest request = new ToolRequest("status-one", "application", 7,
                JSON.createObjectNode().put("action", "status").put("runId", "run-0"));
            h.tools.invoke(h.taskId, request);
            assertThatThrownBy(() -> h.tools.invoke(h.taskId, new ToolRequest("status-one", "application", 7,
                JSON.createObjectNode().put("action", "status").put("runId", "run-other"))))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.status()).isEqualTo(409));
            var row = h.tasks.findToolCall(h.taskId, "status-one").orElseThrow();
            ObjectNode stored = (ObjectNode) JSON.readTree(row.resultJson());
            ((ObjectNode) stored.path("data")).put("namespace", "secret");
            ((ObjectNode) stored.path("data").path("run")).put("policy", "secret");
            h.jdbc.update("UPDATE agent_tool_call SET result_json=? WHERE task_id=? AND tool_call_id=?",
                stored.toString(), h.taskId, "status-one");
            String browser = JSON.writeValueAsString(h.tools.browserToolCall(h.taskId, "status-one").orElseThrow());
            assertThat(browser).contains("run-0").doesNotContain("secret", "policy", "namespace");
            ((ObjectNode) stored.path("data")).putObject("error")
                .put("code", "http://user:password@internal/secret").put("message", "secret");
            h.jdbc.update("UPDATE agent_tool_call SET result_json=? WHERE task_id=? AND tool_call_id=?",
                stored.toString(), h.taskId, "status-one");
            assertThat(h.tools.browserToolCall(h.taskId, "status-one").orElseThrow().data().toString())
                .contains("AI_APPLICATION_UNAVAILABLE").doesNotContain("secret", "password", "internal");
        }
    }

    private static com.manao.poc4.run.RunSummary appRun(String id, String state, boolean ready) {
        return new com.manao.poc4.run.RunSummary(id, state, "7", JSON.createObjectNode().put("env", "secret"),
            "2026-10-16T00:00:00Z", null, null, null, null, false, 0, null,
            ready ? "2026-10-16T00:00:00Z" : null, null);
    }

    @Test
    void stoppingAfterTenSecondsSettlesTheCallAndStatusRemainsAvailableWhileWritesAreBlocked() {
        try (var h = new Harness()) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,version,"
                + "created_at,updated_at,fencing_token) VALUES ('stopping', ?, 7, 'STOPPING', '{}', 0, ?, ?, 1)",
                PROJECT, now, now);
            when(h.runs.get(OWNER, PROJECT, "stopping")).thenReturn(appRun("stopping", "STOPPING", false));
            when(h.runs.stopForAgent(any(), any(), any(), any(), eq("stopping")))
                .thenReturn(appRun("stopping", "STOPPING", false));
            when(h.runs.active(OWNER, PROJECT)).thenReturn(Optional.of(appRun("stopping", "STOPPING", false)));
            long began = System.nanoTime();
            var stopped = h.tools.invoke(h.taskId, new ToolRequest("stop-ten", "application", 7,
                JSON.createObjectNode().put("action", "stop").put("runId", "stopping").put("waitSeconds", 10)));
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - began)).isBetween(9900L, 13000L);
            assertThat(stopped.data().path("stoppedConfirmed").asBoolean()).isFalse();
            assertThat(h.rowState("stop-ten")).isEqualTo("COMPLETED");
            var status = h.tools.invoke(h.taskId, new ToolRequest("status-next", "application", 7,
                JSON.createObjectNode().put("action", "status")));
            assertThat(status.data().path("run").path("state").asText()).isEqualTo("STOPPING");
            assertThat(h.tools.invoke(h.taskId, new ToolRequest("build-blocked", "build", 7,
                JSON.createObjectNode().put("goal", "test"))).data().path("error").path("code").asText())
                .isEqualTo("AI_RUN_ACTIVE");
            assertThat(h.tools.invoke(h.taskId, h.writeRequest("write-blocked", PATH, "x", null, 7))
                .data().path("error").path("code").asText()).isEqualTo("AI_RUN_ACTIVE");
        }
    }

    @Test
    void aRestartedStartObservesTheOriginalRevisionAndDoesNotCreateAgain() {
        try (var h = new Harness()) {
            ToolRequest request = new ToolRequest("restart-start", "application", 7,
                JSON.createObjectNode().put("action", "start"));
            String runId = UUID.randomUUID().toString();
            h.tasks.registerToolCall(h.taskId, request.toolCallId(), AgentProjectTools.callDigest(h.taskId, request),
                request.name(), request.args().toString(), 7, runId);
            h.jdbc.update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=?", h.taskId);
            h.jdbc.update("UPDATE project SET workspace_revision=8 WHERE id=?", PROJECT);
            when(h.runs.get(OWNER, PROJECT, runId)).thenReturn(appRun(runId, "FAILED", false));
            var result = h.tools.invoke(h.taskId, request);
            assertThat(result.data().path("run").path("state").asText()).isEqualTo("FAILED");
            assertThat(result.data().path("run").path("requestedWorkspaceRevision").asText()).isEqualTo("7");
            verify(h.runs, never()).startForAgent(any(), any(), any(), any(), any(), any());
            assertThat(h.tasks.isBuildClaimLive(h.taskId, request.toolCallId())).isFalse();
        }
    }

    @Test
    void activeApplicationBlocksWriteAndBuildWithoutSideEffects() {
        for (String state : List.of("STARTING", "RUNNING", "STOPPING", "RECOVERING")) {
            try (var h = new Harness()) {
                Timestamp now = new Timestamp(System.currentTimeMillis());
                h.jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,version,"
                    + "created_at,updated_at,fencing_token) VALUES (?, ?, 7, ?, '{}', 0, ?, ?, 1)",
                    UUID.randomUUID().toString(), PROJECT, state, now, now);
                when(h.builds.build(any())).thenReturn(new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-live", "job-live", "pod-live"),
                    0, "Completed", "unexpected build", false, List.of(), true));
                ToolResult build = h.tools.invoke(h.taskId, new ToolRequest(
                    "build-with-live-app", "build", 7, JSON.createObjectNode().put("goal", "test")));
                assertThat(build.data().path("error").path("code").asText()).as(state).isEqualTo("AI_RUN_ACTIVE");
                ToolResult write = h.tools.invoke(h.taskId, h.writeRequest("write-with-live-app", PATH, "x", null, 7));
                assertThat(write.data().path("error").path("code").asText()).as(state).isEqualTo("AI_RUN_ACTIVE");
                verifyNoInteractions(h.builds, h.agent);
                assertThat(h.rowState("build-with-live-app")).isEqualTo("COMPLETED");
                assertThat(h.rowState("write-with-live-app")).isEqualTo("COMPLETED");
                assertThat(h.revision()).isEqualTo(7);
            }
        }
    }

    @Test
    void repeatedWriteCallExecutesOnceAndReplaysTheOriginalResult() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            String beforeSha = env.sha256Hex("class DemoController {\n}\n");
            ToolRequest request = new ToolRequest("call-1", "write_file", 7,
                JSON.readTree("{\"path\":\"" + PATH + "\",\"content\":\"new content\",\"expectedSha256\":\"" + beforeSha + "\"}"));
            ToolResult first = env.tools.invoke(env.taskId, request);
            ToolResult repeated = env.tools.invoke(env.taskId, request);
            assertThat(repeated).isEqualTo(first);
            assertThat(first.workspaceRevision()).isEqualTo("8");
            verify(env.agent, times(1)).mutate(eq(PROJECT), any(WorkspaceAgent.Command.class));
            // The original answer stays queryable and the write is durable exactly once.
            assertThat(env.tools.getCall(env.taskId, "call-1")).contains(first);
            assertThat(env.revision()).isEqualTo(8L);
            assertThat(env.rowState("call-1")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void sameCallIdWithDifferentContentIsRefusedAndKeepsTheOriginalAnswer() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            String beforeSha = env.sha256Hex("class DemoController {\n}\n");
            ToolRequest original = new ToolRequest("call-1", "write_file", 7,
                JSON.readTree("{\"path\":\"" + PATH + "\",\"content\":\"new content\",\"expectedSha256\":\"" + beforeSha + "\"}"));
            ToolResult first = env.tools.invoke(env.taskId, original);
            ToolRequest tampered = new ToolRequest("call-1", "write_file", 7,
                JSON.readTree("{\"path\":\"" + PATH + "\",\"content\":\"different content\",\"expectedSha256\":\"" + beforeSha + "\"}"));
            assertThatThrownBy(() -> env.tools.invoke(env.taskId, tampered))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("AI_CALL_MISMATCH");
                    assertThat(ex.status()).isEqualTo(409);
                });
            verify(env.agent, times(1)).mutate(eq(PROJECT), any(WorkspaceAgent.Command.class));
            assertThat(env.tools.getCall(env.taskId, "call-1")).contains(first);
            assertThat(env.revision()).isEqualTo(8L);
        }
    }

    @Test
    void lostFirstResponseResumesFromTheDurableReceiptWithoutMutating() throws Exception {
        try (Harness env = new Harness()) {
            // World state after the first attempt died mid-flight: the mutate already applied
            // agent-side, the operation row is durably PENDING and the call row REGISTERED.
            String content = "new content";
            String beforeSha = env.sha256Hex("class DemoController {\n}\n");
            String beforeDigest = env.entryDigest("file", PATH, beforeSha);
            String afterDigest = env.entryDigest("file", PATH, env.sha256Hex(content));
            String operationId = UUID.randomUUID().toString();
            String receiptJson = "{\"operationId\":\"" + operationId + "\",\"type\":\"SAVE\",\"path\":\"" + PATH
                + "\",\"nextPath\":\"\",\"beforeSha256\":\"" + beforeDigest + "\",\"afterSha256\":\"" + afterDigest + "\"}";
            String receiptSha = env.sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
            env.jdbc.update("""
                INSERT INTO workspace_operation(
                    id, project_id, expected_revision, before_sha256, after_sha256,
                    receipt_path, receipt_sha256, state, created_at)
                VALUES (?, ?, 7, ?, ?, ?, ?, 'PENDING', NOW(6))
                """, operationId, PROJECT, beforeDigest, afterDigest,
                WorkspaceOperationService.RECEIPT_PATH_PREFIX + operationId + ".json", receiptSha);
            ToolRequest request = new ToolRequest("call-resume", "write_file", 7,
                JSON.readTree("{\"path\":\"" + PATH + "\",\"content\":\"" + content + "\",\"expectedSha256\":\"" + beforeSha + "\"}"));
            env.tasks.registerToolCall(env.taskId, "call-resume", AgentProjectTools.callDigest(env.taskId, request),
                "write_file", AgentProjectTools.canonicalArgsJson(request.args()), 7, operationId);
            when(env.agent.receipt(PROJECT, operationId)).thenReturn(Optional.of(new WorkspaceAgent.FetchedReceipt(
                operationId, "SAVE", PATH, "", beforeDigest, afterDigest, receiptSha)));

            ToolResult resumed = env.tools.invoke(env.taskId, request);

            assertThat(resumed.workspaceRevision()).isEqualTo("8");
            verify(env.agent, never()).mutate(any(), any());
            assertThat(env.revision()).isEqualTo(8L);
            assertThat(env.rowState("call-resume")).isEqualTo("COMPLETED");
        }
    }

    @Test void newTaskOnSavedRevisionRejectsOldShaAndCanReadThenSaveCurrentContent() {
        try (Harness h = new Harness()) {
            h.tasks.beginClose(h.taskId, "AI_PAUSED_BY_OWNER");
            h.tasks.failClosedTask(h.taskId, "AI_PAUSED_BY_OWNER", "paused");
            h.jdbc.update("UPDATE project SET workspace_revision=8 WHERE id=?", PROJECT);
            String next = UUID.randomUUID().toString();
            h.tasks.create(OWNER, PROJECT, new TaskRequest(next, "continue after user edit", 8));
            h.stubLiveFile(PATH, "user saved B");
            when(h.agent.content(PROJECT, PATH)).thenReturn(new WorkspaceAgent.Content(PATH, "user saved B", h.sha256Hex("user saved B")));
            var rejected = h.tools.invoke(next, h.writeRequest("stale", PATH, "C", h.sha256Hex("old A"), 8));
            assertThat(rejected.data().path("error").path("code").asText()).isEqualTo("FILE_SHA_CONFLICT");
            var read = h.tools.invoke(next, new ToolRequest("reread", "read_file", 8, JSON.createObjectNode().put("path", PATH)));
            assertThat(read.data().path("content").asText()).isEqualTo("user saved B");
            var saved = h.tools.invoke(next, h.writeRequest("fresh", PATH, "C", read.data().path("sha256").asText(), 8));
            assertThat(saved.workspaceRevision()).isEqualTo("9");
            assertThat(h.revision()).isEqualTo(9);
        }
    }

    @Test
    void staleExpectedShaIsAPersistedRejectionThatLetsPiReread() {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            ToolRequest request = env.writeRequest("call-sha", PATH, "new content",
                env.sha256Hex("OUTDATED"), 7);

            ToolResult result = env.tools.invoke(env.taskId, request);

            assertThat(result.workspaceRevision()).isEqualTo("7");
            assertThat(result.data().path("error").path("code").asText()).isEqualTo("FILE_SHA_CONFLICT");
            verify(env.agent, never()).mutate(any(), any());
            assertThat(env.revision()).isEqualTo(7L);
            assertThat(env.rowState("call-sha")).isEqualTo("COMPLETED");
            assertThat(env.tools.getCall(env.taskId, "call-sha")).contains(result);
        }
    }

    @Test
    void newFileWriteUsesTheAbsentDigestAndSavesThroughTheAgent() {
        try (Harness env = new Harness()) {
            String newPath = "src/main/java/com/example/app/NewHandler.java";
            when(env.agent.meta(PROJECT, newPath)).thenReturn(null);
            env.stubMutateEcho();

            ToolResult result = env.tools.invoke(env.taskId,
                env.writeRequest("call-new", newPath, "class NewHandler {}", null, 7));

            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertThat(result.data().path("sha256").asText()).isEqualTo(env.sha256Hex("class NewHandler {}"));
            ArgumentCaptor<WorkspaceAgent.Command> command = ArgumentCaptor.forClass(WorkspaceAgent.Command.class);
            verify(env.agent).mutate(eq(PROJECT), command.capture());
            assertThat(command.getValue().type()).isEqualTo("SAVE");
            assertThat(command.getValue().expectedBeforeSha256()).isEqualTo(env.entryDigest("absent", newPath, null));
            assertThat(command.getValue().content()).isEqualTo("class NewHandler {}".getBytes(StandardCharsets.UTF_8));
            assertThat(env.revision()).isEqualTo(8L);
        }
    }

    @Test
    void agentSaveCreatesMissingFilesThroughTheAgent404Path() {
        try (Harness env = new Harness()) {
            // The real adapter reports a missing file as a definite agent 404 (ENTRY_NOT_FOUND
            // WorkspaceAgentException), never as a null meta: the AI save entry must convert
            // exactly that response into the absent digest or first-time creation can never work.
            String newPath = "src/main/java/com/example/app/Created.java";
            when(env.agent.meta(PROJECT, newPath))
                .thenThrow(new WorkspaceAgentException(404, "ENTRY_NOT_FOUND", "entry does not exist"));
            env.stubMutateEcho();

            ToolResult result = env.tools.invoke(env.taskId,
                env.writeRequest("call-create-404", newPath, "class Created {}", null, 7));

            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertThat(result.data().path("sha256").asText()).isEqualTo(env.sha256Hex("class Created {}"));
            ArgumentCaptor<WorkspaceAgent.Command> command = ArgumentCaptor.forClass(WorkspaceAgent.Command.class);
            verify(env.agent).mutate(eq(PROJECT), command.capture());
            assertThat(command.getValue().expectedBeforeSha256()).isEqualTo(env.entryDigest("absent", newPath, null));
            assertThat(env.revision()).isEqualTo(8L);
        }
    }

    @Test
    void staleExpectedRevisionIsAPersistedRejectionWithoutAgentWrite() {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");

            ToolResult result = env.tools.invoke(env.taskId,
                env.writeRequest("call-stale", PATH, "new content", env.sha256Hex("class DemoController {\n}\n"), 6));

            assertThat(result.workspaceRevision()).isEqualTo("7");
            assertThat(result.data().path("error").path("code").asText()).isEqualTo("WORKSPACE_REVISION_CONFLICT");
            verify(env.agent, never()).mutate(any(), any());
            assertThat(env.revision()).isEqualTo(7L);
            assertThat(env.rowState("call-stale")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void forbiddenAndInvalidPathsArePersistedRejections() {
        try (Harness env = new Harness()) {
            List<String> forbidden = List.of(".git/config", "src/target/classes/App.class",
                "src/.manao/cache/x", ".env", "id_rsa", "src/server.pem");
            for (int i = 0; i < forbidden.size(); i++) {
                ToolResult result = env.tools.invoke(env.taskId,
                    env.writeRequest("call-forbidden-" + i, forbidden.get(i), "x", null, 7));
                assertThat(result.data().path("error").path("code").asText())
                    .as(forbidden.get(i)).isEqualTo("PATH_FORBIDDEN");
            }
            List<String> invalid = List.of("/etc/passwd", "a/../b", "src//App.java", ".manao/receipts/x.json");
            for (int i = 0; i < invalid.size(); i++) {
                ToolResult result = env.tools.invoke(env.taskId,
                    env.writeRequest("call-invalid-" + i, invalid.get(i), "x", null, 7));
                assertThat(result.data().path("error").path("code").asText())
                    .as(invalid.get(i)).isEqualTo("INVALID_PATH");
            }
            verify(env.agent, never()).mutate(any(), any());
            verify(env.agent, never()).meta(any(), any());
            assertThat(env.revision()).isEqualTo(7L);
        }
    }

    @Test
    void contentBeyondThe128KiBLimitIsRejectedForWriteAndRead() {
        try (Harness env = new Harness()) {
            String oversized = "a".repeat(128 * 1024 + 1);
            ToolResult written = env.tools.invoke(env.taskId,
                env.writeRequest("call-big-write", PATH, oversized, null, 7));
            assertThat(written.data().path("error").path("code").asText()).isEqualTo("FILE_TOO_LARGE");
            verify(env.agent, never()).mutate(any(), any());

            when(env.agent.meta(PROJECT, "src/main/App.java")).thenReturn(new WorkspaceAgent.FileMeta(
                "src/main/App.java", "App.java", 128 * 1024 + 1L, "text/plain", "UTF-8", "java",
                "MONACO_TEXT", null, env.sha256Hex("x")));
            ToolResult read = env.tools.invoke(env.taskId, env.readRequest("call-big-read", "src/main/App.java"));
            assertThat(read.data().path("error").path("code").asText()).isEqualTo("FILE_TOO_LARGE");
            verify(env.agent, never()).content(any(), any());
        }
    }

    @Test
    void readResultBeyondThe192KiBEnvelopeIsRejected() {
        try (Harness env = new Harness()) {
            // 128 KiB of newlines fits the content limit but its JSON-escaped result cannot fit
            // the 192 KiB result envelope: rejected, never silently truncated.
            String newlines = "\n".repeat(128 * 1024);
            String sha = env.sha256Hex(newlines);
            when(env.agent.meta(PROJECT, "src/main/Long.java")).thenReturn(new WorkspaceAgent.FileMeta(
                "src/main/Long.java", "Long.java", (long) newlines.length(), "text/plain", "UTF-8", "java",
                "MONACO_TEXT", null, sha));
            when(env.agent.content(PROJECT, "src/main/Long.java"))
                .thenReturn(new WorkspaceAgent.Content("src/main/Long.java", newlines, sha));

            ToolResult result = env.tools.invoke(env.taskId, env.readRequest("call-envelope", "src/main/Long.java"));

            assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_RESULT_TOO_LARGE");
            assertThat(env.rowState("call-envelope")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void readResultEnvelopeIsMeasuredInUtf8BytesNotChars() {
        try (Harness env = new Harness()) {
            // 86 072 escaped newlines + 15 000 CJK chars: the raw file is exactly 128 KiB and the
            // result stays under 192 KiB in UTF-16 chars, yet its UTF-8 JSON exceeds the
            // envelope — the bound is bytes, so this compliant-looking file is still rejected.
            String content = "\n".repeat(86072) + "中".repeat(15000);
            String sha = env.sha256Hex(content);
            when(env.agent.meta(PROJECT, "src/main/Mixed.java")).thenReturn(new WorkspaceAgent.FileMeta(
                "src/main/Mixed.java", "Mixed.java", (long) content.getBytes(StandardCharsets.UTF_8).length,
                "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha));
            when(env.agent.content(PROJECT, "src/main/Mixed.java"))
                .thenReturn(new WorkspaceAgent.Content("src/main/Mixed.java", content, sha));

            ToolResult result = env.tools.invoke(env.taskId, env.readRequest("call-utf8", "src/main/Mixed.java"));

            assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_RESULT_TOO_LARGE");
            assertThat(env.rowState("call-utf8")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void writeResultBeyondTheEnvelopeIsRejectedBeforeAnySideEffect() {
        try (Harness env = new Harness()) {
            // A multi-byte path blows up the deterministic write result (path + sha256): the
            // answer stays under 192 KiB in UTF-16 chars but exceeds it in UTF-8 bytes. The
            // byte gate runs before the mutate, so this is a persisted, side-effect-free
            // rejection — never an applied write whose result cannot be stored.
            String path = "src/" + "中".repeat(66000) + ".java";
            ToolResult result = env.tools.invoke(env.taskId,
                env.writeRequest("call-utf8-write", path, "class Boundary {}", null, 7));

            assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_RESULT_TOO_LARGE");
            verify(env.agent, never()).mutate(any(), any());
            verify(env.agent, never()).meta(any(), any());
            assertThat(env.revision()).isEqualTo(7L);
            assertThat(env.rowState("call-utf8-write")).isEqualTo("COMPLETED");
            assertThat(env.tools.getCall(env.taskId, "call-utf8-write")).contains(result);
        }
    }

    @Test
    void writeProbeAtTheExactBoundaryJudgesThePostWriteRevisionLength() throws Exception {
        try (Harness env = new Harness()) {
            // Revision "9" → "10" grows the success answer by one byte. The path size is measured
            // against the real serializer so the CURRENT-revision probe JSON is exactly 192 KiB
            // (an old pre-check would pass it) while the post-write JSON is one byte over: the
            // gate must judge the post-write length and reject before the mutate, never swap an
            // applied write for an error.
            env.jdbc.update("UPDATE project SET workspace_revision = 9 WHERE id = ?", PROJECT);
            String content = "class Boundary {}";
            String sha = env.sha256Hex(content);
            int overByOne = AgentProjectTools.MAX_RESULT_BYTES + 1 - probeBytes(content, sha, 0, 0, "10");
            int multibyte = overByOne / 3;
            int singleByte = overByOne % 3;
            assertThat(probeBytes(content, sha, multibyte, singleByte, "10"))
                .isEqualTo(AgentProjectTools.MAX_RESULT_BYTES + 1);
            assertThat(probeBytes(content, sha, multibyte, singleByte, "9"))
                .isEqualTo(AgentProjectTools.MAX_RESULT_BYTES);
            String path = "src/" + "中".repeat(multibyte) + "x".repeat(singleByte) + ".java";

            ToolResult result = env.tools.invoke(env.taskId,
                env.writeRequest("call-boundary", path, content, null, 9));

            assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_RESULT_TOO_LARGE");
            verify(env.agent, never()).mutate(any(), any());
            verify(env.agent, never()).meta(any(), any());
            assertThat(env.revision()).isEqualTo(9L);
            assertThat(env.rowState("call-boundary")).isEqualTo("COMPLETED");
        }
    }

    /**
     * The probe the production write pre-check serializes, reconstructed byte-exactly against
     * the same compact mapper: each added 中 contributes three UTF-8 bytes, each x one.
     */
    private static int probeBytes(String content, String sha, int multibyte, int singleByte,
                                  String revision) throws Exception {
        ObjectNode data = JSON.createObjectNode()
            .put("path", "src/" + "中".repeat(multibyte) + "x".repeat(singleByte) + ".java")
            .put("sha256", sha);
        return JSON.writeValueAsString(new AgentContracts.ToolResult("call-boundary", revision, data, false))
            .getBytes(StandardCharsets.UTF_8).length;
    }

    @Test
    void listFilesCapsAt200EntriesAndRefusesForbiddenDirectories() {
        try (Harness env = new Harness()) {
            List<WorkspaceAgent.TreeEntry> entries = new ArrayList<>();
            for (int i = 0; i < 205; i++) {
                entries.add(new WorkspaceAgent.TreeEntry("src/F" + i + ".java", "F" + i + ".java", "file", false, 10L, null));
            }
            when(env.agent.tree(PROJECT, "src")).thenReturn(new WorkspaceAgent.Tree("src", entries));

            ToolResult listed = env.tools.invoke(env.taskId, env.listRequest("call-list", "src"));

            assertThat(listed.data().path("entries").size()).isEqualTo(200);
            assertThat(listed.data().path("hasMore").asBoolean()).isTrue();
            assertThat(listed.truncated()).isTrue();

            ToolResult forbidden = env.tools.invoke(env.taskId, env.listRequest("call-list-git", ".git"));
            assertThat(forbidden.data().path("error").path("code").asText()).isEqualTo("PATH_FORBIDDEN");
        }
    }

    @Test
    void listFilesFiltersForbiddenEntriesBeforeCapsApply() {
        try (Harness env = new Harness()) {
            List<WorkspaceAgent.TreeEntry> entries = new ArrayList<>();
            for (int i = 0; i < 205; i++) {
                entries.add(new WorkspaceAgent.TreeEntry("src/F" + i + ".java", "F" + i + ".java", "file", false, 10L, null));
            }
            entries.add(new WorkspaceAgent.TreeEntry("src/target/classes/A.class", "A.class", "file", false, 10L, null));
            entries.add(new WorkspaceAgent.TreeEntry("src/.manao/cache/x", "x", "file", true, 10L, null));
            entries.add(new WorkspaceAgent.TreeEntry("src/server.pem", "server.pem", "file", false, 10L, null));
            when(env.agent.tree(PROJECT, "src")).thenReturn(new WorkspaceAgent.Tree("src", entries));

            ToolResult listed = env.tools.invoke(env.taskId, env.listRequest("call-filter", "src"));

            // Filtering runs BEFORE the 200 cap: the forbidden entries are invisible and the
            // remaining allowed entries fill the page.
            assertThat(listed.data().path("entries").size()).isEqualTo(200);
            assertThat(listed.data().path("hasMore").asBoolean()).isTrue();
            for (JsonNode entry : listed.data().path("entries")) {
                assertThat(entry.path("path").asText())
                    .doesNotContain("target").doesNotContain(".manao").doesNotContain(".pem");
            }

            // Forbidden entries do not count toward hasMore: a small directory with noise in it
            // reads as fully browsable.
            when(env.agent.tree(PROJECT, "")).thenReturn(new WorkspaceAgent.Tree("", List.of(
                new WorkspaceAgent.TreeEntry("notes.md", "notes.md", "file", false, 10L, null),
                new WorkspaceAgent.TreeEntry("target", "target", "directory", false, null, true),
                new WorkspaceAgent.TreeEntry(".env", ".env", "file", false, 10L, null))));
            ToolResult small = env.tools.invoke(env.taskId, env.listRequest("call-filter-small", ""));
            assertThat(small.data().path("entries").size()).isEqualTo(1);
            assertThat(small.data().path("entries").get(0).path("path").asText()).isEqualTo("notes.md");
            assertThat(small.data().path("hasMore").asBoolean()).isFalse();
        }
    }

    @Test
    void binaryAndMissingReadsArePersistedRejections() {
        try (Harness env = new Harness()) {
            when(env.agent.meta(PROJECT, "src/logo.png")).thenReturn(new WorkspaceAgent.FileMeta(
                "src/logo.png", "logo.png", 100L, "image/png", "binary", null, "IMAGE", null, env.sha256Hex("png")));
            when(env.agent.content(PROJECT, "src/logo.png")).thenThrow(
                new WorkspaceAgentException(422, "BINARY_FILE", "binary content is not served as text"));
            ToolResult binary = env.tools.invoke(env.taskId, env.readRequest("call-binary", "src/logo.png"));
            assertThat(binary.data().path("error").path("code").asText()).isEqualTo("BINARY_FILE");

            when(env.agent.meta(PROJECT, "src/Gone.java")).thenReturn(null);
            ToolResult missing = env.tools.invoke(env.taskId, env.readRequest("call-missing", "src/Gone.java"));
            assertThat(missing.data().path("error").path("code").asText()).isEqualTo("ENTRY_NOT_FOUND");

            assertThat(env.rowState("call-binary")).isEqualTo("COMPLETED");
            assertThat(env.rowState("call-missing")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void ambiguousTransportFailureMarksTheCallNeedsAttentionAndLocksFurtherWrites() {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            when(env.agent.mutate(eq(PROJECT), any(WorkspaceAgent.Command.class)))
                .thenThrow(new WorkspaceAgentException(503, "IO_ERROR", "connection reset"));

            assertThatThrownBy(() -> env.tools.invoke(env.taskId,
                    env.writeRequest("call-lost", PATH, "changed", env.sha256Hex("class DemoController {\n}\n"), 7)))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED"));

            // The outcome is unknown: the call stays NEEDS_ATTENTION, the project fails closed
            // and no further write may register while the scene is unresolved.
            assertThat(env.rowState("call-lost")).isEqualTo("NEEDS_ATTENTION");
            assertThat(env.store.findProject(PROJECT).state()).isEqualTo("FAILED");
            assertThat(env.store.findProject(PROJECT).failureReason()).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED");
            assertThat(env.tools.getCall(env.taskId, "call-lost")).isEmpty();
            assertThatThrownBy(() -> env.tools.invoke(env.taskId,
                    env.writeRequest("call-next", PATH, "again", null, 7)))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_CALL_UNSETTLED"));
            assertThat(env.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ?", Long.class, env.taskId)).isEqualTo(1L);
        }
    }

    @Test
    void buildRunsThroughTheExecutorSettlesAndKeepsTheRevisionUntouched() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            when(env.builds.build(any())).thenAnswer(invocation -> {
                // The row is marked RUNNING before the executor ever touches the cluster, so a
                // later replay can only recover the recorded identity, never re-execute.
                assertThat(env.rowState("call-build")).isEqualTo("RUNNING");
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity("manao-dev-1", "job-uid-1", "pod-uid-1"),
                    0, "Completed", "build output", false,
                    List.of(new AgentContracts.TestReport("com.example.app.AppTest", 1, 0, 0, 0, "abc")), true);
            });

            ToolResult result = env.tools.invoke(env.taskId, new ToolRequest("call-build", "build", 7,
                JSON.createObjectNode().put("goal", "test")));

            assertThat(result.data().path("goal").asText()).isEqualTo("test");
            assertThat(result.data().path("exitCode").asInt()).isEqualTo(0);
            assertThat(result.data().path("sourceRevision").asText()).isEqualTo("7");
            assertThat(result.data().path("terminationReason").asText()).isEqualTo("Completed");
            assertThat(result.data().path("output").asText()).isEqualTo("build output");
            assertThat(result.data().path("cleanupConfirmed").asBoolean()).isTrue();
            assertThat(result.data().path("testReports").get(0).path("testClass").asText())
                .isEqualTo("com.example.app.AppTest");
            assertThat(env.rowState("call-build")).isEqualTo("COMPLETED");
            // The verified build identity is bound backend-side only.
            assertThat(env.jdbc.queryForObject(
                "SELECT CONCAT(job_name, '|', job_uid, '|', pod_uid) FROM agent_tool_call "
                    + "WHERE task_id = ? AND tool_call_id = ?",
                String.class, env.taskId, "call-build")).isEqualTo("manao-dev-1|job-uid-1|pod-uid-1");
            // A build reads the saved sources: the revision is untouched and writing resumes.
            assertThat(env.revision()).isEqualTo(7L);
            ArgumentCaptor<AgentContracts.BuildRequest> dispatched =
                ArgumentCaptor.forClass(AgentContracts.BuildRequest.class);
            verify(env.builds).build(dispatched.capture());
            String commandId = env.jdbc.queryForObject(
                "SELECT workspace_operation_id FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                String.class, env.taskId, "call-build");
            assertThat(dispatched.getValue().taskId()).isEqualTo(env.taskId);
            assertThat(dispatched.getValue().projectId()).isEqualTo(PROJECT);
            assertThat(dispatched.getValue().goal()).isEqualTo(AgentContracts.BuildGoal.TEST);
            assertThat(dispatched.getValue().sourceRevision()).isEqualTo(7L);
            assertThat(dispatched.getValue().commandId()).isEqualTo(commandId).isNotBlank();
            ToolResult written = env.tools.invoke(env.taskId,
                env.writeRequest("call-after", PATH, "new", env.sha256Hex("class DemoController {\n}\n"), 7));
            assertThat(written.workspaceRevision()).isEqualTo("8");
        }
    }

    @Test
    void invalidGoalArgumentsArePersistedRejectionsWithoutAnyBuild() {
        try (Harness env = new Harness()) {
            List<String> goals = List.of("test;rm -rf", "deploy", "TEST", "");
            for (int i = 0; i < goals.size(); i++) {
                ToolResult result = env.tools.invoke(env.taskId, new ToolRequest("call-goal-" + i, "build", 7,
                    JSON.createObjectNode().put("goal", goals.get(i))));
                assertThat(result.data().path("error").path("code").asText())
                    .as(goals.get(i)).isEqualTo("VALIDATION_ERROR");
            }
            ToolResult missing = env.tools.invoke(env.taskId, new ToolRequest("call-goal-missing", "build", 7,
                JSON.createObjectNode()));
            assertThat(missing.data().path("error").path("code").asText()).isEqualTo("VALIDATION_ERROR");
            verifyNoInteractions(env.builds);
            assertThat(env.revision()).isEqualTo(7L);
            assertThat(env.rowState("call-goal-0")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void aBuildExecutorFailureStaysNeedsAttentionAndLocksFurtherWrites() {
        try (Harness env = new Harness()) {
            when(env.builds.build(any())).thenThrow(new IllegalStateException("forbidden"));

            assertThatThrownBy(() -> env.tools.invoke(env.taskId, new ToolRequest("call-build", "build", 7,
                    JSON.createObjectNode().put("goal", "test"))))
                .isInstanceOf(IllegalStateException.class);

            assertThat(env.rowState("call-build")).isEqualTo("NEEDS_ATTENTION");
            assertThatThrownBy(() -> env.tools.invoke(env.taskId,
                    env.writeRequest("call-next", PATH, "x", null, 7)))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_CALL_UNSETTLED"));
            assertThat(env.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ?", Long.class, env.taskId))
                .isEqualTo(1L);
        }
    }

    @Test
    void anUnconfirmedBuildCleanupStaysNeedsAttentionWithItsEvidence() {
        try (Harness env = new Harness()) {
            when(env.builds.build(any())).thenReturn(new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity("manao-dev-1", "job-uid-1", null),
                null, "BUILD_IDENTITY_UNVERIFIABLE", "", false, List.of(), false));

            assertThatThrownBy(() -> env.tools.invoke(env.taskId, new ToolRequest("call-build", "build", 7,
                    JSON.createObjectNode().put("goal", "test"))))
                .isInstanceOf(IllegalStateException.class);

            assertThat(env.rowState("call-build")).isEqualTo("NEEDS_ATTENTION");
            assertThat(env.jdbc.queryForObject(
                "SELECT job_name FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                String.class, env.taskId, "call-build")).isEqualTo("manao-dev-1");
        }
    }

    @Test
    void aRecoveryWithARecordedIdentityObservesThatBuildAndNeverRebuildsIt() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            ToolRequest request = new ToolRequest("call-build", "build", 7,
                JSON.createObjectNode().put("goal", "test"));
            // A crash-recovery scene: the call already started and its verified identity is
            // durable on the row before the replay arrives.
            env.tasks.registerToolCall(env.taskId, "call-build",
                AgentProjectTools.callDigest(env.taskId, request), "build",
                AgentProjectTools.canonicalArgsJson(request.args()), 7, "command-recorded");
            env.jdbc.update(
                "UPDATE agent_tool_call SET state = 'RUNNING', job_name = 'manao-dev-recorded', "
                    + "job_uid = 'job-uid-recorded', pod_uid = 'pod-uid-recorded' "
                    + "WHERE task_id = ? AND tool_call_id = ?", env.taskId, "call-build");
            when(env.builds.observe(any(), any())).thenReturn(new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity("manao-dev-recorded", "job-uid-recorded", "pod-uid-recorded"),
                0, "Completed", "recovered output", false, List.of(), true));

            ToolResult result = env.tools.invoke(env.taskId, request);

            assertThat(result.data().path("output").asText()).isEqualTo("recovered output");
            verify(env.builds).observe(any(),
                eq(new AgentContracts.BuildIdentity("manao-dev-recorded", "job-uid-recorded", "pod-uid-recorded")));
            verify(env.builds, never()).build(any());
            assertThat(env.rowState("call-build")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void aRecoveryOverVanishedEvidenceStaysNeedsAttentionWithoutAnyRebuild() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            ToolRequest request = new ToolRequest("call-build", "build", 7,
                JSON.createObjectNode().put("goal", "test"));
            env.tasks.registerToolCall(env.taskId, "call-build",
                AgentProjectTools.callDigest(env.taskId, request), "build",
                AgentProjectTools.canonicalArgsJson(request.args()), 7, "command-recorded");
            env.jdbc.update(
                "UPDATE agent_tool_call SET state = 'RUNNING', job_name = 'manao-dev-recorded', "
                    + "job_uid = 'job-uid-recorded' WHERE task_id = ? AND tool_call_id = ?",
                env.taskId, "call-build");
            when(env.builds.observe(any(), any())).thenReturn(new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity("manao-dev-recorded", "job-uid-recorded", null),
                null, "BUILD_EVIDENCE_UNAVAILABLE", "", false, List.of(), false));

            assertThatThrownBy(() -> env.tools.invoke(env.taskId, request))
                .isInstanceOf(IllegalStateException.class);

            // The unknowable build is never executed a second time: the call fails closed.
            verify(env.builds, never()).build(any());
            assertThat(env.rowState("call-build")).isEqualTo("NEEDS_ATTENTION");
        }
    }

    @Test
    void aLoserOfTheFirstExecutionClaimFollowsTheRecoveryPathInsteadOfBuilding() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            ToolRequest request = new ToolRequest("call-build", "build", 7,
                JSON.createObjectNode().put("goal", "test"));
            // A fresh REGISTERED row whose first execution was atomically claimed by another
            // request between this one's gate snapshot and its own claim: the loser's
            // REGISTERED->RUNNING update matches no row.
            env.tasks.registerToolCall(env.taskId, "call-build",
                AgentProjectTools.callDigest(env.taskId, request), "build",
                AgentProjectTools.canonicalArgsJson(request.args()), 7, "command-claimed");
            AgentTaskStore spyingTasks = spy(env.tasks);
            doReturn(false).when(spyingTasks).markToolCallRunning(any(), any());
            AgentProjectTools loserTools = new AgentProjectTools(spyingTasks, env.store, env.workspace,
                env.operations, env.gate, env.builds);
            when(env.builds.observe(any(), any())).thenReturn(new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity("manao-dev-claimed", "job-uid-claimed", null),
                null, "BUILD_EVIDENCE_UNAVAILABLE", "", false, List.of(), false));

            assertThatThrownBy(() -> loserTools.invoke(env.taskId, request))
                .isInstanceOf(IllegalStateException.class);

            // The claim loser never starts a build: it re-reads the durable state and
            // recovers along the observation path only.
            verify(spyingTasks).markToolCallRunning(env.taskId, "call-build");
            verify(env.builds).observe(any(), eq(new AgentContracts.BuildIdentity(null, null, null)));
            verify(env.builds, never()).build(any());
            assertThat(env.rowState("call-build")).isEqualTo("NEEDS_ATTENTION");
        }
    }

    @Test
    void concurrentInvocationsOfOneBuildCallStartTheBuildExactlyOnce() throws Exception {
        try (Harness env = new Harness()) {
            env.stubLiveFile(PATH, "class DemoController {\n}\n");
            AgentContracts.BuildIdentity identity =
                new AgentContracts.BuildIdentity("manao-dev-1", "job-uid-1", "pod-uid-1");
            CountDownLatch winnerBuilding = new CountDownLatch(1);
            CountDownLatch loserRecovered = new CountDownLatch(1);
            AtomicInteger builds = new AtomicInteger();
            AtomicInteger observations = new AtomicInteger();
            when(env.builds.build(any())).thenAnswer(invocation -> {
                builds.incrementAndGet();
                winnerBuilding.countDown();
                // Hold the winning build open until the concurrent replay has taken its
                // recovery path, mirroring a real cluster wait.
                loserRecovered.await(10, TimeUnit.SECONDS);
                return new AgentContracts.BuildResult(identity, 0, "Completed", "winner", false, List.of(), true);
            });
            when(env.builds.observe(any(), any())).thenAnswer(invocation -> {
                observations.incrementAndGet();
                loserRecovered.countDown();
                return new AgentContracts.BuildResult(identity, 0, "Completed", "recovered", false, List.of(), true);
            });

            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<ToolResult> winner = pool.submit(() -> env.tools.invoke(env.taskId,
                    new ToolRequest("call-build", "build", 7, JSON.createObjectNode().put("goal", "test"))));
                assertThat(winnerBuilding.await(10, TimeUnit.SECONDS)).isTrue();
                Future<ToolResult> loser = pool.submit(() -> env.tools.invoke(env.taskId,
                    new ToolRequest("call-build", "build", 7, JSON.createObjectNode().put("goal", "test"))));

                assertThat(winner.get(30, TimeUnit.SECONDS).data().path("output").asText()).isEqualTo("winner");
                assertThat(loser.get(30, TimeUnit.SECONDS).data().path("output").asText()).isEqualTo("recovered");
            } finally {
                pool.shutdownNow();
            }
            // Exactly one build execution for the one call id; the concurrent replay recovered.
            assertThat(builds.get()).isEqualTo(1);
            assertThat(observations.get()).isEqualTo(1);
            assertThat(env.rowState("call-build")).isEqualTo("COMPLETED");
        }
    }

    @Test
    void settledTasksRefuseFurtherCalls() {
        try (Harness env = new Harness()) {
            env.jdbc.update("UPDATE agent_task SET state = 'COMPLETED' WHERE id = ?", env.taskId);
            assertThatThrownBy(() -> env.tools.invoke(env.taskId,
                    env.writeRequest("call-after", PATH, "x", null, 7)))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
        }
    }

    @Test
    void unknownToolNamesAreRefusedBeforeAnythingIsRegistered() {
        try (Harness env = new Harness()) {
            assertThatThrownBy(() -> env.tools.invoke(env.taskId,
                    new ToolRequest("call-unknown", "rm_rf", 7, JSON.createObjectNode())))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
            assertThat(env.jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ?", Long.class, env.taskId)).isZero();
        }
    }
}
