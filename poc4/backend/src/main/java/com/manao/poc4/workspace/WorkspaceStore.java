package com.manao.poc4.workspace;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Persistence boundary for workspace state; the MySQL workspace_revision is the only authority. */
public interface WorkspaceStore {
    ProjectRecord findProjectForOwner(String ownerId, String projectId);

    ProjectRecord findProject(String projectId);

    boolean hasActiveRun(String projectId);

    /** Deletes one owner-scoped project and all dependent durable records. */
    boolean deleteProject(String ownerId, String projectId);

    /** Locks the project row, verifies the expected revision and inserts the PENDING operation. */
    BeginResult beginPendingOperation(String projectId, long expectedRevision, OperationRecord operation);

    /** Conditionally commits the operation and increments the revision; both rows must move or nothing does. */
    boolean commitOperation(String operationId, String projectId, long expectedRevision);

    /**
     * Reconciled commit for a verified PYTHON_DEPENDENCIES operation: locks the project row,
     * allows READY or a project failed with exactly WORKSPACE_RECONCILIATION_REQUIRED, commits
     * the operation, advances the revision once and clears that failure in the same transaction.
     * DELETING, other failures, foreign kinds and active runs are refused.
     */
    boolean commitReconciledOperation(String operationId, String projectId, long expectedRevision);

    List<OperationRecord> pendingOperations(String projectId);

    /** The PENDING or COMMITTED operation row for this exact project and operation id. */
    Optional<OperationRecord> findOperation(String projectId, String operationId);

    void deleteOperation(String operationId);

    void markProjectFailed(String projectId, String failureReason);

    void markProjectReady(String projectId);

    java.util.List<ProjectRecord> projectsByState(String state);

    record ProjectRecord(String id, String ownerId, String name, String state, long workspaceRevision,
                         String failureReason, Instant createdAt) { }

    record OperationRecord(String id, String projectId, long expectedRevision, String beforeSha256,
                           String afterSha256, String receiptPath, String receiptSha256,
                           String state, String operationKind, String requestSha256) {
        /** Single-file operations carry no request digest and are registered PENDING. */
        public OperationRecord(String id, String projectId, long expectedRevision, String beforeSha256,
                               String afterSha256, String receiptPath, String receiptSha256) {
            this(id, projectId, expectedRevision, beforeSha256, afterSha256, receiptPath, receiptSha256,
                "PENDING", "FILE", null);
        }
    }

    record BeginResult(boolean started, boolean revisionConflict, boolean projectLocked) {
        public BeginResult(boolean started, boolean revisionConflict) {
            this(started, revisionConflict, false);
        }
    }
}
