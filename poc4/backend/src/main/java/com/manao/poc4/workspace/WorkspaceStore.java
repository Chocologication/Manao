package com.manao.poc4.workspace;

import java.time.Instant;
import java.util.List;

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

    List<OperationRecord> pendingOperations(String projectId);

    void deleteOperation(String operationId);

    void markProjectFailed(String projectId, String failureReason);

    void markProjectReady(String projectId);

    java.util.List<ProjectRecord> projectsByState(String state);

    record ProjectRecord(String id, String ownerId, String name, String state, long workspaceRevision,
                         String failureReason, Instant createdAt) { }

    record OperationRecord(String id, String projectId, long expectedRevision, String beforeSha256,
                           String afterSha256, String receiptPath, String receiptSha256) { }

    record BeginResult(boolean started, boolean revisionConflict, boolean projectLocked) {
        public BeginResult(boolean started, boolean revisionConflict) {
            this(started, revisionConflict, false);
        }
    }
}
