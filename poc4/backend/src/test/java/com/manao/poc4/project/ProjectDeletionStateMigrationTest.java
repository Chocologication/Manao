package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

class ProjectDeletionStateMigrationTest {
    private static final Instant NOW = Instant.parse("2026-09-10T00:00:00Z");

    @Test
    void acceptsDeletingAndRejectsUnknownState() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            insertOwner(jdbc, "owner-a", "cleanup-a");
            insertProject(jdbc, "project-a", "owner-a", "cleanup-state", "READY");
            assertThatCode(() -> jdbc.update("UPDATE project SET state='DELETING' WHERE id=?", "project-a"))
                .doesNotThrowAnyException();
            assertProjectStateCheckRejected(
                () -> jdbc.update("UPDATE project SET state='UNKNOWN' WHERE id=?", "project-a"));
        }
    }

    @Test
    void upgradesV7ProjectsToDeletingWithoutChangingExistingRows() {
        try (var db = JdbcStoreTestSupport.createAtVersion("7")) {
            JdbcTemplate jdbc = db.jdbc();
            insertOwner(jdbc, "owner-a", "cleanup-a");
            insertProject(jdbc, "ready-a", "owner-a", "ready", "READY");
            insertProject(jdbc, "failed-a", "owner-a", "failed", "FAILED");
            insertProject(jdbc, "creating-a", "owner-a", "creating", "CREATING");
            jdbc.update("""
                INSERT INTO workspace_operation(
                    id, project_id, expected_revision, before_sha256, after_sha256,
                    receipt_path, receipt_sha256, state, created_at)
                VALUES (?, ?, 0, ?, ?, ?, ?, 'PENDING', ?)
                """,
                "op-ready-a", "ready-a", "a".repeat(64), "b".repeat(64),
                "receipts/ready-a", "c".repeat(64), Timestamp.from(NOW));

            Integer projectCount = jdbc.queryForObject("SELECT COUNT(*) FROM project", Integer.class);
            Integer operationCount = jdbc.queryForObject("SELECT COUNT(*) FROM workspace_operation", Integer.class);
            Long readyRevision = jdbc.queryForObject(
                "SELECT workspace_revision FROM project WHERE id=?", Long.class, "ready-a");
            assertThat(jdbc.queryForObject(
                "SELECT version FROM flyway_schema_history WHERE success=1 ORDER BY installed_rank DESC LIMIT 1",
                String.class)).isEqualTo("7");

            db.migrateToLatest();

            assertThat(jdbc.queryForObject(
                "SELECT version FROM flyway_schema_history WHERE success=1 ORDER BY installed_rank DESC LIMIT 1",
                String.class)).isEqualTo("8");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM project", Integer.class)).isEqualTo(projectCount);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM workspace_operation", Integer.class))
                .isEqualTo(operationCount);
            assertThat(jdbc.queryForObject(
                "SELECT workspace_revision FROM project WHERE id=?", Long.class, "ready-a")).isEqualTo(readyRevision);
            assertThat(jdbc.queryForObject("SELECT state FROM project WHERE id=?", String.class, "ready-a"))
                .isEqualTo("READY");
            assertThat(jdbc.queryForObject("SELECT state FROM project WHERE id=?", String.class, "failed-a"))
                .isEqualTo("FAILED");
            assertThat(jdbc.queryForObject("SELECT state FROM project WHERE id=?", String.class, "creating-a"))
                .isEqualTo("CREATING");
            assertThat(jdbc.queryForObject(
                "SELECT state FROM workspace_operation WHERE id=?", String.class, "op-ready-a"))
                .isEqualTo("PENDING");
            assertThatCode(() -> jdbc.update("UPDATE project SET state='DELETING' WHERE id=?", "failed-a"))
                .doesNotThrowAnyException();
            assertThat(jdbc.queryForObject("SELECT state FROM project WHERE id=?", String.class, "failed-a"))
                .isEqualTo("DELETING");
        }
    }

    private static void assertProjectStateCheckRejected(ThrowingCallable update) {
        assertThatThrownBy(update)
            .isInstanceOf(DataAccessException.class)
            .hasRootCauseInstanceOf(SQLException.class)
            .matches(ex -> isProjectStateCheckViolation(ex));
    }

    private static boolean isProjectStateCheckViolation(Throwable thrown) {
        for (Throwable current = thrown; current != null; current = current.getCause()) {
            if (current instanceof SQLException sql
                && sql.getErrorCode() == 3819
                && sql.getMessage() != null
                && sql.getMessage().contains("ck_project_state")) {
                return true;
            }
        }
        return false;
    }

    private static void insertOwner(JdbcTemplate jdbc, String id, String username) {
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            id, username, "not-an-auth-credential", Timestamp.from(NOW));
    }

    private static void insertProject(JdbcTemplate jdbc, String id, String ownerId, String name, String state) {
        jdbc.update(
            "INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
            id, ownerId, name, state, Timestamp.from(NOW), Timestamp.from(NOW));
    }
}
