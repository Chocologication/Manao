package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static com.manao.poc4.ai.AgentConversationContracts.*;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.Timestamp;
import java.time.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

class AgentConversationCompactionTest {
    @Test void firstAuthenticatedAckReadOrResultBindsExactlyOneInstanceAndTerminalsCannotBeOverwritten() throws Exception {
        try (var f = new Fixture()) {
            for (String first : java.util.List.of("ack", "read", "result")) {
                String id = f.create(); String request = UUID.randomUUID().toString();
                assertThat(f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0)).created()).isTrue();
                var result = summary(0, "entry-" + first, null);
                if (first.equals("ack")) f.store.bindCompaction(id, request, 0, "worker-a");
                else if (first.equals("read")) assertThat(f.store.readForCompaction(id, request, 0, "worker-a", 0, null).headSeq()).isZero();
                else assertThat(f.store.finishCompaction(id, request, "worker-a", result).headSeq()).isEqualTo(1);
                code(() -> f.store.finishCompaction(id, request, "worker-b", result), "AI_CONTEXT_CONFLICT");
                code(() -> f.store.finishCompaction(id, request, "worker-a", new CompactResult(1, result.entries(), null, null)), "AI_CONTEXT_CONFLICT");
                assertThat(f.store.finishCompaction(id, request, "worker-a", result).headSeq()).isEqualTo(1);
                assertThat(f.store.finishCompaction(id, request, "worker-a", result).headSeq()).isEqualTo(1);
                code(() -> f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, java.util.List.of(), null, "AI_CONTEXT_COMPACTION_FAILED")), "AI_CONTEXT_CONFLICT");
                assertThat(f.store.detail("owner", "project", id).compactState()).isEqualTo("COMPLETED");
                assertThat(f.jdbc.queryForObject("SELECT source_task_id FROM agent_conversation_entry WHERE conversation_id=?", String.class, id)).isNull();
                assertThat(f.jdbc.queryForObject("SELECT writer_id FROM agent_conversation_entry WHERE conversation_id=?", String.class, id)).isEqualTo(request);
                String next = UUID.randomUUID().toString();
                f.store.beginCompaction("owner", "project", id, new CompactRequest(next, 1));
                code(() -> f.store.finishCompaction(id, request, "worker-a", result), "AI_CONTEXT_CONFLICT");
                f.store.finishCompaction(id, next, "worker-a", new CompactResult(1, java.util.List.of(), null, "AI_CONTEXT_COMPACTION_FAILED"));
                code(() -> f.store.finishCompaction(id, next, "worker-a", summary(1, "late", "entry-" + first)), "AI_CONTEXT_CONFLICT");
            }
        }
    }

    @Test void taskAndCompactRaceOnTwoRealConnectionsAdmitsExactlyOneAndAllProjectConversationsAreCovered() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String other = f.create();
            var barrier = new java.util.concurrent.CyclicBarrier(2);
            var connections = java.util.concurrent.ConcurrentHashMap.<Long>newKeySet();
            var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
            try {
                java.util.concurrent.Callable<Boolean> task = () -> f.transaction.execute(status -> {
                    connections.add(f.jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class)); await(barrier);
                    try { f.tasks.createTask("owner", "project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "goal", 7), other); return true; }
                    catch (com.manao.poc4.api.ApiException rejected) { status.setRollbackOnly(); assertThat(rejected.code()).isIn("AI_CONTEXT_BUSY"); return false; }
                });
                java.util.concurrent.Callable<Boolean> compact = () -> f.transaction.execute(status -> {
                    connections.add(f.jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class)); await(barrier);
                    try { f.store.beginCompaction("owner", "project", id, new CompactRequest(UUID.randomUUID().toString(), 0)); return true; }
                    catch (com.manao.poc4.api.ApiException rejected) { status.setRollbackOnly(); assertThat(rejected.code()).isEqualTo("AI_CONTEXT_BUSY"); return false; }
                });
                var a = pool.submit(task); var b = pool.submit(compact);
                assertThat(java.util.List.of(a.get(15, java.util.concurrent.TimeUnit.SECONDS), b.get(15, java.util.concurrent.TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(true, false);
                assertThat(connections).hasSize(2);
            } finally { pool.shutdownNow(); }
        }
    }

    @Test void rebuildReconcilesOnlyDefiniteInstanceLossAndAllowsTheNextTaskWithoutHoldingGateAcrossIO() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            var worker = new Worker();
            var gate = new com.manao.poc4.project.ProjectLifecycleGate();
            var service = new AgentConversationService(f.store, gate, worker);
            worker.startFailure = true;
            worker.status = new CompactStatus(id, request, "worker-a", "RUNNING");
            service.compact("owner", "project", id, new CompactRequest(request, 0));
            assertThat(worker.starts).isEqualTo(1);
            worker.statusFailure = true;
            assertThat(new AgentConversationService(f.store, gate, worker).detail("owner", "project", id).compactState()).isEqualTo("RUNNING");
            service.compact("owner", "project", id, new CompactRequest(request, 0));
            assertThat(worker.starts).isEqualTo(1);
            worker.statusFailure = false;
            worker.status = new CompactStatus(id, request, "worker-b", "NOT_FOUND");
            worker.check = () -> {
                var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
                try { assertThat(pool.submit(() -> { var lease = gate.tryAcquire("project"); lease.ifPresent(AutoCloseableLease -> AutoCloseableLease.close()); return lease.isPresent(); }).get()).isTrue(); }
                catch (Exception e) { throw new AssertionError(e); } finally { pool.shutdownNow(); }
            };
            var rebuilt = new AgentConversationService(f.store, gate, worker);
            var taskService = new AgentTaskService(f.tasks, gate, worker, null, rebuilt);
            assertThat(taskService.submit("owner", "project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "next", 7), id).conversationId()).isEqualTo(id);
            assertThat(f.store.detail("owner", "project", id).compactState()).isEqualTo("FAILED");
            code(() -> f.store.finishCompaction(id, request, "worker-a", summary(0, "late", null)), "AI_CONTEXT_CONFLICT");
        }
    }

    @Test void lostCallbackAckReplaysTheOriginalResultAndExplicitNewRequestCannotResurrectAnOldWriter() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            var worker = new Worker(); worker.status = new CompactStatus(id, request, "worker-a", "RUNNING");
            var service = new AgentConversationService(f.store, new com.manao.poc4.project.ProjectLifecycleGate(), worker);
            service.compact("owner", "project", id, new CompactRequest(request, 0));
            var result = summary(0, "summary", null);
            f.store.finishCompaction(id, request, "worker-a", result); // HTTP ACK lost after commit.
            assertThat(service.compact("owner", "project", id, new CompactRequest(request, 0)).compactState()).isEqualTo("COMPLETED");
            assertThat(worker.starts).isEqualTo(1);
            assertThat(f.store.finishCompaction(id, request, "worker-a", result).headSeq()).isEqualTo(1);
            assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isEqualTo(1);
            code(() -> f.store.beginCompaction("foreign", "project", id, new CompactRequest(UUID.randomUUID().toString(), 1)), "AI_CONVERSATION_NOT_FOUND");
            code(() -> f.store.beginCompaction("owner", "project", id, new CompactRequest(UUID.randomUUID().toString(), 0)), "AI_CONTEXT_CONFLICT");
        }
    }

    @Test void oldSuccessfulRequestValidatesItsOriginalBaseEvenAfterTheLatestRequestChanged() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            var metadata = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode().put("type", "model_change").put("id", "model")
                .putNull("parentId").put("timestamp", "2026-10-19T00:00:00Z").put("provider", "test").put("modelId", "model");
            var nativeSummary = summary(0, "summary", "model").entries().get(0);
            f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, java.util.List.of(metadata, nativeSummary), null, null));
            String next = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(next, 2));
            f.store.finishCompaction(id, next, "worker-a", new CompactResult(2, java.util.List.of(), null, null));
            assertThat(f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0)).view().compactState()).isEqualTo("COMPLETED");
            code(() -> f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 1)), "AI_CONTEXT_CONFLICT");
        }
    }

    @Test void manualSummaryDoesNotStopReadyApplicationOrCreateSourceWriteAuthority() throws Exception {
        try (var f = new Fixture()) {
            f.jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,fencing_token,first_ready_at,updated_at,created_at) VALUES ('ready-run','project',7,'RUNNING','{}',1,?,?,?)",
                Timestamp.from(f.clock.instant()), Timestamp.from(f.clock.instant()), Timestamp.from(f.clock.instant()));
            var before = f.jdbc.queryForMap("SELECT * FROM run WHERE id='ready-run'");
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            f.store.readForCompaction(id, request, 0, "worker-a", 0, null);
            f.store.finishCompaction(id, request, "worker-a", summary(0, "summary", null));
            assertThat(f.jdbc.queryForMap("SELECT * FROM run WHERE id='ready-run'")).isEqualTo(before);
            assertThat(f.jdbc.queryForObject("SELECT workspace_revision FROM project", Long.class)).isEqualTo(7);
            assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task", Integer.class)).isZero();
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> f.tasks.requireWorkerIdentity(request, 0, "worker-a"))
                .isInstanceOf(com.manao.poc4.api.ApiException.class);
        }
    }

    @Test void definiteInstanceLossFencesAFirstContextBindingThatArrivedDuringStatusIO() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            var worker = new Worker();
            worker.check = () -> f.store.readForCompaction(id, request, 0, "old-worker", 0, null);
            worker.status = new CompactStatus(id, request, "replacement-worker", "NOT_FOUND");
            var service = new AgentConversationService(f.store, new com.manao.poc4.project.ProjectLifecycleGate(), worker);
            assertThat(service.detail("owner", "project", id).compactState()).isEqualTo("FAILED");
            code(() -> f.store.finishCompaction(id, request, "old-worker", summary(0, "late", null)), "AI_CONTEXT_CONFLICT");
        }
    }

    @Test void anAutomaticTaskSummaryIsNotMistakenForAManualRequestWithTheSameUuid() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String task = UUID.randomUUID().toString();
            var created = f.tasks.createTask("owner", "project", new AgentContracts.TaskRequest(task, "goal", 7), id);
            f.tasks.bindWorkerInstance(task, created.epoch(), "worker-a");
            var context = f.store.readForTask(task, "worker-a", created.epoch(), 0, null);
            f.store.appendForTask(task, "worker-a", created.epoch(), new ContextAppend(1, context.header(), summary(1, "automatic", task).entries(), null));
            f.jdbc.update("UPDATE agent_task SET state='COMPLETED' WHERE id=?", task);
            assertThat(f.store.beginCompaction("owner", "project", id, new CompactRequest(task, 2)).created()).isTrue();
            var noop = new CompactResult(2, java.util.List.of(), null, null);
            assertThat(f.store.finishCompaction(id, task, "worker-a", noop).headSeq()).isEqualTo(2);
            assertThat(f.store.finishCompaction(id, task, "worker-a", noop).headSeq()).isEqualTo(2);
        }
    }

    @Test void aCompletedNoopNeverAllowsALateCallbackToAppendASummary() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, java.util.List.of(), null, null));
            code(() -> f.store.finishCompaction(id, request, "worker-a", summary(0, "late", null)), "AI_CONTEXT_CONFLICT");
            assertThat(f.store.detail("owner", "project", id).headSeq()).isZero();
        }
    }

    @Test void oversizedManualSuffixNeverPartiallyWritesAndFailureCallbackCarriesNoSummary() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            var entry = summary(0, "huge", null).entries().get(0).deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) entry).put("summary", "x".repeat(2 * 1024 * 1024));
            code(() -> f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, java.util.List.of(entry), null, null)), "AI_REQUEST_TOO_LARGE");
            assertThat(f.store.detail("owner", "project", id).headSeq()).isZero();
            assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isZero();
            code(() -> f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, summary(0, "bad", null).entries(), null, "AI_CONTEXT_COMPACTION_FAILED")), "VALIDATION_ERROR");
            f.store.finishCompaction(id, request, "worker-a", new CompactResult(0, java.util.List.of(), null, "AI_CONTEXT_COMPACTION_FAILED"));
            assertThat(f.store.detail("owner", "project", id).compactState()).isEqualTo("FAILED");
        }
    }

    @Test void internalCompactRoutesRequireRegisteredRequestBaseAndInstanceAndCommitResultOnce() throws Exception {
        try (var f = new Fixture()) {
            String id = f.create(); String request = UUID.randomUUID().toString();
            f.store.beginCompaction("owner", "project", id, new CompactRequest(request, 0));
            var mvc = MockMvcBuilders.standaloneSetup(new AgentConversationInternalController(f.store))
                .setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
            String path = "/internal/ai/conversations/" + id + "/compactions/" + request;
            assertThat(mvc.perform(get(path + "/context").param("expectedHeadSeq", "0")).andReturn().getResponse().getStatus()).isEqualTo(422);
            assertThat(mvc.perform(get(path + "/context").param("expectedHeadSeq", "1").header("X-Manao-Worker-Instance", "worker-a"))
                .andReturn().getResponse().getStatus()).isEqualTo(409);
            assertThat(mvc.perform(get(path + "/context").param("expectedHeadSeq", "0").header("X-Manao-Worker-Instance", "worker-a"))
                .andReturn().getResponse().getStatus()).isEqualTo(200);
            var json = new com.fasterxml.jackson.databind.ObjectMapper();
            assertThat(mvc.perform(post(path + "/result").header("X-Manao-Worker-Instance", "worker-b").contentType("application/json")
                .content(json.writeValueAsBytes(summary(0, "summary", null)))).andReturn().getResponse().getStatus()).isEqualTo(409);
            for (int i = 0; i < 2; i++) assertThat(mvc.perform(post(path + "/result").header("X-Manao-Worker-Instance", "worker-a").contentType("application/json")
                .content(json.writeValueAsBytes(summary(0, "summary", null)))).andReturn().getResponse().getStatus()).isEqualTo(200);
            assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isEqualTo(1);
        }
    }

    private static CompactResult summary(long head, String id, String parent) throws Exception {
        var entry = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode().put("type", "compaction").put("id", id)
            .put("parentId", parent).put("timestamp", "2026-10-19T00:00:00Z").put("summary", "保留 bookId").put("firstKeptEntryId", id).put("tokensBefore", 100);
        return new CompactResult(head, java.util.List.of(entry), new ContextUsage(null, 1_048_576, null), null);
    }
    private static void code(org.assertj.core.api.ThrowableAssert.ThrowingCallable action, String code) {
        org.assertj.core.api.Assertions.assertThatThrownBy(action).isInstanceOf(com.manao.poc4.api.ApiException.class)
            .satisfies(error -> assertThat(((com.manao.poc4.api.ApiException) error).code()).isEqualTo(code));
    }
    private static void await(java.util.concurrent.CyclicBarrier barrier) {
        try { barrier.await(10, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ex) { throw new AssertionError(ex); }
    }
    private static class Worker implements PiWorkerClient {
        CompactStatus status; int starts; boolean startFailure; boolean statusFailure; Runnable check = () -> {};
        public AgentContracts.WorkerStatus start(AgentContracts.WorkerStart start) { return new AgentContracts.WorkerStatus(start.taskId(), "worker-a", "RUNNING"); }
        public AgentContracts.WorkerStatus status(String id) { throw new AssertionError("No task query"); }
        public AgentContracts.WorkerStatus stop(String id) { throw new AssertionError("Compaction must not stop a Run or task"); }
        public CompactStatus startCompaction(CompactStart start) { starts++; if (startFailure) throw new com.manao.poc4.api.ApiException("AI_WORKER_UNREACHABLE", 502, "Lost ACK"); return status; }
        public CompactStatus compactionStatus(String conversation, String request) { check.run(); if (statusFailure) throw new com.manao.poc4.api.ApiException("AI_WORKER_UNREACHABLE", 502, "Timeout"); return status; }
    }
    private static class Fixture implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final org.springframework.jdbc.core.JdbcTemplate jdbc = db.jdbc();
        final DataSourceTransactionManager tx = new DataSourceTransactionManager(jdbc.getDataSource());
        final org.springframework.transaction.support.TransactionTemplate transaction = new org.springframework.transaction.support.TransactionTemplate(tx);
        final Clock clock = Clock.fixed(Instant.parse("2026-10-19T00:00:00Z"), ZoneOffset.UTC);
        final AgentTaskStore tasks = new AgentTaskStore(jdbc, tx, clock);
        final AgentConversationStore store = new AgentConversationStore(jdbc, tx, clock, tasks);
        Fixture() {
            var now = Timestamp.from(clock.instant());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',7,?,?)", now, now);
        }
        String create() { String id = UUID.randomUUID().toString(); store.create("owner", "project", new CreateConversationRequest(id)); return id; }
        public void close() { db.close(); }
    }
    @Test void browserCanStartTheRegisteredCompactionWithoutCreatingATaskOrEditingSources() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var now = Timestamp.from(Instant.parse("2026-10-19T00:00:00Z"));
            db.jdbc().update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)", now);
            db.jdbc().update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',7,?,?)", now, now);
            var tx = new DataSourceTransactionManager(db.jdbc().getDataSource());
            var tasks = new AgentTaskStore(db.jdbc(), tx, Clock.fixed(now.toInstant(), ZoneOffset.UTC));
            var store = new AgentConversationStore(db.jdbc(), tx, Clock.fixed(now.toInstant(), ZoneOffset.UTC), tasks);
            String id = UUID.randomUUID().toString();
            store.create("owner", "project", new CreateConversationRequest(id));
            var mvc = MockMvcBuilders.standaloneSetup(new AgentConversationController(new AgentConversationService(store), null))
                .setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
            var response = mvc.perform(post("/api/v1/projects/project/conversations/" + id + "/compact")
                .principal(() -> "owner").contentType("application/json")
                .content("{\"requestId\":\"" + UUID.randomUUID() + "\",\"expectedHeadSeq\":0}")).andReturn().getResponse();
            assertThat(response.getStatus()).isEqualTo(200);
            assertThat(response.getContentAsString()).contains("compactRequestId");
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_task", Integer.class)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT workspace_revision FROM project", Long.class)).isEqualTo(7);
        }
    }
}
