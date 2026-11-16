package com.manao.poc4.share;

import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.log.RunLogWindow;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import org.springframework.jdbc.core.JdbcTemplate;

final class RunShareTestFixtures {
    private RunShareTestFixtures() {}

    static void seedFinishedRun(JdbcTemplate jdbc, String text) {
        seedFinishedRun(jdbc, "owner", "project", "run", text);
    }

    static void seedFinishedRun(JdbcTemplate jdbc, String owner, String project, String run, String text) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, owner) == 0) {
            jdbc.update("INSERT INTO app_user(id,username,password_hash,enabled,created_at) "
                + "VALUES (?,?,'hash',TRUE,UTC_TIMESTAMP(6))", owner, owner);
        }
        jdbc.update("INSERT INTO project(id,owner_id,name,state,created_at,updated_at) "
            + "VALUES (?,?,?,'READY',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))", project, owner, "原项目" + project);
        jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,created_at,started_at,"
                + "finished_at,exit_code,termination_reason,updated_at,fencing_token) VALUES (?,?,0,'SUCCEEDED',?,"
                + "?,?,?,0,'BUILD_SUCCEEDED',UTC_TIMESTAMP(6),1)",
            run, project, "{\"runtime\":{\"javaMajor\":17,\"mavenMajor\":3},\"executionKind\":\"TASK\"}",
            Timestamp.from(Instant.parse("2026-01-01T00:00:00Z")),
            Timestamp.from(Instant.parse("2026-01-01T00:00:01Z")),
            Timestamp.from(Instant.parse("2026-01-01T00:00:02Z")));
        if (!text.isEmpty()) {
            new JdbcLogStore(jdbc).insertChunk(run, new RunLogWindow.Chunk(1, text,
                text.getBytes(StandardCharsets.UTF_8).length, Instant.parse("2026-01-01T00:00:02Z")));
        }
    }
}
