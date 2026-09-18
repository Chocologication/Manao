package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.JdbcRunStore;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.StubAgent;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.recovery.ProjectRecoveryService;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class ProjectMutationDeletionConcurrencyTest {
    private static final Instant NOW = Instant.parse("2026-09-10T00:00:00Z");

    @Test
    void deletingProjectRejectsLateRunInsertAndLeavesNoRunRow() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            String projectId = seedReadyProject(db, "owner-a", "late-run");
            JdbcRunStore runs = runStore(db);
            long token = runs.acquireFencingToken().orElseThrow();
            db.jdbc().update("UPDATE project SET state='DELETING' WHERE id=?", projectId);
            assertThat(runs.insertRun(startingRun("run-late", projectId, token), token))
                .isEqualTo(RunStore.InsertResult.PROJECT_LOCKED);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run WHERE project_id=?", Integer.class, projectId))
                .isZero();
        }
    }

    @Test
    void committedActiveRunIsVisibleToDeletionEligibility() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            String projectId = seedReadyProject(db, "owner-a", "active-run");
            JdbcRunStore runs = runStore(db);
            long token = runs.acquireFencingToken().orElseThrow();
            assertThat(runs.insertRun(startingRun("run-active", projectId, token), token))
                .isEqualTo(RunStore.InsertResult.INSERTED);
            DataSource dataSource = db.jdbc().getDataSource();
            try (Connection connection = dataSource.getConnection()) {
                connection.setAutoCommit(false);
                assertThat(projectState(connection, projectId)).isEqualTo("READY");
                assertThat(activeRunCount(connection, projectId)).isEqualTo(1);
                connection.commit();
            }
        }
    }

    @Test
    void pendingWriteBlocksReadyDeletionAndDeletingBlocksNewPending() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            String projectId = seedReadyProject(db, "owner-a", "pending-write");
            WorkspaceJdbcStore workspace = workspaceStore(db);
            WorkspaceStore.OperationRecord operation = pendingOperation("op-ready", projectId);
            assertThat(workspace.beginPendingOperation(projectId, 0L, operation).started()).isTrue();
            DataSource dataSource = db.jdbc().getDataSource();
            try (Connection connection = dataSource.getConnection()) {
                connection.setAutoCommit(false);
                assertThat(projectState(connection, projectId)).isEqualTo("READY");
                assertThat(pendingCount(connection, projectId)).isEqualTo(1);
                connection.commit();
            }

            db.jdbc().update("UPDATE project SET state='DELETING' WHERE id=?", projectId);
            WorkspaceStore.BeginResult locked = workspace.beginPendingOperation(projectId, 0L,
                pendingOperation("op-late", projectId));
            assertThat(locked.started()).isFalse();
            assertThat(locked.projectLocked()).isTrue();
            assertThat(db.jdbc().queryForObject(
                "SELECT COUNT(*) FROM workspace_operation WHERE project_id=? AND state='PENDING'",
                Integer.class, projectId)).isEqualTo(1);
        }
    }

    @Test
    void commitAndReadyFailedMarkersDoNotMoveADeletingProject() {
        try (var db = JdbcStoreTestSupport.create()) {
            String projectId = seedReadyProject(db, "owner-a", "frozen");
            WorkspaceJdbcStore workspace = workspaceStore(db);
            WorkspaceStore.OperationRecord operation = pendingOperation("op-frozen", projectId);
            assertThat(workspace.beginPendingOperation(projectId, 0L, operation).started()).isTrue();
            db.jdbc().update("UPDATE project SET state='DELETING' WHERE id=?", projectId);

            assertThat(workspace.commitOperation(operation.id(), projectId, 0L)).isFalse();
            assertThat(db.jdbc().queryForObject(
                "SELECT state FROM workspace_operation WHERE id=?", String.class, operation.id()))
                .isEqualTo("PENDING");
            assertThat(db.jdbc().queryForObject(
                "SELECT workspace_revision FROM project WHERE id=?", Long.class, projectId)).isZero();
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, projectId))
                .isEqualTo("DELETING");

            workspace.markProjectReady(projectId);
            workspace.markProjectFailed(projectId, "CREATION_FAILED");
            assertThat(db.jdbc().queryForObject("SELECT state FROM project WHERE id=?", String.class, projectId))
                .isEqualTo("DELETING");
            assertThat(db.jdbc().queryForObject(
                "SELECT failure_reason FROM project WHERE id=?", String.class, projectId)).isNull();
        }
    }

    @Test
    void recoveryRereadsCreatingAndSkipsChangedProjects() {
        String projectId = "prj-stale";
        Instant created = Instant.parse("2026-08-29T00:00:00Z");
        WorkspaceStore.ProjectRecord staleCreating = new WorkspaceStore.ProjectRecord(
            projectId, "alice-id", "stale", "CREATING", 0, null, created);
        FakeStore store = new FakeStore();
        store.creatingOverride = java.util.List.of(staleCreating);
        store.projects.put(projectId, new WorkspaceStore.ProjectRecord(projectId, "alice-id", "stale", "DELETING", 0, null,
            created));
        FakeKubernetesGateway gateway = new FakeKubernetesGateway();
        gateway.created.add("pvc:" + projectId);
        gateway.created.add("pod:" + projectId);
        gateway.created.add("svc:" + projectId);
        ProjectRecoveryService service = new ProjectRecoveryService(store, new StubAgent(), gateway,
            Clock.fixed(created.plus(Duration.ofMinutes(11)), ZoneOffset.UTC), Duration.ofMinutes(10),
            new ProjectLifecycleGate());

        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();

        assertThat(report.processed()).isEmpty();
        assertThat(report.ready()).isEmpty();
        assertThat(report.failed()).isEmpty();
        assertThat(gateway.deletedProjects).isEmpty();
        assertThat(store.projects.get(projectId).state()).isEqualTo("DELETING");
    }

    private static String seedReadyProject(JdbcStoreTestSupport db, String ownerId, String name) {
        String projectId = name + "-" + UUID.randomUUID();
        Timestamp now = Timestamp.from(NOW);
        db.jdbc().update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            ownerId, ownerId + "-" + projectId, "not-an-auth-credential", now);
        db.jdbc().update(
            "INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, ?, 'READY', 0, ?, ?)",
            projectId, ownerId, name, now, now);
        return projectId;
    }

    private static JdbcRunStore runStore(JdbcStoreTestSupport db) {
        return new JdbcRunStore(db.jdbc(), new DatabaseClock(Clock.fixed(NOW, ZoneOffset.UTC)));
    }

    private static WorkspaceJdbcStore workspaceStore(JdbcStoreTestSupport db) {
        return new WorkspaceJdbcStore(db.jdbc(), new DataSourceTransactionManager(db.jdbc().getDataSource()));
    }

    private static RunRecord startingRun(String id, String projectId, long token) {
        return new RunRecord(id, projectId, 0L, RunState.STARTING, "{}", null, null, null, null, null, null,
            0L, NOW, token);
    }

    private static WorkspaceStore.OperationRecord pendingOperation(String id, String projectId) {
        return new WorkspaceStore.OperationRecord(id, projectId, 0L, "a".repeat(64), "b".repeat(64),
            "receipts/" + id, "c".repeat(64));
    }

    private static String projectState(Connection connection, String projectId) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT state FROM project WHERE id=? FOR UPDATE")) {
            statement.setString(1, projectId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static int activeRunCount(Connection connection, String projectId) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT COUNT(*) FROM run WHERE project_id=? AND active_run_marker=1")) {
            statement.setString(1, projectId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getInt(1);
            }
        }
    }

    private static int pendingCount(Connection connection, String projectId) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT COUNT(*) FROM workspace_operation WHERE project_id=? AND state='PENDING'")) {
            statement.setString(1, projectId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getInt(1);
            }
        } finally {
            if (connection.getAutoCommit()) {
                connection.close();
            }
        }
    }
}
