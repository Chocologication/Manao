package com.manao.poc4.recovery;

import com.manao.poc4.kubernetes.KubernetesGateway;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceStore;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Startup and scheduled recovery for CREATING projects older than the threshold. A uniquely
 * matching project with complete evidence and committed template operations is compensated to
 * READY; anything else gets label-scoped idempotent cleanup and a FAILED state without touching
 * other projects' resources.
 */
public final class ProjectRecoveryService {
    public static final String CREATION_FAILED = "CREATION_FAILED";

    private final WorkspaceStore store;
    private final WorkspaceAgent agent;
    private final KubernetesGateway gateway;
    private final Clock clock;
    private final Duration staleAfter;

    public ProjectRecoveryService(WorkspaceStore store, WorkspaceAgent agent, KubernetesGateway gateway,
                                  Clock clock, Duration staleAfter) {
        this.store = store;
        this.agent = agent;
        this.gateway = gateway;
        this.clock = clock;
        this.staleAfter = staleAfter;
    }

    public record RecoveryReport(List<String> processed, List<String> ready, List<String> failed) { }

    public RecoveryReport recoverStaleCreatingProjects() {
        Instant now = clock.instant();
        List<String> processed = new ArrayList<>();
        List<String> ready = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        for (WorkspaceStore.ProjectRecord project : creatingProjects()) {
            if (project.createdAt() == null || project.createdAt().isAfter(now.minus(staleAfter))) {
                continue;
            }
            processed.add(project.id());
            String projectId = project.id();
            boolean resourcesComplete = gateway.projectPvcExists(projectId)
                && gateway.workspacePodReady(projectId)
                && gateway.workspaceServiceExists(projectId);
            if (!resourcesComplete) {
                cleanup(projectId);
                store.markProjectFailed(projectId, CREATION_FAILED);
                failed.add(projectId);
                continue;
            }
            if (!operations().reconcilePending(projectId)) {
                // Fail-closed with the scene preserved: workloads go away, the PVC (file truth)
                // and the FAILED/WORKSPACE_RECONCILIATION_REQUIRED marker stay for inspection.
                gateway.deleteProjectWorkloads(projectId);
                failed.add(projectId);
                continue;
            }
            WorkspaceStore.ProjectRecord current = store.findProject(projectId);
            if (current != null && current.workspaceRevision() > 0 && !"FAILED".equals(current.state())
                && templateReceiptPresent(projectId)) {
                store.markProjectReady(projectId);
                ready.add(projectId);
            } else {
                cleanup(projectId);
                store.markProjectFailed(projectId, CREATION_FAILED);
                failed.add(projectId);
            }
        }
        return new RecoveryReport(List.copyOf(processed), List.copyOf(ready), List.copyOf(failed));
    }

    private WorkspaceOperationService operations() {
        return new WorkspaceOperationService(store, agent);
    }

    /** Template receipt: the fixed pom.xml must be readable through the workspace agent. */
    private boolean templateReceiptPresent(String projectId) {
        try {
            return agent.tree(projectId, "").entries().stream()
                .anyMatch(entry -> "pom.xml".equals(entry.path()));
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private void cleanup(String projectId) {
        gateway.deleteProjectResources(projectId);
    }

    private List<WorkspaceStore.ProjectRecord> creatingProjects() {
        return store.projectsByState("CREATING");
    }
}
