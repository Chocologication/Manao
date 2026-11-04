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
        final ProjectRuntimeStore runtime = mock(ProjectRuntimeStore.class);
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
        volatile CountDownLatch registrationEntered;
        volatile CountDownLatch registrationRelease;
        volatile boolean filesCommitted;
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
            tasks = spy(new AgentTaskStore(jdbc, transactions, Clock.systemUTC()));
            store = new WorkspaceJdbcStore(jdbc, transactions);
            when(runtime.loadSpec(PROJECT)).thenReturn(new ProjectRuntimeSpec(template, false, false, List.of()));
            tasks.createTask(OWNER, PROJECT, new AgentContracts.TaskRequest(taskId, "add dependencies", 7), null,
                () -> new AgentProjectEnvironmentService(runtime, AgentProjectEnvironmentTest.policy()).forProject(PROJECT));
            var operations = new WorkspaceOperationService(store, agent, gate);
            dependencies = new PythonDependencyService(store, operations, agent, gate, runtime, tasks);
            tools = new AgentProjectTools(tasks, store, new WorkspaceService(store, operations, agent, gate, tasks), operations, gate,
                mock(DevelopmentBuildExecutor.class), null, null,
                new AgentPythonDependencyTools(tasks, dependencies));
            doAnswer(invocation -> {
                pause(registrationEntered, registrationRelease);
                return invocation.callRealMethod();
            }).when(tasks).registerAgentDependencyPending(anyString(), anyString(), any(), any());
            when(agent.prepare(eq(PROJECT), anyString(), anyString(), any(WorkspaceAgent.DependencyChange.class))).thenAnswer(invocation -> {
                prepares.incrementAndGet();
                pause(prepareEntered, prepareRelease);
                return new WorkspaceAgent.PreparedPythonDependencies(invocation.getArgument(1), invocation.getArgument(2), "a".repeat(64), "b".repeat(64));
            });
            when(agent.commit(eq(PROJECT), any(WorkspaceAgent.PythonDependencyCommit.class))).thenAnswer(invocation -> {
                commits.incrementAndGet();
                lastCommit = invocation.getArgument(1);
                filesCommitted = true;
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
            return new AgentContracts.ToolRequest(callId, "python_dependencies", 7, JSON.createObjectNode().put("action", "add").put("packageName", "pytest").put("group", "test"));
        }
        AgentTaskStore restartedStore() {
            return new AgentTaskStore(db.jdbc(), new DataSourceTransactionManager(db.jdbc().getDataSource()), Clock.systemUTC());
        }
        AgentProjectTools toolsFor(AgentTaskStore restarted) {
            var operations = new WorkspaceOperationService(store, agent, gate);
            var dependencies = new PythonDependencyService(store, operations, agent, gate, runtime, restarted);
            return new AgentProjectTools(restarted, store, new WorkspaceService(store, operations, agent, gate, restarted), operations, gate,
                mock(DevelopmentBuildExecutor.class), null, null, new AgentPythonDependencyTools(restarted, dependencies));
        }
        @Override public void close() { db.close(); }
    }
    @Test void completedReplayPreservesOneRevisionAndBothChangedPaths() {
        try (var harness = new Harness()) {
            var request = harness.request("dependency-call");
            var result = harness.tools.invoke(harness.taskId, request);
            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertDependencyIdentity(result, "add");
            assertThat(result.data().path("changedPaths")).isEqualTo(JSON.valueToTree(List.of("pyproject.toml", "uv.lock")));
            assertThat(harness.tools.invoke(harness.taskId, request)).isEqualTo(result);
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.commits).hasValue(1);
            assertThat(harness.tasks.findForOwner(OWNER, PROJECT, harness.taskId).orElseThrow().changedPaths()).containsExactly("pyproject.toml", "uv.lock");
        }
    }

    private static void assertDependencyIdentity(AgentContracts.ToolResult result, String action) {
        assertThat(result.data().path("kind").asText()).isEqualTo("python_dependencies");
        assertThat(result.data().path("operationId").asText()).isNotBlank();
        assertThat(result.data().path("action").asText()).isEqualTo(action);
        assertThat(result.data().path("packageName").asText()).isEqualTo("pytest");
        assertThat(result.data().path("group").asText()).isEqualTo("test");
        assertThat(result.data().path("state").asText()).isEqualTo("COMMITTED");
        assertThat(result.data().path("changedPaths")).isEqualTo(JSON.valueToTree(List.of("pyproject.toml", "uv.lock")));
    }

    @Test void lowercaseRemoveUsesLegacyWireActionAndCompleteIdentity() {
        try (var harness = new Harness()) {
            var args = JSON.createObjectNode().put("action", "remove").put("packageName", "pytest").put("group", "test");
            var result = harness.tools.invoke(harness.taskId, new AgentContracts.ToolRequest("remove-call", "python_dependencies", 7, args));
            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertDependencyIdentity(result, "remove");
            verify(harness.agent).prepare(eq(PROJECT), anyString(), anyString(), eq(new WorkspaceAgent.DependencyChange("REMOVE", "pytest", null, "test")));
        }
    }

    @Test void agentRejectsUppercaseInvalidActionAndRemoveVersionBeforePrepare() {
        try (var harness = new Harness()) {
            int index = 0;
            for (String action : List.of("ADD", "REMOVE", "install", "remove")) {
                var args = JSON.createObjectNode().put("action", action).put("packageName", "pytest").put("group", "test");
                if ("remove".equals(action)) args.put("version", "8.0.0");
                var result = harness.tools.invoke(harness.taskId, new AgentContracts.ToolRequest("invalid-" + index++, "python_dependencies", 7, args));
                assertThat(result.data().path("error").path("code").asText()).isEqualTo("VALIDATION_ERROR");
            }
            assertThat(harness.prepares).hasValue(0);
            assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
        }
    }

    private static AgentTaskStore.ToolCallRow register(Harness harness, String callId) {
        var request = harness.request(callId);
        return harness.tasks.registerToolCall(harness.taskId, callId, AgentProjectTools.callDigest(harness.taskId, request),
            request.name(), AgentProjectTools.canonicalArgsJson(request.args()), 7, UUID.randomUUID().toString());
    }

    @Test void directServiceRejectsUnclaimedRegisteredAndRestartedRunningBeforePrepare() {
        try (var harness = new Harness()) {
            register(harness, "unclaimed");
            assertNotActive(() -> harness.dependencies.changeForAgent(harness.taskId, "unclaimed"));
            harness.db.jdbc().update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=? AND tool_call_id='unclaimed'", harness.taskId);
            assertNotActive(() -> harness.dependencies.changeForAgent(harness.taskId, "unclaimed"));
            assertNotActive(() -> harness.dependencies.reconcileForAgent(harness.taskId, "unclaimed"));
            assertThat(harness.prepares).hasValue(0);
            assertThat(harness.commits).hasValue(0);
            assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
        }
    }

    @Test void observationClaimCannotAuthorizeFreshPrepare() {
        try (var harness = new Harness()) {
            register(harness, "observe");
            harness.db.jdbc().update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=?", harness.taskId);
            assertThat(harness.tasks.claimDependencyObservation(harness.taskId, "observe")).isTrue();
            try {
                assertNotActive(() -> harness.dependencies.changeForAgent(harness.taskId, "observe"));
                assertThat(harness.dependencies.reconcileForAgent(harness.taskId, "observe").state()).isEqualTo("UNCONFIRMED");
                assertThat(harness.prepares).hasValue(0);
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
            } finally { harness.tasks.releaseBuildClaim(harness.taskId, "observe"); }
        }
    }

    @Test void dependencyAuthorizationRejectsWrongTaskProjectOperationAndOwner() {
        try (var harness = new Harness()) {
            var call = register(harness, "identity");
            assertThat(harness.tasks.markToolCallRunning(harness.taskId, "identity")).isTrue();
            try {
                assertNotActive(() -> harness.dependencies.changeForAgent(UUID.randomUUID().toString(), "identity"));
                assertNotActive(() -> harness.tasks.requireAgentDependencyCall(harness.taskId, "other-project", "identity", call.workspaceOperationId()));
                assertNotActive(() -> harness.tasks.requireAgentDependencyCall(harness.taskId, PROJECT, "identity", UUID.randomUUID().toString()));
                var now = new Timestamp(System.currentTimeMillis());
                harness.db.jdbc().update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('other-owner','other-owner','unused',?)", now);
                harness.db.jdbc().update("UPDATE agent_task SET owner_id='other-owner' WHERE id=?", harness.taskId);
                assertNotActive(() -> harness.dependencies.changeForAgent(harness.taskId, "identity"));
                assertThat(harness.prepares).hasValue(0);
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
            } finally { harness.tasks.releaseBuildClaim(harness.taskId, "identity"); }
        }
    }

    private static void assertNotActive(org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOf(com.manao.poc4.api.ApiException.class)
            .satisfies(error -> assertThat(((com.manao.poc4.api.ApiException) error).code()).isIn("AI_TASK_NOT_ACTIVE", "AI_TASK_NOT_FOUND"));
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
                assertThat(harness.filesCommitted).isTrue();
                assertThat(harness.agent.receipt(PROJECT, harness.lastCommit.prepared().operationId())).isPresent();
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

    @Test void closeImmediatelyBeforePendingRegistrationRefusesPreparedJournal() throws Exception {
        try (var harness = new Harness()) {
            harness.registrationEntered = new CountDownLatch(1);
            harness.registrationRelease = new CountDownLatch(1);
            var executor = Executors.newSingleThreadExecutor();
            try {
                var invocation = executor.submit(() -> harness.tools.invoke(harness.taskId, harness.request("before-pending")));
                assertThat(harness.registrationEntered.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(harness.prepares).hasValue(1);
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
                harness.tasks.beginClose(harness.taskId);
                assertThat(harness.tools.finishForClose(harness.taskId)).isFalse();
                harness.registrationRelease.countDown();
                assertThat(invocation.get(5, TimeUnit.SECONDS).data().path("error").path("code").asText()).isEqualTo("AI_TASK_NOT_ACTIVE");
                assertThat(harness.commits).hasValue(0);
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
                assertThat(harness.tasks.hasLiveToolClaims(harness.taskId)).isFalse();
            } finally { harness.registrationRelease.countDown(); executor.shutdownNow(); }
        }
    }

    @Test void resultIdentityUsesDurableArgumentsEvenWithDifferentIncomingRequest() {
        try (var harness = new Harness()) {
            var row = register(harness, "durable-args");
            var incoming = new AgentContracts.ToolRequest("durable-args", "python_dependencies", 7,
                JSON.createObjectNode().put("action", "remove").put("packageName", "different").put("group", "main"));
            var adapter = new AgentPythonDependencyTools(harness.tasks, harness.dependencies);
            var result = adapter.invoke(harness.taskId, row, incoming);
            assertDependencyIdentity(result, "add");
            verify(harness.agent).prepare(eq(PROJECT), eq(row.workspaceOperationId()), anyString(), eq(new WorkspaceAgent.DependencyChange("ADD", "pytest", null, "test")));
        }
    }

    @Test void pendingRegistrationRequiresExecutionClaimAfterObservationClaim() {
        try (var harness = new Harness()) {
            var row = register(harness, "registration-claim");
            harness.db.jdbc().update("UPDATE agent_tool_call SET state='RUNNING' WHERE task_id=?", harness.taskId);
            assertThat(harness.tasks.claimDependencyObservation(harness.taskId, row.toolCallId())).isTrue();
            try {
                var operation = new WorkspaceStore.OperationRecord(row.workspaceOperationId(), PROJECT, 7, "a".repeat(64), "b".repeat(64),
                    "receipt.json", "c".repeat(64), "PENDING", "PYTHON_DEPENDENCIES", "d".repeat(64));
                assertNotActive(() -> harness.tasks.registerAgentDependencyPending(harness.taskId, row.toolCallId(), harness.store, operation));
                assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
            } finally { harness.tasks.releaseBuildClaim(harness.taskId, row.toolCallId()); }
        }
    }

    @Test void completedOperationRestartReconstructsResultWithoutCommitAndSettlesWholeTask() {
        try (var harness = new Harness()) {
            var initial = harness.tools.invoke(harness.taskId, harness.request("committed-restart"));
            // Simulate the crash window after the verified operation committed, before durable result publication.
            harness.db.jdbc().update("UPDATE agent_tool_call SET state='RUNNING',result_json=NULL WHERE task_id=?", harness.taskId);
            harness.db.jdbc().update("UPDATE agent_task SET settled_revision=NULL,changed_paths_json='[]' WHERE id=?", harness.taskId);
            var restarted = harness.restartedStore();
            var tools = harness.toolsFor(restarted);
            restarted.beginClose(harness.taskId, "AI_CLOSED");
            new AgentTaskSettlementService(restarted, harness.gate, mock(PiWorkerClient.class), tools).settleCloseIntent(harness.taskId, "AI_CLOSED", "closed");
            assertThat(tools.getCall(harness.taskId, "committed-restart").orElseThrow()).isEqualTo(initial);
            assertDependencyIdentity(tools.getCall(harness.taskId, "committed-restart").orElseThrow(), "add");
            assertThat(restarted.settlementView(harness.taskId).state()).isEqualTo("FAILED");
            assertThat(restarted.hasPendingReceipts(harness.taskId)).isFalse();
            assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
            assertThat(restarted.currentForOwner(OWNER, PROJECT)).isEmpty();
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.commits).hasValue(1);
            String nextTask = UUID.randomUUID().toString();
            restarted.createTask(OWNER, PROJECT, new AgentContracts.TaskRequest(nextTask, "continue dependencies", 8), null,
                () -> new AgentProjectEnvironmentService(harness.runtime, AgentProjectEnvironmentTest.policy()).forProject(PROJECT));
            var nextRequest = new AgentContracts.ToolRequest("next-dependency", "python_dependencies", 8, harness.request("ignored").args());
            assertThat(tools.invoke(nextTask, nextRequest).workspaceRevision()).isEqualTo("9");
            assertThat(harness.prepares).hasValue(2);
        }
    }

    @Test void failedResultPersistenceRollsBackTaskPathsAndRevisionThenRestartRecovers() {
        try (var harness = new Harness()) {
            harness.db.jdbc().execute("CREATE TRIGGER reject_dependency_result BEFORE UPDATE ON agent_tool_call FOR EACH ROW "
                + "BEGIN IF NEW.state='COMPLETED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture result rejected'; END IF; END");
            assertThatThrownBy(() -> harness.tools.invoke(harness.taskId, harness.request("result-failure"))).isInstanceOf(RuntimeException.class);
            assertThat(harness.store.findProject(PROJECT).workspaceRevision()).isEqualTo(8);
            var task = harness.tasks.findForOwner(OWNER, PROJECT, harness.taskId).orElseThrow();
            assertThat(task.workspaceRevision()).isEqualTo("7");
            assertThat(task.changedPaths()).isEmpty();
            assertThat(harness.tasks.hasLiveToolClaims(harness.taskId)).isFalse();
            harness.db.jdbc().execute("DROP TRIGGER reject_dependency_result");
            var restarted = harness.restartedStore();
            var tools = harness.toolsFor(restarted);
            restarted.beginClose(harness.taskId);
            assertThat(tools.finishForClose(harness.taskId)).isTrue();
            assertDependencyIdentity(tools.getCall(harness.taskId, "result-failure").orElseThrow(), "add");
            assertThat(restarted.findForOwner(OWNER, PROJECT, harness.taskId).orElseThrow().changedPaths()).containsExactly("pyproject.toml", "uv.lock");
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.commits).hasValue(1);
        }
    }

    @Test void lostResponseRecoversSameJournalWithoutPreparingTwice() {
        try (var harness = new Harness()) {
            harness.loseCommit = true;
            assertThatThrownBy(() -> harness.tools.invoke(harness.taskId, harness.request("lost-call"))).isInstanceOf(com.manao.poc4.api.ApiException.class);
            var restarted = harness.restartedStore();
            var recoveredTools = harness.toolsFor(restarted);
            assertThat(restarted.hasLiveToolClaims(harness.taskId)).isFalse();
            restarted.beginClose(harness.taskId);
            harness.loseCommit = false;
            assertThat(recoveredTools.finishForClose(harness.taskId)).isTrue();
            assertThat(harness.prepares).hasValue(1);
            assertThat(harness.store.findProject(PROJECT).workspaceRevision()).isEqualTo(8);
            var result = recoveredTools.getCall(harness.taskId, "lost-call").orElseThrow();
            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertDependencyIdentity(result, "add");
            assertThat(restarted.hasLiveToolClaims(harness.taskId)).isFalse();
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
            harness.tasks.markToolCallRunning(harness.taskId, request.toolCallId());
            var restarted = harness.restartedStore();
            assertThat(restarted.hasLiveToolClaims(harness.taskId)).isFalse();
            restarted.beginClose(harness.taskId);
            assertThat(harness.toolsFor(restarted).finishForClose(harness.taskId)).isTrue();
            assertThat(harness.prepares).hasValue(0);
            assertThat(harness.commits).hasValue(0);
        }
    }

    @Test void failedClaimLookupDoesNotBlockCloseWithLeakedLiveSeat() {
        try (var harness = new Harness()) {
            register(harness, "lookup-failure");
            doThrow(new IllegalStateException("fixture lookup failure")).when(harness.tasks).findToolCall(harness.taskId, "lookup-failure");
            assertThatThrownBy(() -> harness.tasks.markToolCallRunning(harness.taskId, "lookup-failure"))
                .isInstanceOf(IllegalStateException.class);
            assertThat(harness.tasks.hasLiveToolClaims(harness.taskId)).isFalse();
            doCallRealMethod().when(harness.tasks).findToolCall(harness.taskId, "lookup-failure");
            harness.tasks.beginClose(harness.taskId);
            assertThat(harness.tools.finishForClose(harness.taskId)).isTrue();
            assertThat(harness.prepares).hasValue(0);
        }
    }

    @Test void ownerPauseRecoversPendingDependencyAndNewTaskCanContinue() {
        try (var harness = new Harness()) {
            String instance = "dependency-worker-boot1";
            assertThat(harness.tasks.bindWorkerInstance(harness.taskId, 1, instance)).isTrue();
            harness.loseCommit = true;
            assertThatThrownBy(() -> harness.tools.invoke(harness.taskId, harness.request("pause-pending")))
                .isInstanceOf(com.manao.poc4.api.ApiException.class);
            var worker = mock(PiWorkerClient.class);
            String digest = harness.tasks.requestSha256Of(harness.taskId);
            String reportId = AgentTaskStore.terminalReportId(harness.taskId, 1, digest);
            var report = new AgentContracts.TerminalReport(1, reportId, AgentContracts.TaskState.FAILED, "aborted", "AI_ABORTED");
            String reportSha = AgentTaskStore.terminalContentSha256(reportId, report.state(), report.summary(), report.failureCode());
            when(worker.processStatus()).thenReturn(new AgentContracts.WorkerProcessStatus("boot1", instance, null, null, null, true));
            when(worker.status(harness.taskId)).thenReturn(new AgentContracts.WorkerStatus(harness.taskId, instance, "FAILED", 1, 1L,
                digest, "FAILED", new AgentContracts.WorkerTerminalDelivery("ACKED", reportId, reportSha, report)));
            var service = new AgentTaskService(harness.tasks, harness.gate, worker, harness.tools);
            service.pause(harness.taskId);
            assertThat(harness.tasks.settlementView(harness.taskId).closeReasonCode()).isEqualTo("AI_PAUSED_BY_OWNER");
            assertThat(harness.tasks.currentForOwner(OWNER, PROJECT)).isPresent();
            harness.loseCommit = false;
            new AgentTaskSettlementService(harness.tasks, harness.gate, worker, harness.tools).reconcile(harness.taskId);
            assertThat(harness.tasks.settlementView(harness.taskId).state()).isEqualTo("FAILED");
            assertThat(harness.tasks.currentForOwner(OWNER, PROJECT)).isEmpty();
            assertThat(harness.tasks.hasPendingReceipts(harness.taskId)).isFalse();
            assertThat(harness.store.pendingOperations(PROJECT)).isEmpty();
            assertDependencyIdentity(harness.tools.getCall(harness.taskId, "pause-pending").orElseThrow(), "add");
            String nextTask = UUID.randomUUID().toString();
            harness.tasks.createTask(OWNER, PROJECT, new AgentContracts.TaskRequest(nextTask, "continue after pause", 8), null,
                () -> new AgentProjectEnvironmentService(harness.runtime, AgentProjectEnvironmentTest.policy()).forProject(PROJECT));
            assertThat(harness.tools.invoke(nextTask, new AgentContracts.ToolRequest("after-pause", "python_dependencies", 8,
                harness.request("ignored").args())).workspaceRevision()).isEqualTo("9");
            assertThat(harness.prepares).hasValue(2);
        }
    }
}
