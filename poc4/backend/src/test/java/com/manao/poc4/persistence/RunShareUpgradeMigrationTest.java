package com.manao.poc4.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RunShareUpgradeMigrationTest {
    @Test
    void version21UpgradePreservesUsersProjectsRunsLogsAndMigrationChecksums() {
        try (var db = JdbcStoreTestSupport.createAtVersion("21")) {
            var jdbc = db.jdbc();
            var now = Timestamp.from(Instant.parse("2026-11-16T00:00:00Z"));
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','share-upgrade','preserved',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','原项目','READY',3,?,?)", now, now);
            jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,fencing_token,created_at,updated_at) VALUES ('run','project',3,'SUCCEEDED',?,1,?,?)",
                "{\"runtime\":{\"javaMajor\":17,\"mavenMajor\":3},\"executionKind\":\"TASK\"}", now, now);
            jdbc.update("INSERT INTO run_log_chunk(run_id,seq,text_utf8,byte_length,created_at) VALUES ('run',1,' preserved\n',11,?)", now);
            var tables = List.of("app_user", "project", "run", "run_log_chunk");
            Map<String, List<Map<String, Object>>> before = new LinkedHashMap<>();
            for (String table : tables) before.put(table, jdbc.queryForList("SELECT * FROM " + table));
            var history = jdbc.queryForList("SELECT version,checksum FROM flyway_schema_history ORDER BY installed_rank");

            db.migrateToLatest();

            for (String table : tables) assertThat(jdbc.queryForList("SELECT * FROM " + table)).isEqualTo(before.get(table));
            assertThat(jdbc.queryForList("SELECT version,checksum FROM flyway_schema_history WHERE CAST(version AS UNSIGNED) <= 21 ORDER BY installed_rank"))
                .isEqualTo(history);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM flyway_schema_history WHERE version='22' AND success=1", Integer.class)).isEqualTo(1);
        }
    }
}
