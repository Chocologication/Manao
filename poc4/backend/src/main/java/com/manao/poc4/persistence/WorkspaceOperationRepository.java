package com.manao.poc4.persistence;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public final class WorkspaceOperationRepository {
    private final Connection connection;
    private final DatabaseClock clock;

    WorkspaceOperationRepository(Connection connection, DatabaseClock clock) {
        this.connection = connection;
        this.clock = clock;
    }

    public boolean createPending(String id, String projectId, long expectedRevision, String beforeSha256, String afterSha256, String receiptPath, String receiptSha256) {
        return createPending(id, projectId, expectedRevision, beforeSha256, afterSha256, receiptPath, receiptSha256, "FILE", null);
    }

    public boolean createPending(String id, String projectId, long expectedRevision, String beforeSha256, String afterSha256,
                                 String receiptPath, String receiptSha256, String operationKind, String requestSha256) {
        requireSha256(beforeSha256, "beforeSha256");
        requireSha256(afterSha256, "afterSha256");
        requireSha256(receiptSha256, "receiptSha256");
        if (requestSha256 != null) requireSha256(requestSha256, "requestSha256");
        if (!"FILE".equals(operationKind) && !"PYTHON_DEPENDENCIES".equals(operationKind)) {
            throw new IllegalArgumentException("unsupported operation kind: " + operationKind);
        }
        if ("PYTHON_DEPENDENCIES".equals(operationKind) && requestSha256 == null) {
            throw new IllegalArgumentException("dependency operations require a request digest");
        }
        try (var insert = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, operation_kind, request_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)")) {
            insert.setString(1, id); insert.setString(2, projectId); insert.setLong(3, expectedRevision); insert.setString(4, beforeSha256); insert.setString(5, afterSha256); insert.setString(6, receiptPath); insert.setString(7, receiptSha256); insert.setString(8, operationKind); insert.setString(9, requestSha256); insert.setTimestamp(10, Timestamp.from(clock.now()));
            return insert.executeUpdate() == 1;
        } catch (SQLException ex) {
            if (ex.getErrorCode() == 1062) return false;
            throw new IllegalStateException("cannot create pending workspace operation", ex);
        }
    }

    public boolean commit(String id, String projectId, long expectedRevision) {
        return commitInternal(id, projectId, expectedRevision, false);
    }

    public boolean commitReconciled(String id, String projectId, long expectedRevision) {
        return commitInternal(id, projectId, expectedRevision, true);
    }

    /**
     * The one conditional commit, shared by the normal and the reconciled entry point: both
     * statements move or nothing does. The reconciled variant additionally refuses active runs
     * and foreign kinds, and may recover a project failed with exactly
     * WORKSPACE_RECONCILIATION_REQUIRED by clearing that failure in the same transaction.
     */
    private boolean commitInternal(String id, String projectId, long expectedRevision, boolean reconciled) {
        try {
            connection.setAutoCommit(false);
            var now = Timestamp.from(clock.now());
            try (var project = connection.prepareStatement("SELECT state, failure_reason FROM project WHERE id = ? FOR UPDATE")) {
                project.setString(1, projectId);
                try (var rows = project.executeQuery()) {
                    if (!rows.next()) { connection.rollback(); return false; }
                    String state = rows.getString(1);
                    if (reconciled) {
                        // Reconciliation is only for READY or exactly this reconciliation failure;
                        // CREATING is never reconciled and never promoted to READY.
                        boolean recoverable = "FAILED".equals(state)
                            && "WORKSPACE_RECONCILIATION_REQUIRED".equals(rows.getString(2));
                        if (!"READY".equals(state) && !recoverable) { connection.rollback(); return false; }
                    } else if ("DELETING".equals(state) || "FAILED".equals(state)) {
                        connection.rollback(); return false;
                    }
                }
            }
            if (reconciled && hasActiveRun(projectId)) { connection.rollback(); return false; }
            try (var operation = connection.prepareStatement("UPDATE workspace_operation SET state = 'COMMITTED', committed_at = ? WHERE id = ? AND project_id = ? AND expected_revision = ? AND state = 'PENDING'"
                    + (reconciled ? " AND operation_kind = 'PYTHON_DEPENDENCIES'" : ""))) {
                operation.setTimestamp(1, now); operation.setString(2, id); operation.setString(3, projectId); operation.setLong(4, expectedRevision);
                if (operation.executeUpdate() != 1) { connection.rollback(); return false; }
            }
            try (var update = connection.prepareStatement("UPDATE project SET workspace_revision = workspace_revision + 1, updated_at = ?"
                    + (reconciled ? ", state = 'READY', failure_reason = NULL" : "")
                    + " WHERE id = ? AND workspace_revision = ?")) {
                update.setTimestamp(1, now); update.setString(2, projectId); update.setLong(3, expectedRevision);
                if (update.executeUpdate() != 1) { connection.rollback(); return false; }
            }
            connection.commit();
            return true;
        } catch (SQLException ex) {
            rollback();
            throw new IllegalStateException("cannot commit workspace operation", ex);
        } finally { restoreAutoCommit(); }
    }

    private boolean hasActiveRun(String projectId) throws SQLException {
        try (var runs = connection.prepareStatement("SELECT 1 FROM run WHERE project_id = ? AND active_run_marker = 1 LIMIT 1")) {
            runs.setString(1, projectId);
            try (var rows = runs.executeQuery()) { return rows.next(); }
        }
    }

    public List<PendingOperation> pendingForProject(String projectId) {
        try (var select = connection.prepareStatement("SELECT id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, operation_kind, request_sha256 FROM workspace_operation WHERE project_id = ? AND state = 'PENDING' ORDER BY created_at")) {
            select.setString(1, projectId);
            List<PendingOperation> operations = new ArrayList<>();
            try (var rows = select.executeQuery()) {
                while (rows.next()) {
                    operations.add(new PendingOperation(rows.getString("id"), rows.getLong("expected_revision"),
                        rows.getString("before_sha256"), rows.getString("after_sha256"), rows.getString("receipt_path"),
                        rows.getString("receipt_sha256"), rows.getString("operation_kind"), rows.getString("request_sha256")));
                }
            }
            return List.copyOf(operations);
        } catch (SQLException ex) { throw new IllegalStateException("cannot list pending workspace operations", ex); }
    }

    /** The PENDING or COMMITTED row for this exact project and operation id, if any. */
    public Optional<Operation> findOperation(String projectId, String operationId) {
        try (var select = connection.prepareStatement("SELECT id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, operation_kind, request_sha256 FROM workspace_operation WHERE project_id = ? AND id = ? AND state IN ('PENDING', 'COMMITTED')")) {
            select.setString(1, projectId); select.setString(2, operationId);
            try (var rows = select.executeQuery()) {
                if (!rows.next()) return Optional.empty();
                return Optional.of(new Operation(rows.getString("id"), rows.getString("project_id"), rows.getLong("expected_revision"),
                    rows.getString("before_sha256"), rows.getString("after_sha256"), rows.getString("receipt_path"),
                    rows.getString("receipt_sha256"), rows.getString("state"), rows.getString("operation_kind"),
                    rows.getString("request_sha256")));
            }
        } catch (SQLException ex) { throw new IllegalStateException("cannot read workspace operation", ex); }
    }

    public boolean failReconciliation(String id, String projectId) {
        try (var update = connection.prepareStatement("UPDATE workspace_operation SET state = 'FAILED' WHERE id = ? AND project_id = ? AND state = 'PENDING'")) {
            update.setString(1, id); update.setString(2, projectId); return update.executeUpdate() == 1;
        } catch (SQLException ex) { throw new IllegalStateException("cannot fail workspace operation reconciliation", ex); }
    }

    public record PendingOperation(String id, long expectedRevision, String beforeSha256, String afterSha256,
                                   String receiptPath, String receiptSha256, String operationKind, String requestSha256) { }

    public record Operation(String id, String projectId, long expectedRevision, String beforeSha256, String afterSha256,
                            String receiptPath, String receiptSha256, String state, String operationKind,
                            String requestSha256) { }

    private static void requireSha256(String value, String name) {
        if (value == null || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(name + " must be 64 lowercase hexadecimal characters");
        }
    }

    private void rollback() { try { connection.rollback(); } catch (SQLException ignored) { } }
    private void restoreAutoCommit() { try { connection.setAutoCommit(true); } catch (SQLException ignored) { } }
}
