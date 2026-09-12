package com.manao.poc4.project;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.KubernetesGateway;
import com.manao.poc4.workspace.WorkspaceStore;
import java.util.List;

/**
 * Owner-scoped project deletion: persist DELETING, close local handles, clean Kubernetes, then
 * delete durable rows. Kubernetes waits never run inside a database transaction.
 */
public final class ProjectCleanupService {
    private final ProjectDeletionRepository deletions;
    private final ProjectLifecycleGate lifecycle;
    private final ProjectRuntimeCleaner runtime;
    private final KubernetesGateway gateway;
    private final WorkspaceStore store;

    public ProjectCleanupService(ProjectDeletionRepository deletions, ProjectLifecycleGate lifecycle,
                                 ProjectRuntimeCleaner runtime, KubernetesGateway gateway, WorkspaceStore store) {
        this.deletions = deletions;
        this.lifecycle = lifecycle;
        this.runtime = runtime;
        this.gateway = gateway;
        this.store = store;
    }

    public void delete(String ownerId, String projectId) {
        ProjectDeletionRepository.BeginDeletion preview = deletions.inspect(ownerId, projectId);
        rejectIfNotReadyToClean(preview);
        try (var lease = lifecycle.tryAcquire(projectId).orElse(null)) {
            if (lease == null) {
                if (preview == ProjectDeletionRepository.BeginDeletion.RESUMED) {
                    throw incomplete();
                }
                throw new ApiException("PROJECT_BUSY", 409, "Project is busy");
            }
            rejectIfNotReadyToClean(deletions.begin(ownerId, projectId));
            try {
                List<String> runIds = deletions.runIds(ownerId, projectId);
                runtime.closeProject(projectId, runIds);
                gateway.deleteProjectResources(projectId);
                if (!store.deleteProject(ownerId, projectId)) {
                    throw incomplete();
                }
            } catch (ApiException ex) {
                throw ex;
            } catch (RuntimeException ex) {
                throw incomplete();
            }
        }
    }

    private static void rejectIfNotReadyToClean(ProjectDeletionRepository.BeginDeletion began) {
        switch (began) {
            case NOT_FOUND -> throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
            case CREATING -> throw new ApiException("PROJECT_CREATING", 409, "Project is still being created");
            case ACTIVE_RUN -> throw new ApiException("RUN_ALREADY_ACTIVE", 409, "A run is already active");
            case BUSY -> throw new ApiException("PROJECT_BUSY", 409, "Project is busy");
            case STARTED, RESUMED -> { }
        }
    }

    private static ApiException incomplete() {
        return new ApiException("PROJECT_CLEANUP_INCOMPLETE", 503, "Project cleanup is incomplete");
    }
}
