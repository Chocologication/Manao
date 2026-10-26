package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.manao.poc4.ai.AgentConversationContracts.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class AgentConversationStoreTest {
    private static final Instant NOW = Instant.parse("2026-10-19T00:00:00Z");
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test void creationIsIdempotentAndOwnerScoped() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db);
            var conversations = conversations(db);
            String id = UUID.randomUUID().toString();
            assertThat(conversations.create("ctx-owner", "ctx-project", new CreateConversationRequest(id)))
                .isEqualTo(new ConversationView(id, "新会话", 0, null, null, null, null, null, null));
            assertThat(conversations.create("ctx-owner", "ctx-project", new CreateConversationRequest(id)).headSeq()).isZero();
            assertThat(conversations.list("ctx-owner", "ctx-project", null, 20).items()).hasSize(1);
            assertCode(() -> conversations.detail("other-owner", "ctx-project", id), "AI_CONVERSATION_NOT_FOUND");
            assertCode(() -> conversations.create("ctx-owner", "other-project", new CreateConversationRequest(id)), "AI_CONVERSATION_NOT_FOUND");
        }
    }

    @Test void taskAdmissionPersistsOriginalGoalAtomicallyAndBindsReplayDigest() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db);
            var conversations = conversations(db);
            String id = UUID.randomUUID().toString();
            String other = UUID.randomUUID().toString();
            conversations.create("ctx-owner", "ctx-project", new CreateConversationRequest(id));
            conversations.create("ctx-owner", "ctx-project", new CreateConversationRequest(other));
            String task = UUID.randomUUID().toString();
            String goal = "😀".repeat(41) + "原始目标";
            var request = new AgentContracts.TaskRequest(task, goal, 7);
            assertThat(tasks(db).createTask("ctx-owner", "ctx-project", request, id).snapshot().conversationId()).isEqualTo(id);
            assertThat(tasks(db).createTask("ctx-owner", "ctx-project", request, id).created()).isFalse();
            assertCode(() -> tasks(db).createTask("ctx-owner", "ctx-project", request, other), "AI_TASK_MISMATCH");
            assertThat(conversations.detail("ctx-owner", "ctx-project", id).title()).isEqualTo("😀".repeat(40));
            assertThat(conversations.history("ctx-owner", "ctx-project", id, null, 50).items())
                .containsExactly(new HistoryItem(1, task, "user", goal, null));
            var entry = JSON.readTree(db.jdbc().queryForObject("SELECT payload_json FROM agent_conversation_entry", String.class));
            assertThat(entry.path("id").asText()).isEqualTo(task);
            assertThat(entry.path("parentId").isNull()).isTrue();
            assertThat(entry.path("timestamp").asText()).isEqualTo("2026-10-19T00:00:00Z");
            assertThat(entry.path("details").path("taskId").asText()).isEqualTo(task);
            db.jdbc().update("UPDATE agent_task SET state='FAILED' WHERE id=?", task);
            var legacy = tasks(db).create("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "legacy", 7));
            assertThat(legacy.conversationId()).isNull();
        }
    }

    @Test void nativeAppendReplaysOnlyWholeIdenticalBatchesAndRejectsStaleWritersAndForeignReferences() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db);
            var store = conversations(db);
            String id = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(id));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), id);
            var page = store.readForTask(task, "worker", 1, 0, null);
            assertThat(page.headSeq()).isEqualTo(1);
            assertThat(page.header().path("id").asText()).isEqualTo(id);
            var first = JSON.readTree("{\"id\":\"native-1\",\"type\":\"message\",\"parentId\":\"" + task + "\",\"timestamp\":\"2026-10-19T00:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"完整中文\"},{\"type\":\"thinking\",\"thinking\":\"secret-thought\"}]}}");
            var append = new ContextAppend(1, page.header(), List.of(first), new ContextUsage(321L, 1048576, null));
            assertThat(store.appendForTask(task, "worker", 1, append).headSeq()).isEqualTo(2);
            assertThat(store.appendForTask(task, "worker", 1, append).headSeq()).isEqualTo(2);
            var changed = first.deepCopy(); ((com.fasterxml.jackson.databind.node.ObjectNode) changed).put("timestamp", "changed");
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(1, page.header(), List.of(changed), null)), "AI_CONTEXT_CONFLICT");
            var bad = JSON.readTree("{\"id\":\"native-2\",\"type\":\"context_edit\",\"parentId\":\"foreign\",\"targetId\":\"native-1\",\"replacement\":null}");
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(2, page.header(), List.of(bad), null)), "AI_CONTEXT_CONFLICT");
            assertCode(() -> store.appendForTask(task, "other-worker", 1, append), "AI_INSTANCE_MISMATCH");
            assertThat(store.history("ctx-owner", "ctx-project", id, null, 50).items())
                .extracting(HistoryItem::text).contains("完整中文", "secret-thought");
            db.jdbc().update("UPDATE agent_task SET state='FAILED' WHERE id=?", task);
            assertCode(() -> store.appendForTask(task, "worker", 1, append), "AI_CONTEXT_CONFLICT");
        }
    }

    @Test void nativePagesPinHeadAndBatchLimitsDoNotTruncateEntries() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db);
            var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var initial = store.readForTask(task, "worker", 1, 0, null);
            var entries = new java.util.ArrayList<com.fasterxml.jackson.databind.JsonNode>();
            String parent = task;
            for (int i = 0; i < 32; i++) {
                var entry = nativeMessage("page-" + i, parent, "中文".repeat(5000));
                entries.add(entry); parent = "page-" + i;
            }
            assertThat(store.appendForTask(task, "worker", 1, new ContextAppend(1, initial.header(), entries, null)).headSeq()).isEqualTo(33);
            var page = store.readForTask(task, "worker", 1, 0, null);
            assertThat(page.entries()).hasSize(32);
            assertThat(page.nextAfterSeq()).isEqualTo(32);
            store.appendForTask(task, "worker", 1, new ContextAppend(33, page.header(), List.of(nativeMessage("later", parent, "later")), null));
            var tail = store.readForTask(task, "worker", 1, page.nextAfterSeq(), page.headSeq());
            assertThat(tail.headSeq()).isEqualTo(33);
            assertThat(tail.entries()).extracting(StoredEntry::seq).containsExactly(33L);
            assertThat(tail.entries().get(0).entry().path("message").path("content").get(0).path("text").asText()).hasSize(10000);
            assertThat(tail.nextAfterSeq()).isNull();
            var big = nativeMessage("big", "later", "x".repeat(2 * 1024 * 1024));
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(34, page.header(), List.of(big), null)), "AI_REQUEST_TOO_LARGE");
            assertThat(store.detail("ctx-owner", "ctx-project", conversation).headSeq()).isEqualTo(34);
            var history = store.history("ctx-owner", "ctx-project", conversation, null, 2);
            assertThat(history.items()).hasSize(2);
            assertThat(history.nextBeforeSeq()).isEqualTo(33);
            assertThat(store.history("ctx-owner", "ctx-project", conversation, history.nextBeforeSeq(), 2).items())
                .extracting(HistoryItem::seq).containsExactly(31L, 32L);
        }
    }

    @Test void entryBytesBoundResponsePagesAndHeaderAndMixedBatchConflictsAreAtomic() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var page = store.readForTask(task, "worker", 1, 0, null);
            var e1 = nativeMessage("large-1", task, "中".repeat(600000));
            store.appendForTask(task, "worker", 1, new ContextAppend(1, page.header(), List.of(e1), null));
            store.appendForTask(task, "worker", 1, new ContextAppend(2, page.header(), List.of(nativeMessage("large-2", "large-1", "中".repeat(600000))), null));
            store.appendForTask(task, "worker", 1, new ContextAppend(3, page.header(), List.of(nativeMessage("large-3", "large-2", "中".repeat(600000))), null));
            var first = store.readForTask(task, "worker", 1, 0, null);
            assertThat(JSON.writeValueAsBytes(first).length).isLessThanOrEqualTo(4 * 1024 * 1024);
            assertThat(first.nextAfterSeq()).isEqualTo(3);
            assertThat(store.readForTask(task, "worker", 1, 3, first.headSeq()).entries()).extracting(StoredEntry::seq).containsExactly(4L);
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(1, page.header(), List.of(e1, nativeMessage("new", "large-3", "new")), null)), "AI_CONTEXT_CONFLICT");
            var forged = page.header().deepCopy(); ((com.fasterxml.jackson.databind.node.ObjectNode) forged).put("cwd", "/other");
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(4, forged, List.of(), null)), "AI_CONTEXT_CONFLICT");
            assertCode(() -> store.appendForTask(task, "worker", 0, new ContextAppend(4, page.header(), List.of(), null)), "AI_EPOCH_MISMATCH");
            assertThat(store.detail("ctx-owner", "ctx-project", conversation).headSeq()).isEqualTo(4);
        }
    }

    @Test void oversizedBrowserTextIsLosslesslyPagedAtUnicodeBoundaries() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var page = store.readForTask(task, "worker", 1, 0, null);
            String text = "😀中文\\\"".repeat(80000);
            store.appendForTask(task, "worker", 1, new ContextAppend(1, page.header(), List.of(nativeMessage("long", task, text)), null));
            Long before = null; Integer offset = null;
            var fragments = new java.util.TreeMap<Integer, String>();
            int pages = 0;
            do {
                var history = store.history("ctx-owner", "ctx-project", conversation, before, offset, 2);
                assertThat(JSON.writeValueAsBytes(history).length).isLessThanOrEqualTo(512 * 1024);
                for (var item : history.items()) if (item.seq() == 2) fragments.put(item.textOffset(), item.text());
                before = history.nextBeforeSeq(); offset = history.nextBeforeOffset(); pages++;
                assertThat(pages).isLessThan(100);
            } while (before != null);
            assertThat(String.join("", fragments.values())).isEqualTo(text);
            assertThat(pages).isGreaterThan(1);
        }
    }

    @Test void missingConversationAndCompactionOccupancyNeverLeaveTaskOrGoalRows() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            assertCode(() -> tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "goal", 7), UUID.randomUUID().toString()), "AI_CONVERSATION_NOT_FOUND");
            db.jdbc().update("UPDATE agent_conversation SET compact_state='RUNNING' WHERE id=?", conversation);
            assertCode(() -> tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "goal", 7), conversation), "AI_CONTEXT_BUSY");
            assertCode(() -> tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "legacy", 7)), "AI_CONTEXT_BUSY");
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_task", Integer.class)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isZero();
        }
    }

    @Test void v12UpgradePreservesLegacyTaskAndToolRowsAndConversationForeignKeysCascade() {
        try (var db = JdbcStoreTestSupport.createAtVersion("12")) {
            seed(db); var now = Timestamp.from(NOW);
            String task = UUID.randomUUID().toString();
            db.jdbc().update("INSERT INTO agent_task(id,project_id,owner_id,request_sha256,prompt,state,worker_epoch,workspace_revision,created_at,updated_at) VALUES (?,'ctx-project','ctx-owner',?,'legacy','COMPLETED',1,7,?,?)", task, "a".repeat(64), now, now);
            db.jdbc().update("INSERT INTO agent_tool_call(task_id,tool_call_id,request_sha256,tool_name,state,expected_revision,created_at,updated_at) VALUES (?,'old',?,'read_file','COMPLETED',7,?,?)", task, "b".repeat(64), now, now);
            var taskBefore = db.jdbc().queryForMap("SELECT * FROM agent_task WHERE id=?", task);
            var callBefore = db.jdbc().queryForMap("SELECT * FROM agent_tool_call WHERE task_id=?", task);
            db.migrateToLatest();
            var after = db.jdbc().queryForMap("SELECT * FROM agent_task WHERE id=?", task);
            assertThat(after.remove("conversation_id")).isNull();
            assertThat(after).containsEntry("reasoning_effort", null);
            after.remove("reasoning_effort");
            // The V15 terminal-receipt columns are additive by design: they appear as
            // NULL on a legacy row and never rewrite any legacy value (repair task 2).
            assertThat(after.remove("terminal_report_id")).isNull();
            assertThat(after.remove("terminal_report_json")).isNull();
            assertThat(after.remove("terminal_report_sha256")).isNull();
            assertThat(after.remove("terminal_received_at")).isNull();
            assertThat(after.remove("deadline_at")).isNull();
            assertThat(after.remove("close_reason_code")).isNull();
            assertThat(after.remove("next_reconcile_at")).isNull();
            assertThat(after.remove("reconcile_attempt")).isEqualTo(0);
            assertThat(after).isEqualTo(taskBefore);
            assertThat(db.jdbc().queryForMap("SELECT * FROM agent_tool_call WHERE task_id=?", task)).isEqualTo(callBefore);
            String conversation = UUID.randomUUID().toString();
            conversations(db).create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "goal", 7), conversation);
            db.jdbc().update("DELETE FROM project WHERE id='ctx-project'");
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_tool_call", Integer.class)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation", Integer.class)).isZero();
        }
    }

    private static com.fasterxml.jackson.databind.JsonNode nativeMessage(String id, String parent, String text) {
        var entry = JSON.createObjectNode().put("id", id).put("type", "message").put("parentId", parent).put("timestamp", NOW.toString());
        entry.putObject("message").put("role", "assistant").putArray("content").addObject().put("type", "text").put("text", text);
        return entry;
    }

    @Test void nativeReferencesAndUsageRemainScopedWhileJsonReplayIgnoresKeyOrder() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String a = UUID.randomUUID().toString(), b = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(a));
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(b));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), a);
            var page = store.readForTask(task, "worker", 1, 0, null);
            var message = nativeMessage("message", task, "answer");
            var edit = JSON.readTree("{\"id\":\"edit\",\"type\":\"context_edit\",\"timestamp\":\"2026-10-19T00:00:00Z\",\"parentId\":\"message\",\"targetId\":\"message\",\"replacement\":null}");
            var compact = JSON.readTree("{\"id\":\"compact\",\"type\":\"compaction\",\"timestamp\":\"2026-10-19T00:00:00Z\",\"parentId\":\"edit\",\"firstKeptEntryId\":\"compact\",\"tokensBefore\":900000,\"summary\":\"summary\"}");
            var append = new ContextAppend(1, page.header(), List.of(message, edit, compact), new ContextUsage(null, 1048576, null));
            assertThat(store.appendForTask(task, "worker", 1, append).headSeq()).isEqualTo(4);
            assertThat(store.readForTask(task, "worker", 1, 1, null).entries()).extracting(StoredEntry::entry).containsExactly(message, edit, compact);
            assertThat(store.detail("ctx-owner", "ctx-project", a).usage()).isEqualTo(new ContextUsage(null, 1048576, null));
            var reordered = JSON.readTree("{\"summary\":\"summary\",\"tokensBefore\":900000,\"firstKeptEntryId\":\"compact\",\"parentId\":\"edit\",\"timestamp\":\"2026-10-19T00:00:00Z\",\"type\":\"compaction\",\"id\":\"compact\"}");
            assertThat(store.appendForTask(task, "worker", 1, new ContextAppend(1, page.header(), List.of(message, edit, reordered), null)).headSeq()).isEqualTo(4);
            var foreign = nativeMessage("foreign", "not-in-a", "invalid");
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(4, page.header(), List.of(foreign), null)), "AI_CONTEXT_CONFLICT");
            assertThat(store.history("ctx-owner", "ctx-project", b, null, 50).items()).isEmpty();
            db.jdbc().update("UPDATE agent_task SET state='FAILED' WHERE id=?", task);
            String next = UUID.randomUUID().toString();
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(next, "next", 7), a);
            var nextPage = store.readForTask(next, "worker", 1, 4, null);
            assertThat(nextPage.entries().get(0).entry().path("parentId").asText()).isEqualTo("compact");
            assertThat(store.detail("ctx-owner", "ctx-project", a).title()).isEqualTo("goal");
            var measured = nativeMessage("measured", next, "new answer");
            store.appendForTask(next, "worker", 1, new ContextAppend(5, page.header(), List.of(measured), new ContextUsage(5432L, 1048576, 0.518035888671875)));
            assertThat(store.detail("ctx-owner", "ctx-project", a).usage()).isEqualTo(new ContextUsage(5432L, 1048576, 0.518035888671875));
            assertThat(db.jdbc().queryForObject("SELECT usage_head_seq FROM agent_conversation WHERE id=?", Long.class, a)).isEqualTo(6L);
            db.jdbc().update("UPDATE agent_task SET state='FAILED' WHERE id=?", next);
            String latest = UUID.randomUUID().toString();
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(latest, "new goal", 7), a);
            assertThat(store.detail("ctx-owner", "ctx-project", a).usage()).isEqualTo(new ContextUsage(null, 1048576, null));
            assertThat(db.jdbc().queryForObject("SELECT usage_head_seq FROM agent_conversation WHERE id=?", Long.class, a)).isEqualTo(6L);
            var unmeasured = nativeMessage("unmeasured", latest, "new unmeasured content");
            store.appendForTask(latest, "worker", 1, new ContextAppend(7, page.header(), List.of(unmeasured), null));
            assertThat(store.detail("ctx-owner", "ctx-project", a).usage()).isNull();
            assertThat(db.jdbc().queryForObject("SELECT usage_head_seq FROM agent_conversation WHERE id=?", Long.class, a)).isNull();
        }
    }

    @Test void conversationListCursorNeverCrossesProjectAndHandlesEqualTimestamps() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            for (String id : List.of("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"))
                store.create("ctx-owner", "ctx-project", new CreateConversationRequest(id));
            var first = store.list("ctx-owner", "ctx-project", null, 2);
            assertThat(first.items()).extracting(ConversationView::conversationId).containsExactly("00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002");
            var second = store.list("ctx-owner", "ctx-project", first.nextCursor(), 2);
            assertThat(second.items()).extracting(ConversationView::conversationId).containsExactly("00000000-0000-4000-8000-000000000001");
            assertThat(second.nextCursor()).isNull();
            assertCode(() -> store.list("other-owner", "ctx-project", first.nextCursor(), 2), "AI_CONVERSATION_NOT_FOUND");
        }
    }

    @Test void taskAdmissionWaitsForTheSameProjectRowAsCompactionAndThenSeesItsCommittedReservation() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); String conversation = UUID.randomUUID().toString();
            conversations(db).create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            var locked = new java.util.concurrent.CountDownLatch(1);
            var started = new java.util.concurrent.CountDownLatch(1);
            var release = new java.util.concurrent.CountDownLatch(1);
            var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
            try {
                var reservation = pool.submit(() -> new org.springframework.transaction.support.TransactionTemplate(
                        new DataSourceTransactionManager(db.jdbc().getDataSource())).execute(status -> {
                    db.jdbc().queryForObject("SELECT id FROM project WHERE id='ctx-project' FOR UPDATE", String.class);
                    locked.countDown();
                    try { if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("reservation not released"); }
                    catch (InterruptedException ex) { throw new AssertionError(ex); }
                    AgentConversationStore.requireNoCompaction(db.jdbc(), "ctx-project");
                    db.jdbc().update("UPDATE agent_conversation SET compact_state='RUNNING' WHERE id=?", conversation);
                    return true;
                }));
                assertThat(locked.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var submit = pool.submit(() -> {
                    started.countDown();
                    return tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(UUID.randomUUID().toString(), "goal", 7), conversation);
                });
                assertThat(started.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                release.countDown(); reservation.get(5, java.util.concurrent.TimeUnit.SECONDS);
                assertThatThrownBy(() -> submit.get(5, java.util.concurrent.TimeUnit.SECONDS))
                    .hasCauseInstanceOf(ApiException.class).satisfies(ex -> assertThat(((ApiException) ex.getCause()).code()).isEqualTo("AI_CONTEXT_BUSY"));
                assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_task", Integer.class)).isZero();
                assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isZero();
            } finally { release.countDown(); pool.shutdownNow(); }
        }
    }

    @Test void concurrentFirstBindingRejectsTheInstanceFromTheEarlierReadView() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = JSON.readTree(db.jdbc().queryForObject("SELECT header_json FROM agent_conversation WHERE id=?", String.class, conversation));
            var read = new java.util.concurrent.CountDownLatch(1); var resume = new java.util.concurrent.CountDownLatch(1);
            var readerConnection = new java.util.concurrent.atomic.AtomicReference<Long>();
            var reader = pausedAfterTaskLookup(db, task, read, resume, readerConnection);
            var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var late = pool.submit(() -> reader.appendForTask(task, "wrong-worker", 1,
                    new ContextAppend(1, header, List.of(nativeMessage("wrong", task, "must not save")), null)));
                assertThat(read.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(db.jdbc().queryForObject("SELECT CONNECTION_ID()", Long.class)).isNotEqualTo(readerConnection.get());
                assertThat(tasks(db).bindWorkerInstance(task, 1, "correct-worker")).isTrue();
                resume.countDown();
                assertThatThrownBy(() -> late.get(5, java.util.concurrent.TimeUnit.SECONDS))
                    .hasCauseInstanceOf(ApiException.class).satisfies(ex -> assertThat(((ApiException) ex.getCause()).code()).isEqualTo("AI_INSTANCE_MISMATCH"));
                assertThat(store.detail("ctx-owner", "ctx-project", conversation).headSeq()).isEqualTo(1);
                assertThat(db.jdbc().queryForObject("SELECT worker_instance_id FROM agent_task WHERE id=?", String.class, task)).isEqualTo("correct-worker");
            } finally { resume.countDown(); pool.shutdownNow(); }
        }
    }

    @Test void concurrentIdenticalAppendReturnsTheOriginalAckAfterAnotherConnectionCommits() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            var append = new ContextAppend(1, header, List.of(nativeMessage("same", task, "answer")), null);
            var read = new java.util.concurrent.CountDownLatch(1); var resume = new java.util.concurrent.CountDownLatch(1);
            var readerConnection = new java.util.concurrent.atomic.AtomicReference<Long>();
            var reader = pausedAfterTaskLookup(db, task, read, resume, readerConnection);
            var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var retry = pool.submit(() -> reader.appendForTask(task, "worker", 1, append));
                assertThat(read.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(db.jdbc().queryForObject("SELECT CONNECTION_ID()", Long.class)).isNotEqualTo(readerConnection.get());
                assertThat(store.appendForTask(task, "worker", 1, append).headSeq()).isEqualTo(2);
                resume.countDown();
                assertThat(retry.get(5, java.util.concurrent.TimeUnit.SECONDS).headSeq()).isEqualTo(2);
                assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation_entry WHERE conversation_id=?", Integer.class, conversation)).isEqualTo(2);
            } finally { resume.countDown(); pool.shutdownNow(); }
        }
    }

    @Test void concurrentContextReadPairsTheNewHeadWithItsCommittedEntries() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            var read = new java.util.concurrent.CountDownLatch(1); var resume = new java.util.concurrent.CountDownLatch(1);
            var readerConnection = new java.util.concurrent.atomic.AtomicReference<Long>();
            var reader = pausedAfterTaskLookup(db, task, read, resume, readerConnection);
            var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var pending = pool.submit(() -> reader.readForTask(task, "worker", 1, 0, null));
                assertThat(read.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(db.jdbc().queryForObject("SELECT CONNECTION_ID()", Long.class)).isNotEqualTo(readerConnection.get());
                store.appendForTask(task, "worker", 1, new ContextAppend(1, header, List.of(nativeMessage("committed", task, "answer")), null));
                resume.countDown();
                var page = pending.get(5, java.util.concurrent.TimeUnit.SECONDS);
                assertThat(page.headSeq()).isEqualTo(2);
                assertThat(page.entries()).extracting(StoredEntry::seq).containsExactly(1L, 2L);
                assertThat(page.entries().get(1).entry().path("id").asText()).isEqualTo("committed");
            } finally { resume.countDown(); pool.shutdownNow(); }
        }
    }

    @Test void oversizedToolIdentityIsRejectedBeforeAnyEntryInTheBatchIsSaved() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            var oversized = toolMessage("bad-tools", "preceding", "", 1);
            ((com.fasterxml.jackson.databind.node.ObjectNode) oversized.path("message").path("content").get(0)).put("id", "x".repeat(600 * 1024));
            assertThat(JSON.writeValueAsBytes(oversized).length).isLessThan(2 * 1024 * 1024);
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(1, header,
                List.of(nativeMessage("preceding", task, "must rollback"), oversized), null)), "AI_REQUEST_TOO_LARGE");
            assertThat(store.detail("ctx-owner", "ctx-project", conversation).headSeq()).isEqualTo(1);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM agent_conversation_entry", Integer.class)).isEqualTo(1);
        }
    }

    @Test void anIndivisibleToolGroupMustFitOneSerializedHistoryPageBeforeItIsAccepted() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            var many = toolMessage("many-tools", task, "", 5000);
            assertThat(JSON.writeValueAsBytes(many).length).isLessThan(2 * 1024 * 1024);
            assertCode(() -> store.appendForTask(task, "worker", 1, new ContextAppend(1, header, List.of(many), null)), "AI_REQUEST_TOO_LARGE");
            assertThat(store.detail("ctx-owner", "ctx-project", conversation).headSeq()).isEqualTo(1);
        }
    }

    @Test void acceptedToolMetadataAndLongTextAreLosslessAcrossBoundedHistoryPages() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            String text = "😀中文\\\"".repeat(80000);
            var message = toolMessage("tools", task, text, 40);
            var result = JSON.createObjectNode().put("id", "result").put("type", "message").put("timestamp", NOW.toString()).put("parentId", "tools");
            result.putObject("message").put("role", "toolResult").put("toolName", "read_file").put("toolCallId", "tool-0").putObject("details").put("private", "DO_NOT_EXPOSE");
            store.appendForTask(task, "worker", 1, new ContextAppend(1, header, List.of(message, result), null));
            Long before = null; Integer offset = null; int pages = 0;
            var fragments = new java.util.TreeMap<Integer, String>(); var ids = new java.util.HashSet<String>();
            do {
                var history = store.history("ctx-owner", "ctx-project", conversation, before, offset, 2);
                assertThat(JSON.writeValueAsBytes(history).length).isLessThanOrEqualTo(512 * 1024);
                assertThat(JSON.writeValueAsString(history)).doesNotContain("DO_NOT_EXPOSE", "details");
                for (var item : history.items()) {
                    if ("assistant".equals(item.kind())) fragments.put(item.textOffset(), item.text());
                    if ("tool_call".equals(item.kind())) { assertThat(ids.add(item.toolCallId())).isTrue(); assertThat(item.text()).isEqualTo("read_file"); }
                }
                before = history.nextBeforeSeq(); offset = history.nextBeforeOffset();
                assertThat(++pages).isLessThan(100);
            } while (before != null);
            assertThat(String.join("", fragments.values())).isEqualTo(text);
            assertThat(ids).containsExactlyInAnyOrderElementsOf(java.util.stream.IntStream.range(0, 40).mapToObj(i -> "tool-" + i).toList());
        }
    }

    @Test void headerAndDatabaseCreationTimeUseTheSameMicrosecondInstant() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db);
            var ticks = new java.util.concurrent.atomic.AtomicInteger();
            Clock advancing = new Clock() {
                public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
                public Clock withZone(java.time.ZoneId zone) { return this; }
                public Instant instant() { return NOW.plusNanos(123456789L + ticks.getAndIncrement() * 1234567L); }
            };
            var store = new AgentConversationStore(db.jdbc(), new DataSourceTransactionManager(db.jdbc().getDataSource()), advancing, tasks(db));
            String conversation = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            var row = db.jdbc().queryForMap("SELECT header_json,created_at,updated_at FROM agent_conversation WHERE id=?", conversation);
            Instant header = Instant.parse(JSON.readTree((String) row.get("header_json")).path("timestamp").asText());
            Instant created = ((Timestamp) row.get("created_at")).toInstant();
            assertThat(header).isEqualTo(NOW.plusNanos(123456000));
            assertThat(header).isEqualTo(created).isEqualTo(((Timestamp) row.get("updated_at")).toInstant());
        }
    }

    @Test void nativeBlocksKeepOrderAndLengthFlagsWithoutExposingPrivateMetadata() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            var first = JSON.createObjectNode().put("id", "ordered").put("type", "message").put("parentId", task).put("timestamp", NOW.toString());
            var message = first.putObject("message").put("role", "assistant").put("stopReason", "length").put("signature", "PRIVATE_SIGNATURE");
            var content = message.putArray("content");
            content.addObject().put("type", "thinking").put("thinking", "a").put("thinkingSignature", "PRIVATE_SIGNATURE");
            content.addObject().put("type", "text").put("text", "b");
            content.addObject().put("type", "thinking").put("thinking", "c");
            content.addObject().put("type", "toolCall").put("id", "t").put("name", "read_file").put("arguments", "PRIVATE_ARGS");
            content.addObject().put("type", "text").put("text", "d");
            var last = nativeMessage("final", "ordered", "final");
            ((com.fasterxml.jackson.databind.node.ObjectNode) last.path("message")).put("stopReason", "length");
            store.appendForTask(task, "worker", 1, new ContextAppend(1, header, List.of(first, last), null));
            var page = store.history("ctx-owner", "ctx-project", conversation, null, 50);
            var rows = page.items().stream().filter(i -> i.seq() == 2).toList();
            assertThat(rows).extracting(HistoryItem::kind).containsExactly("thinking", "assistant", "thinking", "tool_call", "assistant");
            assertThat(rows).extracting(HistoryItem::text).containsExactly("a", "b", "c", "read_file", "d");
            var projected = JSON.valueToTree(rows);
            assertThat(projected.findValues("contentIndex")).extracting(n -> n.intValue()).containsExactly(0, 1, 2, 3, 4);
            assertThat(projected.findValues("modelTruncated")).extracting(n -> n.booleanValue()).containsOnly(true);
            assertThat(JSON.valueToTree(page).path("items").get(6).path("modelTruncated").asBoolean()).isTrue();
            assertThat(JSON.writeValueAsString(page)).doesNotContain("PRIVATE_SIGNATURE", "PRIVATE_ARGS", "signature", "arguments");
        }
    }

    @Test void differentLengthNativeBlocksAndEmojiFencesReassembleAcrossGroupedPages() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db); var store = conversations(db);
            String conversation = UUID.randomUUID().toString(), task = UUID.randomUUID().toString();
            store.create("ctx-owner", "ctx-project", new CreateConversationRequest(conversation));
            tasks(db).createTask("ctx-owner", "ctx-project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var header = store.readForTask(task, "worker", 1, 0, null).header();
            String thought = "😀中".repeat(25000), answer = "~~~java\n" + "😀\"\\".repeat(30000) + "\n~~~";
            var entry = nativeMessage("long-blocks", task, "unused");
            var message = (com.fasterxml.jackson.databind.node.ObjectNode) entry.path("message");
            message.put("stopReason", "stop");
            var content = message.putArray("content");
            content.addObject().put("type", "thinking").put("thinking", thought);
            content.addObject().put("type", "text").put("text", answer);
            content.addObject().put("type", "thinking").put("thinking", "short");
            content.addObject().put("type", "redacted_thinking").put("data", "PRIVATE_ENCRYPTED");
            content.addObject().put("type", "thinking").put("thinking", "PRIVATE_REDACTED").put("redacted", true);
            content.addObject().put("type", "thinking").put("encrypted", "PRIVATE_ENCRYPTED");
            store.appendForTask(task, "worker", 1, new ContextAppend(1, header, List.of(entry), null));
            var pieces = new java.util.TreeMap<Integer, java.util.TreeMap<Integer, String>>();
            Long before = null; Integer offset = null; int pages = 0;
            do {
                var page = store.history("ctx-owner", "ctx-project", conversation, before, offset, 1);
                assertThat(JSON.writeValueAsBytes(page).length).isLessThanOrEqualTo(512 * 1024);
                assertThat(JSON.writeValueAsString(page)).doesNotContain("PRIVATE_");
                for (var item : page.items()) if (item.seq() == 2) {
                    var node = JSON.valueToTree(item);
                    pieces.computeIfAbsent(node.path("contentIndex").asInt(), ignored -> new java.util.TreeMap<>()).put(item.textOffset(), item.text());
                    assertThat(item.text().getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isLessThanOrEqualTo(64 * 1024);
                    assertThat(Character.isLowSurrogate(item.text().charAt(0))).isFalse();
                    assertThat(Character.isHighSurrogate(item.text().charAt(item.text().length() - 1))).isFalse();
                }
                before = page.nextBeforeSeq(); offset = page.nextBeforeOffset();
                assertThat(++pages).isLessThan(50);
            } while (before != null);
            assertThat(pieces.keySet()).containsExactly(0, 1, 2, 3, 4, 5);
            assertThat(String.join("", pieces.get(0).values())).isEqualTo(thought);
            assertThat(String.join("", pieces.get(1).values())).isEqualTo(answer);
            assertThat(String.join("", pieces.get(2).values())).isEqualTo("short");
            for (int i = 3; i <= 5; i++) assertThat(String.join("", pieces.get(i).values())).isEqualTo("该段推理未提供可展示文本");
        }
    }

    private static com.fasterxml.jackson.databind.JsonNode toolMessage(String id, String parent, String text, int calls) {
        var entry = JSON.createObjectNode().put("id", id).put("type", "message").put("timestamp", NOW.toString()).put("parentId", parent);
        var content = entry.putObject("message").put("role", "assistant").putArray("content");
        if (!text.isEmpty()) content.addObject().put("type", "text").put("text", text);
        for (int i = 0; i < calls; i++) content.addObject().put("type", "toolCall").put("id", "tool-" + i).put("name", "read_file").putObject("arguments").put("path", "file");
        return entry;
    }

    /** Only the pause is mocked: all SQL, locks, commits and returned behavior use real MySQL connections. */
    private static AgentConversationStore pausedAfterTaskLookup(JdbcStoreTestSupport db, String task,
            java.util.concurrent.CountDownLatch read, java.util.concurrent.CountDownLatch resume,
            java.util.concurrent.atomic.AtomicReference<Long> connection) {
        var jdbc = org.mockito.Mockito.spy(db.jdbc());
        org.mockito.Mockito.doAnswer(invocation -> {
            var answer = invocation.callRealMethod();
            connection.set(jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class));
            read.countDown();
            if (!resume.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("concurrent commit did not finish");
            return answer;
        }).when(jdbc).query(org.mockito.ArgumentMatchers.eq("SELECT project_id FROM agent_task WHERE id=?"),
            org.mockito.ArgumentMatchers.<org.springframework.jdbc.core.RowMapper<String>>any(), org.mockito.ArgumentMatchers.eq(task));
        return new AgentConversationStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.fixed(NOW, ZoneOffset.UTC), tasks(db));
    }

    private static void seed(JdbcStoreTestSupport db) {
        var now = Timestamp.from(NOW);
        db.jdbc().update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('ctx-owner','ctx-owner','unused',?)", now);
        db.jdbc().update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('ctx-project','ctx-owner','ctx','READY',7,?,?)", now, now);
    }
    private static AgentTaskStore tasks(JdbcStoreTestSupport db) {
        return new AgentTaskStore(db.jdbc(), new DataSourceTransactionManager(db.jdbc().getDataSource()), Clock.fixed(NOW, ZoneOffset.UTC));
    }
    private static AgentConversationStore conversations(JdbcStoreTestSupport db) {
        return new AgentConversationStore(db.jdbc(), new DataSourceTransactionManager(db.jdbc().getDataSource()), Clock.fixed(NOW, ZoneOffset.UTC), tasks(db));
    }
    private static void assertCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo(code));
    }
    @Test void conversationSchemaIsAdditiveAndProjectScoped() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = Timestamp.from(Instant.parse("2026-10-19T00:00:00Z"));
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('ctx-owner','ctx-owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('ctx-project','ctx-owner','ctx','READY',7,?,?)", now, now);
            jdbc.update("INSERT INTO agent_conversation(id,project_id,title,header_json,head_seq,created_at,updated_at) VALUES (?,?,?,?,0,?,?)",
                "00000000-0000-4000-8000-000000000001", "ctx-project", "新会话",
                "{\"type\":\"session\",\"version\":3,\"id\":\"00000000-0000-4000-8000-000000000001\",\"cwd\":\"manao-project\",\"timestamp\":\"2026-10-19T00:00:00Z\"}", now, now);
            assertThat(jdbc.queryForObject("SELECT head_seq FROM agent_conversation WHERE project_id='ctx-project'", Long.class)).isZero();
            jdbc.update("DELETE FROM project WHERE id='ctx-project'");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation", Integer.class)).isZero();
        }
    }
}
