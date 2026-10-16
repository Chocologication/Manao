package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.run.RunService;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.run.RunSummary;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

class AgentApplicationToolsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AgentTaskStore tasks = mock(AgentTaskStore.class);
    private final RunService runs = mock(RunService.class);
    private final RunStore store = mock(RunStore.class);
    private final List<RunLogWindow.Chunk> chunks = new ArrayList<>();
    private final RunLogService logs = new RunLogService(new RunLogService.ChunkStore() {
        public void insertChunk(String id, RunLogWindow.Chunk chunk) { chunks.add(chunk); }
        public List<RunLogWindow.Chunk> loadChunks(String id) { return List.copyOf(chunks); }
        public void deleteBefore(String id, long seq) { chunks.removeIf(c -> c.seq() < seq); }
        public OptionalLong lastSeq(String id) {
            return chunks.isEmpty() ? OptionalLong.empty() : OptionalLong.of(chunks.get(chunks.size() - 1).seq());
        }
    });
    private final AgentApplicationTools application = new AgentApplicationTools(tasks, runs, store, logs);

    AgentApplicationToolsTest() {
        when(tasks.taskOwner("task")).thenReturn(new AgentTaskStore.TaskOwner("owner", "project"));
        when(runs.get("owner", "project", "run")).thenReturn(run("CANCELLED"));
        when(store.findRunForOwner("owner", "project", "run")).thenReturn(Optional.of(
            new com.manao.poc4.run.RunRecord("run", "project", 7, com.manao.poc4.persistence.RunState.CANCELLED,
                "{}", "job", "pod", null, Instant.now(), 0, "USER_STOPPED", 1, Instant.now(), 1,
                null, null, "execution-uid", "USER_STOPPED")));
    }

    @Test
    void logsReadThePersistedTailAtUtf8BoundariesWithCoveredSequences() {
        logs.publish("run", 1, "old\n");
        logs.publish("run", 2, "汉".repeat(21845));
        var data = invoke("{\"action\":\"logs\",\"runId\":\"run\"}").data().path("logs");
        assertThat(data.path("text").asText().getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(65536);
        assertThat(data.path("text").asText()).doesNotContain("�").endsWith("汉");
        assertThat(data.path("truncated").asBoolean()).isTrue();
        assertThat(data.path("firstSeq").asLong()).isEqualTo(1);
        assertThat(data.path("lastSeq").asLong()).isEqualTo(2);
        assertThat(data.path("complete").asBoolean()).isTrue();
    }

    @Test
    void terminalLogsWithoutVerifiedExecutionOrWithAHistoryGapNeverClaimComplete() {
        logs.publish("run", 1, "some output\n");
        when(store.findRunForOwner("owner", "project", "run")).thenReturn(Optional.empty());
        assertThat(invoke("{\"action\":\"logs\",\"runId\":\"run\"}").data().path("logs").path("complete").asBoolean())
            .isFalse();
        logs.publish("run", 2, "[manao] log source lost: terminal history failed\n");
        assertThat(invoke("{\"action\":\"logs\",\"runId\":\"run\"}").data().path("logs").path("complete").asBoolean())
            .isFalse();
    }

    @Test
    void emptyAndGappedTerminalWindowsDoNotClaimComplete() {
        assertThat(invoke("{\"action\":\"logs\",\"runId\":\"run\"}").data().path("logs").path("complete").asBoolean()).isFalse();
        logs.forgetRun("run");
        chunks.add(new RunLogWindow.Chunk(1, "a", 1, Instant.now()));
        chunks.add(new RunLogWindow.Chunk(3, "c", 1, Instant.now()));
        var data = invoke("{\"action\":\"logs\",\"runId\":\"run\"}").data().path("logs");
        assertThat(data.path("complete").asBoolean()).isFalse();
        assertThat(data.path("truncated").asBoolean()).isTrue();
    }

    @Test
    void escapingIsIncludedInTheJsonLimitWithoutLosingTheApplicationShape() throws Exception {
        logs.publish("run", 1, "\u0000".repeat(65536));
        var result = invoke("{\"action\":\"logs\",\"runId\":\"run\"}");
        assertThat(JSON.writeValueAsBytes(result).length).isLessThanOrEqualTo(192 * 1024);
        assertThat(result.data().path("kind").asText()).isEqualTo("application");
        assertThat(result.truncated()).isTrue();
        assertThat(result.data().path("logs").path("truncated").asBoolean()).isTrue();
    }

    @Test
    void stopBudgetExpiresAsAnHonestSnapshotAndNeverClaimsAnExit() {
        when(runs.get("owner", "project", "run")).thenReturn(run("STOPPING"));
        when(runs.stopForAgent(any(), any(), any(), any(), any())).thenReturn(run("STOPPING"));
        when(runs.active("owner", "project")).thenReturn(Optional.of(run("STOPPING")));
        var result = invoke("{\"action\":\"stop\",\"runId\":\"run\",\"waitSeconds\":0}");
        assertThat(result.data().path("run").path("state").asText()).isEqualTo("STOPPING");
        assertThat(result.data().path("stoppedConfirmed").asBoolean()).isFalse();
    }

    @Test
    void statusCanReadWithoutAnActiveRunAndValidatesActionSpecificArguments() {
        assertThat(invoke("{\"action\":\"status\"}").data().path("run").isNull()).isTrue();
        for (String args : List.of("{}", "{\"action\":\"shell\"}",
            "{\"action\":\"start\",\"runId\":\"run\"}", "{\"action\":\"stop\"}",
            "{\"action\":\"logs\",\"runId\":\"run\",\"waitSeconds\":1}",
            "{\"action\":\"status\",\"waitSeconds\":1.5}", "{\"action\":\"status\",\"waitSeconds\":11}",
            "{\"action\":\"status\",\"ownerId\":\"other\"}")) {
            assertThatThrownBy(() -> invoke(args)).isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        }
    }

    @Test
    void aStopIntentCannotBeAcceptedAsCompletedWhileItsRunIsStillReady() {
        when(tasks.applicationCalls("task")).thenReturn(List.of(new AgentTaskStore.ToolCallRow("task", "stop", "sha",
            "application", "{\"action\":\"stop\",\"runId\":\"run\"}", "COMPLETED", "operation", 7,
            null, null, null, null)));
        RunSummary ready = new RunSummary("run", "RUNNING", "7", JSON.createObjectNode(), "2026-10-16T00:00:00Z",
            null, null, null, null, false, 0, null, "2026-10-16T00:00:00Z", null);
        when(runs.get("owner", "project", "run")).thenReturn(ready);
        when(runs.active("owner", "project")).thenReturn(Optional.of(ready));
        assertThat(application.canRelease("task", true)).isFalse();
    }

    @Test
    void anUnconfirmedStopKeepsCleanupUnfinishedAfterItsBudget() {
        when(tasks.applicationCalls("task")).thenReturn(List.of(new AgentTaskStore.ToolCallRow("task", "stop", "sha",
            "application", "{\"action\":\"stop\",\"runId\":\"run\"}", "COMPLETED", "operation", 7,
            null, null, null, null)));
        when(tasks.claimApplicationCleanup("task", "stop")).thenReturn(true);
        when(runs.get("owner", "project", "run")).thenReturn(run("STOPPING"));
        AgentApplicationTools bounded = new AgentApplicationTools(tasks, runs, store, logs, java.time.Duration.ofMillis(5));
        assertThat(bounded.finish("task")).isFalse();
        verify(tasks).releaseBuildClaim("task", "stop");
        verify(tasks, never()).retireApplicationCall("task", "stop");
    }

    @Test
    void aForeignRunIsRefusedBeforeReadingLogsOrStopping() {
        when(runs.get("owner", "project", "run"))
            .thenThrow(new ApiException("RUN_NOT_FOUND", 404, "secret http://user:password@internal"));
        assertThatThrownBy(() -> invoke("{\"action\":\"stop\",\"runId\":\"run\",\"waitSeconds\":0}"))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.code()).isEqualTo("AI_RUN_NOT_FOUND");
                assertThat(ex.getMessage()).doesNotContain("secret", "password", "internal");
            });
        verify(runs, never()).stopForAgent(any(), any(), any(), any(), any());
    }

    @Test
    void restartedRunningControlOnlyObservesItsOriginalIdentity() throws Exception {
        var request = new AgentContracts.ToolRequest("call", "application", 7, JSON.readTree("{\"action\":\"start\"}"));
        var row = new AgentTaskStore.ToolCallRow("task", "call", "sha", "application", request.args().toString(),
            "RUNNING", "run", 7, null, null, null, null);
        application.invoke("task", row, request);
        verify(runs, never()).startForAgent(any(), any(), any(), any(), any(), any());
        verify(runs).get("owner", "project", "run");
    }

    private AgentContracts.ToolResult invoke(String args) {
        try {
            var request = new AgentContracts.ToolRequest("call", "application", 7, JSON.readTree(args));
            var row = new AgentTaskStore.ToolCallRow("task", "call", "sha", "application", args,
                "REGISTERED", "run", 7, null, null, null, null);
            return application.invoke("task", row, request);
        } catch (java.io.IOException ex) { throw new AssertionError(ex); }
    }

    private static RunSummary run(String state) {
        return new RunSummary("run", state, "7", JSON.createObjectNode(), "2026-10-16T00:00:00Z",
            null, "CANCELLED".equals(state) ? "2026-10-16T00:01:00Z" : null,
            null, null, false, 0, null, null, null);
    }
}
