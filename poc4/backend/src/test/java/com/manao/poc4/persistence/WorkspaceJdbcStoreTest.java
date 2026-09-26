package com.manao.poc4.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceStore;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * Real-MySQL behavioural tests for {@link WorkspaceJdbcStore} commit atomicity: a conditional
 * commit that moves one row but not the other must persist NOTHING — the reconciled dependency
 * commit in particular must never leave an operation COMMITTED without its revision or its
 * failure recovery.
 */
class WorkspaceJdbcStoreTest {
    private static final Instant NOW = Instant.parse("2026-09-01T00:00:00Z");
    static JdbcStoreTestSupport db;
    JdbcTemplate jdbc;
    WorkspaceJdbcStore store;

    @BeforeAll
    static void up() {
        db = JdbcStoreTestSupport.create();
    }

    @AfterAll
    static void down() {
        db.close();
    }

    @BeforeEach
    void seedStore() {
        jdbc = db.jdbc();
        store = new WorkspaceJdbcStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    @Test
    void conditionalCommitThatMovesOnlyOneRowPersistsNothing() {
        String projectId = seedProject("atomic-file", 7, null, null);
        String operationId = UUID.randomUUID().toString();
        assertThat(store.beginPendingOperation(projectId, 7, fileOperation(operationId, projectId, 7)).started())
            .isTrue();
        // Simulate an external revision move so the operation matches but the project does not.
        db.jdbc().update("UPDATE project SET workspace_revision = 8 WHERE id = ?", projectId);

        assertThat(store.commitOperation(operationId, projectId, 7)).isFalse();

        // The half-applied commit must roll back: the operation stays PENDING, nothing advanced.
        assertThat(operationState(operationId)).isEqualTo("PENDING");
        assertThat(revisionOf(projectId)).isEqualTo(8);
    }

    @Test
    void reconciledCommitThatMovesOnlyOneRowPersistsNothingAndKeepsTheFailure() {
        String projectId = seedProject("atomic-deps", 7, "FAILED", "WORKSPACE_RECONCILIATION_REQUIRED");
        String operationId = seedDependencyOperation(projectId, 7);
        db.jdbc().update("UPDATE project SET workspace_revision = 8 WHERE id = ?", projectId);

        assertThat(store.commitReconciledOperation(operationId, projectId, 7)).isFalse();

        assertThat(operationState(operationId)).isEqualTo("PENDING");
        assertThat(revisionOf(projectId)).isEqualTo(8);
        assertThat(projectState(projectId, "failure_reason")).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(projectState(projectId, "state")).isEqualTo("FAILED");
    }

    @Test
    void reconciledCommitRefusesCreatingProjectsAndPreservesProvisioningSemantics() {
        // A CREATING project is never reconciled: only READY or exactly this reconciliation failure.
        String creatingProject = seedProject("atomic-creating", 0, "CREATING", null);
        String pendingDependency = seedDependencyOperation(creatingProject, 0);
        assertThat(store.commitReconciledOperation(pendingDependency, creatingProject, 0)).isFalse();
        assertThat(operationState(pendingDependency)).isEqualTo("PENDING");
        assertThat(projectState(creatingProject, "state")).isEqualTo("CREATING");
        assertThat(revisionOf(creatingProject)).isEqualTo(0);

        // Normal provisioning commits on CREATING keep working untouched (own project: the
        // single pending slot of the first one is still occupied by the refused operation).
        String provisioningProject = seedProject("atomic-provisioning", 0, "CREATING", null);
        String fileOperation = UUID.randomUUID().toString();
        assertThat(store.beginPendingOperation(provisioningProject, 0, fileOperation(fileOperation, provisioningProject, 0)).started())
            .isTrue();
        assertThat(store.commitOperation(fileOperation, provisioningProject, 0)).isTrue();
        assertThat(operationState(fileOperation)).isEqualTo("COMMITTED");
        assertThat(revisionOf(provisioningProject)).isEqualTo(1);
    }

    private WorkspaceStore.OperationRecord fileOperation(String operationId, String projectId, long expectedRevision) {
        return new WorkspaceStore.OperationRecord(operationId, projectId, expectedRevision,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + operationId + ".json", "c".repeat(64));
    }

    private String seedDependencyOperation(String projectId, long expectedRevision) {
        String operationId = UUID.randomUUID().toString();
        // Inserted directly, as the row exists after a crash: beginPendingOperation only
        // registers on READY/CREATING, but a project can fail while a row is already pending.
        jdbc.update("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, operation_kind, request_sha256, created_at)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PYTHON_DEPENDENCIES', ?, ?)",
            operationId, projectId, expectedRevision, "a".repeat(64), "b".repeat(64),
            ".manao/receipts/" + operationId + ".json", "c".repeat(64), "1".repeat(64), Timestamp.from(NOW));
        return operationId;
    }

    private String seedProject(String name, long revision, String state, String failureReason) {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        db.jdbc().update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)",
            userId, "owner-" + name, Timestamp.from(NOW));
        db.jdbc().update("INSERT INTO project(id, owner_id, name, state, workspace_revision, failure_reason, created_at, updated_at)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            projectId, userId, name, state == null ? "READY" : state, revision, failureReason,
            Timestamp.from(NOW), Timestamp.from(NOW));
        return projectId;
    }

    private String operationState(String operationId) {
        return db.jdbc().queryForObject("SELECT state FROM workspace_operation WHERE id = ?", String.class, operationId);
    }

    private long revisionOf(String projectId) {
        return db.jdbc().queryForObject("SELECT workspace_revision FROM project WHERE id = ?", Long.class, projectId);
    }

    private String projectState(String projectId, String column) {
        return db.jdbc().queryForObject("SELECT " + column + " FROM project WHERE id = ?", String.class, projectId);
    }
}
