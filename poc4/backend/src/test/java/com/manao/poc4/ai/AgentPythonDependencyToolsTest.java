package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.*;
import com.manao.poc4.workspace.*;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class AgentPythonDependencyToolsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "dependency-owner";
    private static final String PROJECT = "dependency-project";
    private static final class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final String taskId = UUID.randomUUID().toString();
        final WorkspaceAgent agent = mock(WorkspaceAgent.class);
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final WorkspaceJdbcStore store;
        final AgentProjectTools tools;
        final AtomicInteger prepares = new AtomicInteger();
        final AtomicInteger commits = new AtomicInteger();
        volatile WorkspaceAgent.PythonDependencyCommit lastCommit;
        volatile CountDownLatch prepareEntered;
        volatile CountDownLatch prepareRelease;
        volatile CountDownLatch commitEntered;
        volatile CountDownLatch commitRelease;
        volatile boolean loseCommit;
        volatile boolean missingReceipt;
        volatile boolean wrongReceipt;
        final PythonDependencyService dependencies;
        Harness() { this("python-console"); }
        Harness(String template) {
            var jdbc = db.jdbc();
            var transactions = new DataSourceTransactionManager(jdbc.getDataSource());
            var now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,'unused',?)", OWNER, OWNER, now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,?,'dependency','READY',7,?,?)", PROJECT, OWNER, now, now);
            tasks = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
            store = new WorkspaceJdbcStore(jdbc, transactions);
            var runtime = mock(ProjectRuntimeStore.class);
            when(runtime.loadSpec(PROJECT)).thenReturn(new ProjectRuntimeSpec(template, false, false, List.of()));
            tasks.createTask(OWNER, PROJECT, new AgentContracts.TaskRequest(taskId, "add dependencies", 7), null,
                () -> new AgentProjectEnvironmentService(runtime, AgentProjectEnvironmentTest.policy()).forProject(PROJECT));
            var operations = new WorkspaceOperationService(store, agent, gate);
            dependencies = new PythonDependencyService(store, operations, agent, gate, runtime, tasks);
            tools = new AgentProjectTools(tasks, store, new WorkspaceService(store, operations, agent, gate, tasks), operations, gate,
                mock(DevelopmentBuildExecutor.class), null, null,
                new AgentPythonDependencyTools(tasks, dependencies));
            when(agent.prepare(eq(PROJECT), anyString(), anyString(), any(WorkspaceAgent.DependencyChange.class))).thenAnswer(invocation -> {
                prepares.incrementAndGet();
                pause(prepareEntered, prepareRelease);
                return new WorkspaceAgent.PreparedPythonDependencies(invocation.getArgument(1), invocation.getArgument(2), "a".repeat(64), "b".repeat(64));
            });
            when(agent.commit(eq(PROJECT), any(WorkspaceAgent.PythonDependencyCommit.class))).thenAnswer(invocation -> {
                commits.incrementAndGet();
                lastCommit = invocation.getArgument(1);
                pause(commitEntered, commitRelease);
                if (loseCommit) throw new WorkspaceAgentException(503, "IO_ERROR", "lost");
                return lastCommit.prepared();
            });
            when(agent.receipt(eq(PROJECT), any())).thenAnswer(invocation -> missingReceipt ? Optional.empty() : Optional.of(new WorkspaceAgent.FetchedReceipt(lastCommit.prepared().operationId(), "PYTHON_DEPENDENCIES", "pyproject.toml", "uv.lock", wrongReceipt ? "c".repeat(64) : lastCommit.prepared().beforeSha256(), lastCommit.prepared().afterSha256(), lastCommit.receiptSha256())));
        }
        static void pause(CountDownLatch entered, CountDownLatch release) throws InterruptedException {
            if (entered == null) return;
            entered.countDown();
            if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("fixture timed out");
        }
        AgentContracts.ToolRequest request(String callId) {
            return new AgentContracts.ToolRequest(callId, "python_dependencies", 7, JSON.createObjectNode().put("action", "ADD").put("packageName", "pytest").put("group", "test"));
        }
        @Override public void close() { db.close(); }
    }
    @Test void completedReplayPreservesOneRevisionAndBothChangedPaths() {
        try (var harness = new Harness()) {
            var request = harness.request("dependency-call");
            var result = harness.tools.invoke(harness.taskId, request);
            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertThat(result.data().path("changedPaths")).isEqualTo(JSON.valueToTree(List.of("pyproject.toml", "uv.lock")));
            assertThat(harness.tools.invoke(harness.taskId, request)).isEqualTo(result);
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.commits).hasValue(1);
            assertThat(harness.tasks.findForOwner(OWNER, PROJECT, harness.taskId).orElseThrow().changedPaths()).containsExactly("pyproject.toml", "uv.lock");
        }
    }

    @Test void closeDuringPreparePreventsPendingAndDoesNotHoldGateOrStoreMonitor() throws Exception {
        try (var harness = new Harness()) {
            harness.prepareEntered = new CountDownLatch(1);
            harness.prepareRelease = new CountDownLatch(1);
            var executor = Executors.newSingleThreadExecutor();
            try {
                var invocation = executor.submit(() -> harness.tools.invoke(harness.taskId, harness.request("prepare-close")));
                assertThat(harness.prepareEntered.await(5, TimeUnit.SECONDS)).isTrue();
                try (var lease = harness.gate.tryAcquire(PROJECT).orElseThrow()) { harness.tasks.beginClose(harness.taskId); }
                assertThat(harness.tools.finishForClose(harness.taskId)).isFalse();
                harness.prepareRelease.countDown();
                assertThat(invocation.get(5, TimeUnit.SECONDS).data().path("error").path("code").asText()).isEqualTo("AI_TASK_NOT_ACTIVE");
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
                assertThat(harness.commits).hasValue(0);
                assertThat(harness.tools.finishForClose(harness.taskId)).isTrue();
            } finally { harness.prepareRelease.countDown(); executor.shutdownNow(); }
        }
    }

    @Test void closeAfterPendingWaitsForLiveCommitThenRecordsReceipt() throws Exception {
        try (var harness = new Harness()) {
            harness.commitEntered = new CountDownLatch(1);
            harness.commitRelease = new CountDownLatch(1);
            var executor = Executors.newSingleThreadExecutor();
            try {
                var invocation = executor.submit(() -> harness.tools.invoke(harness.taskId, harness.request("commit-close")));
                assertThat(harness.commitEntered.await(5, TimeUnit.SECONDS)).isTrue();
                harness.tasks.beginClose(harness.taskId);
                assertThat(harness.tasks.hasPendingReceipts(harness.taskId)).isTrue();
                assertThat(harness.tools.finishForClose(harness.taskId)).isFalse();
                harness.commitRelease.countDown();
                assertThat(invocation.get(5, TimeUnit.SECONDS).workspaceRevision()).isEqualTo("8");
                assertThat(harness.tools.finishForClose(harness.taskId)).isTrue();
                assertThat(harness.tasks.hasPendingReceipts(harness.taskId)).isFalse();
            } finally { harness.commitRelease.countDown(); executor.shutdownNow(); }
        }
    }

    @Test void lostResponseRecoversSameJournalWithoutPreparingTwice() {
        try (var harness = new Harness()) {
            harness.loseCommit = true;
            assertThatThrownBy(() -> harness.tools.invoke(harness.taskId, harness.request("lost-call"))).isInstanceOf(com.manao.poc4.api.ApiException.class);
            harness.tasks.beginClose(harness.taskId);
            harness.loseCommit = false;
            assertThat(harness.tools.finishForClose(harness.taskId)).isTrue();
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.store.findProject(PROJECT).workspaceRevision()).isEqualTo(8);
            assertThat(harness.tools.getCall(harness.taskId, "lost-call").orElseThrow().workspaceRevision()).isEqualTo("8");
            assertThat(harness.tasks.findForOwner(OWNER, PROJECT, harness.taskId).orElseThrow().changedPaths()).containsExactly("pyproject.toml", "uv.lock");
        }
    }

    @Test void missingAndMismatchedReceiptsKeepTaskOccupied() {
        try (var harness = new Harness()) {
            harness.missingReceipt = true;
            assertThatThrownBy(() -> harness.tools.invoke(harness.taskId, harness.request("missing"))).isInstanceOf(com.manao.poc4.api.ApiException.class);
            harness.tasks.beginClose(harness.taskId);
            assertThat(harness.tools.finishForClose(harness.taskId)).isFalse();
            harness.missingReceipt = false;
            harness.wrongReceipt = true;
            assertThat(harness.tools.finishForClose(harness.taskId)).isFalse();
            assertThat(harness.tasks.hasPendingReceipts(harness.taskId)).isTrue();
            assertThat(harness.store.findProject(PROJECT).workspaceRevision()).isEqualTo(7);
        }
    }

    @Test void javaTaskRefusesDependencyTool() {
        try (var harness = new Harness("java-console")) {
            assertThat(harness.tools.invoke(harness.taskId, harness.request("java-call")).data().path("error").path("code").asText()).isEqualTo("PYTHON_DEPENDENCY_UNSUPPORTED");
            assertThat(harness.prepares).hasValue(0);
        }
    }

    @Test void restartWithoutPendingRetiresOriginalCallWithoutPreparing() {
        try (var harness = new Harness()) {
            var request = harness.request("restart-call");
            harness.tasks.registerToolCall(harness.taskId, request.toolCallId(), AgentProjectTools.callDigest(harness.taskId, request), request.name(), AgentProjectTools.canonicalArgsJson(request.args()), 7, UUID.randomUUID().toString());
            harness.tasks.beginClose(harness.taskId);
            assertThat(harness.tools.finishForClose(harness.taskId)).isTrue();
            assertThat(harness.prepares).hasValue(0);
            assertThat(harness.commits).hasValue(0);
        }
    }
}
