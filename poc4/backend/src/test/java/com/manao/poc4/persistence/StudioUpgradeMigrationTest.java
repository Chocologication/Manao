package com.manao.poc4.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class StudioUpgradeMigrationTest {
    @Test
    void version20UpgradePreservesAccountsProjectsConversationsAttachmentsAndEnvironment() throws Exception {
        try (var database = JdbcStoreTestSupport.createAtVersion("20")) {
            var jdbc = database.jdbc();
            String owner = UUID.randomUUID().toString();
            String project = UUID.randomUUID().toString();
            String conversation = UUID.randomUUID().toString();
            String attachment = UUID.randomUUID().toString();
            var now = Timestamp.from(Instant.parse("2026-11-05T00:00:00Z"));
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,?,?)",
                owner, "upgrade-owner", "preserved-hash", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,?,?,'READY',7,?,?)",
                project, owner, "preserved-project", now, now);
            jdbc.update("INSERT INTO agent_conversation(id,project_id,title,header_json,head_seq,created_at,updated_at) VALUES (?,?,?,'{}',1,?,?)",
                conversation, project, "preserved-conversation", now, now);
            jdbc.update("INSERT INTO agent_conversation_entry(conversation_id,seq,entry_id,writer_id,payload_json) VALUES (?,1,?,?,'{\"message\":\"preserved\"}')",
                conversation, UUID.randomUUID().toString(), owner);
            jdbc.update("INSERT INTO agent_attachment(id,project_id,conversation_id,file_name,mime_type,size_bytes,sha256,uploaded_at,expires_at,state) VALUES (?,?,?,'original.png','image/png',3,?,?,?,'READY')",
                attachment, project, conversation, "a".repeat(64), now,
                Timestamp.from(now.toInstant().plusSeconds(86400)));
            var environment = com.manao.poc4.ai.AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(
                java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
            jdbc.update("INSERT INTO agent_task(id,project_id,owner_id,request_sha256,prompt,state,worker_epoch,workspace_revision,created_at,updated_at,environment_json,environment_sha256) VALUES (?,?,?,?,?,'COMPLETED',1,7,?,?,?,?)",
                UUID.randomUUID().toString(), project, owner, "b".repeat(64), "preserved task", now, now,
                environment.canonicalJson(), environment.sha256());

            var tables = List.of("app_user", "project", "agent_conversation", "agent_conversation_entry", "agent_attachment", "agent_task");
            Map<String, List<Map<String, Object>>> before = new LinkedHashMap<>();
            for (String table : tables) before.put(table, jdbc.queryForList("SELECT * FROM " + table));
            var history = jdbc.queryForList("SELECT version,checksum,success FROM flyway_schema_history ORDER BY installed_rank");

            database.migrateToLatest();

            for (String table : tables) assertThat(jdbc.queryForList("SELECT * FROM " + table)).isEqualTo(before.get(table));
            assertThat(jdbc.queryForList("SELECT version,checksum,success FROM flyway_schema_history WHERE version <> '21' ORDER BY installed_rank"))
                .isEqualTo(history);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM flyway_schema_history WHERE version='21' AND success=1", Integer.class)).isEqualTo(1);
            for (String table : List.of("assistant_model", "assistant_conversation", "assistant_turn", "assistant_attachment", "assistant_task_options")) {
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class)).isZero();
            }
        }
    }
}
