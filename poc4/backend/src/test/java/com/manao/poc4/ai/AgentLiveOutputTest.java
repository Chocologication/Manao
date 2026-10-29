package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class AgentLiveOutputTest {
    @Test void terminalTailExpiresFromDurableTerminalTimeAndOldTasksCannotOccupyConnections() throws Exception {
        try (var f = new AgentLiveOutputHttpTest.Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(204);
            f.tasks.applyTerminal(f.task, AgentContracts.TaskState.COMPLETED, "done", null);
            f.db.jdbc().update("UPDATE agent_task SET updated_at=? WHERE id=?",
                java.sql.Timestamp.from(java.time.Instant.now().minusSeconds(61)), f.task);
            assertThat(f.post(f.task, f.snapshot(2), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.get(f.livePath(), f.token).statusCode()).isEqualTo(204);
            assertThat(f.live().diagnostics().cachedTasks()).isZero();
            assertThat(f.live().diagnostics().resources()).isZero();
            String active = java.util.UUID.randomUUID().toString();
            f.tasks.createTask("owner", "project", new AgentContracts.TaskRequest(active, "new", 7), f.conversation);
            var empty = f.stream(f.livePath().replace(f.task, active));
            try (var body = empty.body()) { assertThat(AgentLiveOutputHttpTest.firstFrame(body)).contains(":heartbeat"); }
        }
    }

    @Test void cachedSnapshotNeverBypassesWorkerIdentityOrTaskConversationValidation() throws Exception {
        try (var f = new AgentLiveOutputHttpTest.Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.post(f.task, f.snapshot(2), true, "old-worker", "1").statusCode()).isEqualTo(409);
            assertThat(f.post(f.task, f.snapshot(2), true, "worker", "0").statusCode()).isEqualTo(409);
            assertThat(f.post(f.task, f.snapshot(2).replace(f.task, java.util.UUID.randomUUID().toString()), true, "worker", "1").statusCode()).isEqualTo(409);
            assertThat(f.post(f.task, f.snapshot(2).replace("\"kind\":\"text\"", "\"kind\":\"signature\""), true, "worker", "1").statusCode()).isEqualTo(422);
            assertThat(f.post(f.task, "x".repeat(513 * 1024), true, "worker", "1").statusCode()).isEqualTo(413);
            assertThat(f.tasks.findForOwner("owner", "project", f.task).orElseThrow().progress()).isEmpty();
        }
    }
    @Test void staleRevisionCannotReplaceNewestAndEqualRevisionCannotChangePayload() throws Exception {
        try (var f = new AgentLiveOutputHttpTest.Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(2), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.post(f.task, f.snapshot(1).replace("hello", "older"), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.post(f.task, f.snapshot(2), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.post(f.task, f.snapshot(2).replace("hello", "different"), true, "worker", "1").statusCode()).isEqualTo(409);
            try (var body = f.stream(f.livePath()).body()) {
                assertThat(AgentLiveOutputHttpTest.firstFrame(body)).contains("\"revision\":2", "hello").doesNotContain("older");
            }
        }
    }

    @Test void finalSerializedJsonLimitIncludesEscapesAndMetadataAndRejectsWrongConversation() throws Exception {
        try (var f = new AgentLiveOutputHttpTest.Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(1).replace(f.conversation, java.util.UUID.randomUUID().toString()), true, "worker", "1").statusCode()).isEqualTo(409);
            int overhead = f.snapshot(1).getBytes(java.nio.charset.StandardCharsets.UTF_8).length - 5;
            String exact = f.snapshot(1).replace("hello", "x".repeat(256 * 1024 - overhead));
            assertThat(f.post(f.task, exact, true, "worker", "1").statusCode()).isEqualTo(204);
            String oneByteOver = f.snapshot(2).replace("hello", "x".repeat(256 * 1024 - overhead + 1));
            assertThat(f.post(f.task, oneByteOver, true, "worker", "1").statusCode()).isEqualTo(413);
            String escaped = f.snapshot(2).replace("hello", "\\\"".repeat(140000));
            assertThat(f.post(f.task, escaped, true, "worker", "1").statusCode()).isEqualTo(413);
        }
    }
}
