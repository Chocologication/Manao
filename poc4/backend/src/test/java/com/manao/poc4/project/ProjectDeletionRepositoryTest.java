package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class ProjectDeletionRepositoryTest {
    private static final Instant NOW = Instant.parse("2026-09-10T00:00:00Z");

    @Test
    void disconnectedRepositoryDoesNotCallBegin() {
        ProjectDeletionRepository repo = new ProjectDeletionRepository();
        assertThatThrownBy(() -> repo.inspect("owner-a", "p1"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("not connected");
        assertThatThrownBy(() -> repo.begin("owner-a", "p1"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("not connected");
    }

    @Test
    void readyBecomesDeletingAndCreatingStaysUntouched() {
        try (var db = JdbcStoreTestSupport.create()) {
            ProjectDeletionRepository repo = new ProjectDeletionRepository(db.jdbc(),
                new DataSourceTransactionManager(db.jdbc().getDataSource()));
            String ready = seed(db, "owner-a", "ready", "READY");
            String creating = seed(db, "owner-a", "creating", "CREATING");
            String other = seed(db, "owner-b", "other", "READY");

            assertThat(repo.inspect("owner-a", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.STARTED);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, ready))
                .isEqualTo("READY");
            assertThat(repo.begin("owner-a", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.STARTED);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, ready))
                .isEqualTo("DELETING");
            assertThat(repo.begin("owner-a", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.RESUMED);
            assertThat(repo.begin("owner-a", creating)).isEqualTo(ProjectDeletionRepository.BeginDeletion.CREATING);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, creating))
                .isEqualTo("CREATING");
            assertThat(repo.begin("owner-b", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.NOT_FOUND);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, other))
                .isEqualTo("READY");
        }
    }

    @Test
    void pendingReadyIsBusyButFailedPendingCanStart() {
        try (var db = JdbcStoreTestSupport.create()) {
            ProjectDeletionRepository repo = new ProjectDeletionRepository(db.jdbc(),
                new DataSourceTransactionManager(db.jdbc().getDataSource()));
            String ready = seed(db, "owner-a", "ready-pending", "READY");
            String failed = seed(db, "owner-a", "failed-pending", "FAILED");
            insertPending(db, ready, "op-ready");
            insertPending(db, failed, "op-failed");

            assertThat(repo.begin("owner-a", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.BUSY);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, ready))
                .isEqualTo("READY");
            assertThat(repo.begin("owner-a", failed)).isEqualTo(ProjectDeletionRepository.BeginDeletion.STARTED);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, failed))
                .isEqualTo("DELETING");
        }
    }

    @Test
    void activeRunBlocksDeletionWithoutChangingState() {
        try (var db = JdbcStoreTestSupport.create()) {
            ProjectDeletionRepository repo = new ProjectDeletionRepository(db.jdbc(),
                new DataSourceTransactionManager(db.jdbc().getDataSource()));
            String ready = seed(db, "owner-a", "active", "READY");
            insertRun(db, ready, "run-active", "RUNNING");

            assertThat(repo.begin("owner-a", ready)).isEqualTo(ProjectDeletionRepository.BeginDeletion.ACTIVE_RUN);
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, ready))
                .isEqualTo("READY");
        }
    }

    @Test
    void runIdsAreOwnerScopedAndOnlyReturnedForDeletingProjects() {
        try (var db = JdbcStoreTestSupport.create()) {
            ProjectDeletionRepository repo = new ProjectDeletionRepository(db.jdbc(),
                new DataSourceTransactionManager(db.jdbc().getDataSource()));
            String ready = seed(db, "owner-a", "ready-runs", "READY");
            String deleting = seed(db, "owner-a", "deleting-runs", "DELETING");
            insertRun(db, ready, "run-ready", "SUCCEEDED");
            insertRun(db, deleting, "run-deleting", "SUCCEEDED");

            assertThat(repo.runIds("owner-a", ready)).isEmpty();
            assertThat(repo.runIds("owner-a", deleting)).containsExactly("run-deleting");
            assertThat(repo.runIds("owner-b", deleting)).isEmpty();
        }
    }

    @Test
    void deleteProjectRemovesOnlyTheOwnersDeletingRowAndRelatedRecords() {
        try (var db = JdbcStoreTestSupport.create()) {
            String deleting = seed(db, "owner-a", "to-delete", "DELETING");
            String other = seed(db, "owner-b", "keep", "READY");
            insertRun(db, deleting, "run-delete", "SUCCEEDED");
            insertPending(db, deleting, "op-delete");
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(db.jdbc(),
                new DataSourceTransactionManager(db.jdbc().getDataSource()));

            assertThat(store.deleteProject("owner-a", deleting)).isTrue();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM project WHERE id=?", Integer.class, deleting))
                .isZero();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run WHERE project_id=?", Integer.class, deleting))
                .isZero();
            assertThat(db.jdbc().queryForObject(
                "SELECT COUNT(*) FROM workspace_operation WHERE project_id=?", Integer.class, deleting)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, other))
                .isEqualTo("READY");
            assertThat(store.deleteProject("owner-a", other)).isFalse();
        }
    }

    @Test
    void deleteProjectRollsBackWhenARelatedTableDeleteFails() {
        try (var db = JdbcStoreTestSupport.create()) {
            String deleting = seed(db, "owner-a", "rollback", "DELETING");
            insertRun(db, deleting, "run-rollback", "SUCCEEDED");
            insertPending(db, deleting, "op-rollback");
            JdbcTemplate failing = new JdbcTemplate(db.jdbc().getDataSource()) {
                @Override public int update(String sql, @org.springframework.lang.Nullable Object... args) {
                    if (sql.contains("DELETE FROM run WHERE")) {
                        throw new IllegalStateException("injected-run-delete");
                    }
                    return super.update(sql, args);
                }
            };
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(failing,
                new DataSourceTransactionManager(db.jdbc().getDataSource()));

            assertThatThrownBy(() -> store.deleteProject("owner-a", deleting))
                .isInstanceOf(RuntimeException.class);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM project WHERE id=?", Integer.class, deleting))
                .isEqualTo(1);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run WHERE project_id=?", Integer.class, deleting))
                .isEqualTo(1);
            assertThat(db.jdbc().queryForObject(
                "SELECT COUNT(*) FROM workspace_operation WHERE project_id=?", Integer.class, deleting)).isEqualTo(1);
        }
    }

    private static String seed(JdbcStoreTestSupport db, String ownerId, String name, String state) {
        String projectId = name + "-" + UUID.randomUUID();
        Timestamp now = Timestamp.from(NOW);
        if (db.jdbc().queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?", Integer.class, ownerId) == 0) {
            db.jdbc().update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
                ownerId, ownerId, "not-an-auth-credential", now);
        }
        db.jdbc().update(
            "INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
            projectId, ownerId, name, state, now, now);
        return projectId;
    }

    private static void insertRun(JdbcStoreTestSupport db, String projectId, String runId, String state) {
        Timestamp now = Timestamp.from(NOW);
        db.jdbc().update("""
            INSERT INTO run(id, project_id, requested_revision, state, policy_json, version,
                created_at, updated_at, fencing_token)
            VALUES (?, ?, 0, ?, '{}', 0, ?, ?, 1)
            """,
            runId, projectId, state, now, now);
    }

    private static void insertPending(JdbcStoreTestSupport db, String projectId, String operationId) {
        db.jdbc().update("""
            INSERT INTO workspace_operation(
                id, project_id, expected_revision, before_sha256, after_sha256,
                receipt_path, receipt_sha256, state, created_at)
            VALUES (?, ?, 0, ?, ?, ?, ?, 'PENDING', ?)
            """,
            operationId + "-" + projectId, projectId, "a".repeat(64), "b".repeat(64),
            "receipts/" + operationId, "c".repeat(64), Timestamp.from(NOW));
    }
}
