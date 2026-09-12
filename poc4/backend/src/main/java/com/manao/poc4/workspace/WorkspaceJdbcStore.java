package com.manao.poc4.workspace;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * JDBC implementation of the workspace persistence boundary. beginPendingOperation serializes
 * writers through a SELECT ... FOR UPDATE on the project row so the expected-revision check and
 * the unique PENDING marker are enforced atomically.
 */
import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;

@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public final class WorkspaceJdbcStore implements WorkspaceStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public WorkspaceJdbcStore(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactions);
    }

    @Override public ProjectRecord findProjectForOwner(String ownerId, String projectId) {
        return find("SELECT id, owner_id, name, state, workspace_revision, failure_reason, created_at FROM project WHERE id = ? AND owner_id = ?",
            projectId, ownerId);
    }

    @Override public ProjectRecord findProject(String projectId) {
        return find("SELECT id, owner_id, name, state, workspace_revision, failure_reason, created_at FROM project WHERE id = ?",
            projectId);
    }

    @Override public boolean hasActiveRun(String projectId) {
        List<String> states = jdbc.query(
            "SELECT state FROM run WHERE project_id = ? AND active_run_marker = 1",
            (rs, row) -> rs.getString(1), projectId);
        return !states.isEmpty();
    }

    @Override public boolean deleteProject(String ownerId, String projectId) {
        Boolean deleted = transaction.execute(status -> {
            Integer owned = jdbc.queryForObject(
                "SELECT COUNT(*) FROM project WHERE id = ? AND owner_id = ? FOR UPDATE", Integer.class, projectId, ownerId);
            if (owned == null || owned != 1 || hasActiveRun(projectId)) return Boolean.FALSE;
            jdbc.update("DELETE FROM terminal_audit WHERE project_id = ?", projectId);
            jdbc.update("DELETE FROM terminal_session WHERE project_id = ?", projectId);
            jdbc.update("DELETE FROM log_ticket WHERE project_id = ?", projectId);
            jdbc.update("DELETE FROM run_log_chunk WHERE run_id IN (SELECT id FROM run WHERE project_id = ?)", projectId);
            jdbc.update("DELETE FROM run WHERE project_id = ?", projectId);
            jdbc.update("DELETE FROM workspace_operation WHERE project_id = ?", projectId);
            return jdbc.update("DELETE FROM project WHERE id = ? AND owner_id = ?", projectId, ownerId) == 1;
        });
        return Boolean.TRUE.equals(deleted);
    }

    @Override public BeginResult beginPendingOperation(String projectId, long expectedRevision, OperationRecord operation) {
        BeginResult result = transaction.execute(status -> {
            List<Object[]> rows = jdbc.query(
                "SELECT state, workspace_revision FROM project WHERE id = ? FOR UPDATE",
                (rs, row) -> new Object[] { rs.getString(1), rs.getLong(2) }, projectId);
            if (rows.isEmpty() || ((Long) rows.get(0)[1]) != expectedRevision) {
                return new BeginResult(false, true);
            }
            String state = (String) rows.get(0)[0];
            if (!"READY".equals(state) && !"CREATING".equals(state)) {
                return new BeginResult(false, false, true);
            }
            if ("READY".equals(state) && hasActiveRun(projectId)) {
                return new BeginResult(false, false, true);
            }
            jdbc.update("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)",
                operation.id(), projectId, operation.expectedRevision(), operation.beforeSha256(),
                operation.afterSha256(), operation.receiptPath(), operation.receiptSha256(), Timestamp.from(Instant.now()));
            return new BeginResult(true, false);
        });
        return result == null ? new BeginResult(false, false) : result;
    }

    @Override public boolean commitOperation(String operationId, String projectId, long expectedRevision) {
        Boolean committed = transaction.execute(status -> {
            List<String> states = jdbc.query(
                "SELECT state FROM project WHERE id = ? FOR UPDATE",
                (rs, row) -> rs.getString(1), projectId);
            if (states.isEmpty() || "DELETING".equals(states.get(0)) || "FAILED".equals(states.get(0))) {
                return Boolean.FALSE;
            }
            int operation = jdbc.update(
                "UPDATE workspace_operation SET state = 'COMMITTED', committed_at = ? WHERE id = ? AND project_id = ? AND expected_revision = ? AND state = 'PENDING'",
                Timestamp.from(Instant.now()), operationId, projectId, expectedRevision);
            if (operation != 1) {
                return Boolean.FALSE;
            }
            int project = jdbc.update(
                "UPDATE project SET workspace_revision = workspace_revision + 1, updated_at = ? WHERE id = ? AND workspace_revision = ?",
                Timestamp.from(Instant.now()), projectId, expectedRevision);
            return project == 1 ? Boolean.TRUE : Boolean.FALSE;
        });
        return Boolean.TRUE.equals(committed);
    }

    @Override public List<OperationRecord> pendingOperations(String projectId) {
        return jdbc.query(
            "SELECT id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256 FROM workspace_operation WHERE project_id = ? AND state = 'PENDING' ORDER BY created_at",
            (rs, row) -> new OperationRecord(rs.getString("id"), rs.getString("project_id"), rs.getLong("expected_revision"),
                rs.getString("before_sha256"), rs.getString("after_sha256"), rs.getString("receipt_path"),
                rs.getString("receipt_sha256")),
            projectId);
    }

    @Override public void deleteOperation(String operationId) {
        jdbc.update("DELETE FROM workspace_operation WHERE id = ? AND state = 'PENDING'", operationId);
    }

    @Override public void markProjectFailed(String projectId, String failureReason) {
        jdbc.update("UPDATE project SET state = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ? AND state IN ('CREATING', 'READY')",
            failureReason, Timestamp.from(Instant.now()), projectId);
    }

    @Override public void markProjectReady(String projectId) {
        jdbc.update("UPDATE project SET state = 'READY', failure_reason = NULL, updated_at = ? WHERE id = ? AND state = 'CREATING'",
            Timestamp.from(Instant.now()), projectId);
    }

    @Override public List<ProjectRecord> projectsByState(String state) {
        return jdbc.query(
            "SELECT id, owner_id, name, state, workspace_revision, failure_reason, created_at FROM project WHERE state = ? ORDER BY created_at, id",
            (rs, row) -> new ProjectRecord(rs.getString("id"), rs.getString("owner_id"), rs.getString("name"),
                rs.getString("state"), rs.getLong("workspace_revision"), rs.getString("failure_reason"),
                rs.getTimestamp("created_at").toInstant()),
            state);
    }

    private ProjectRecord find(String sql, Object... args) {
        List<ProjectRecord> records = jdbc.query(sql,
            (rs, row) -> new ProjectRecord(rs.getString("id"), rs.getString("owner_id"), rs.getString("name"),
                rs.getString("state"), rs.getLong("workspace_revision"), rs.getString("failure_reason"),
                rs.getTimestamp("created_at").toInstant()),
            args);
        return records.isEmpty() ? null : records.get(0);
    }
}
