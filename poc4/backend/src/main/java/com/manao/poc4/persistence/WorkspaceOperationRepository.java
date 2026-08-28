package com.manao.poc4.persistence;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;

public final class WorkspaceOperationRepository {
    private final Connection connection;
    private final DatabaseClock clock;

    WorkspaceOperationRepository(Connection connection, DatabaseClock clock) {
        this.connection = connection;
        this.clock = clock;
    }

    public boolean createPending(String id, String projectId, long expectedRevision, String beforeSha256, String afterSha256, String receiptPath, String receiptSha256) {
        requireSha256(beforeSha256, "beforeSha256");
        requireSha256(afterSha256, "afterSha256");
        requireSha256(receiptSha256, "receiptSha256");
        try (var insert = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)")) {
            insert.setString(1, id); insert.setString(2, projectId); insert.setLong(3, expectedRevision); insert.setString(4, beforeSha256); insert.setString(5, afterSha256); insert.setString(6, receiptPath); insert.setString(7, receiptSha256); insert.setTimestamp(8, Timestamp.from(clock.now()));
            return insert.executeUpdate() == 1;
        } catch (SQLException ex) {
            if (ex.getErrorCode() == 1062) return false;
            throw new IllegalStateException("cannot create pending workspace operation", ex);
        }
    }

    public boolean commit(String id, String projectId, long expectedRevision) {
        try {
            connection.setAutoCommit(false);
            try (var operation = connection.prepareStatement("UPDATE workspace_operation SET state = 'COMMITTED', committed_at = ? WHERE id = ? AND project_id = ? AND expected_revision = ? AND state = 'PENDING'")) {
                operation.setTimestamp(1, Timestamp.from(clock.now())); operation.setString(2, id); operation.setString(3, projectId); operation.setLong(4, expectedRevision);
                if (operation.executeUpdate() != 1) { connection.rollback(); return false; }
            }
            try (var project = connection.prepareStatement("UPDATE project SET workspace_revision = workspace_revision + 1 WHERE id = ? AND workspace_revision = ?")) {
                project.setString(1, projectId); project.setLong(2, expectedRevision);
                if (project.executeUpdate() != 1) { connection.rollback(); return false; }
            }
            connection.commit();
            return true;
        } catch (SQLException ex) {
            rollback();
            throw new IllegalStateException("cannot commit workspace operation", ex);
        } finally { restoreAutoCommit(); }
    }

    public List<PendingOperation> pendingForProject(String projectId) {
        try (var select = connection.prepareStatement("SELECT id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256 FROM workspace_operation WHERE project_id = ? AND state = 'PENDING' ORDER BY created_at")) {
            select.setString(1, projectId);
            List<PendingOperation> operations = new ArrayList<>();
            try (var rows = select.executeQuery()) {
                while (rows.next()) {
                    operations.add(new PendingOperation(rows.getString("id"), rows.getLong("expected_revision"),
                        rows.getString("before_sha256"), rows.getString("after_sha256"), rows.getString("receipt_path"),
                        rows.getString("receipt_sha256")));
                }
            }
            return List.copyOf(operations);
        } catch (SQLException ex) { throw new IllegalStateException("cannot list pending workspace operations", ex); }
    }

    public boolean failReconciliation(String id, String projectId) {
        try (var update = connection.prepareStatement("UPDATE workspace_operation SET state = 'FAILED' WHERE id = ? AND project_id = ? AND state = 'PENDING'")) {
            update.setString(1, id); update.setString(2, projectId); return update.executeUpdate() == 1;
        } catch (SQLException ex) { throw new IllegalStateException("cannot fail workspace operation reconciliation", ex); }
    }

    public record PendingOperation(String id, long expectedRevision, String beforeSha256, String afterSha256,
                                   String receiptPath, String receiptSha256) { }

    private static void requireSha256(String value, String name) {
        if (value == null || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(name + " must be 64 lowercase hexadecimal characters");
        }
    }

    private void rollback() { try { connection.rollback(); } catch (SQLException ignored) { } }
    private void restoreAutoCommit() { try { connection.setAutoCommit(true); } catch (SQLException ignored) { } }
}
