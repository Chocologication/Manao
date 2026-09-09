package com.manao.poc4.project;

import com.manao.poc4.kubernetes.KubernetesGateway;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import com.manao.poc4.recovery.ProjectRecoveryService;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceTemplate;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.function.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Fixed project creation order: CREATING row exists -> PVC -> initializer pod (root mount,
 * fixed UID/GID probe) -> workspace pod + Service (subPath) -> wait ready -> write the fixed
 * template through the internal workspace API -> READY. Any failure records FAILED and removes
 * only this request's label-scoped resources unless a one-shot diagnostic hold has claimed it.
 */
public final class ProjectProvisioningService {
    private static final Logger LOG = LoggerFactory.getLogger(ProjectProvisioningService.class);

    private final WorkspaceStore store;
    private final KubernetesGateway gateway;
    private final WorkspaceService workspace;
    private final WorkspaceResourceFactory factory;
    private final WorkspaceTemplate template;
    private final String capabilityPublicKeyBase64;
    private final WorkspaceBridge bridge;
    private final Predicate<WorkspaceStore.ProjectRecord> diagnosticHoldSelector;
    private final int pollAttempts;
    private final long pollIntervalMillis;
    private final java.util.concurrent.ExecutorService executor =
        java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "project-provisioning");
            thread.setDaemon(true);
            return thread;
        });

    /** 6A bridge lifecycle hooks; null in 6B where the Service is reachable in-namespace. */
    public interface WorkspaceBridge {
        void allocate(String projectId);

        void release(String projectId);

        /** Keeps a diagnostic bridge from being automatically recreated during evidence capture. */
        default void hold(String projectId) { }
    }

    public ProjectProvisioningService(WorkspaceStore store, KubernetesGateway gateway, WorkspaceService workspace,
                                      WorkspaceResourceFactory factory, WorkspaceTemplate template,
                                      String capabilityPublicKeyBase64) {
        this(store, gateway, workspace, factory, template, capabilityPublicKeyBase64, null, null, 240, 500);
    }

    public ProjectProvisioningService(WorkspaceStore store, KubernetesGateway gateway, WorkspaceService workspace,
                                      WorkspaceResourceFactory factory, WorkspaceTemplate template,
                                      String capabilityPublicKeyBase64, WorkspaceBridge bridge) {
        this(store, gateway, workspace, factory, template, capabilityPublicKeyBase64, bridge, null, 240, 500);
    }

    public ProjectProvisioningService(WorkspaceStore store, KubernetesGateway gateway, WorkspaceService workspace,
                                      WorkspaceResourceFactory factory, WorkspaceTemplate template,
                                      String capabilityPublicKeyBase64, WorkspaceBridge bridge,
                                      int pollAttempts, long pollIntervalMillis) {
        this(store, gateway, workspace, factory, template, capabilityPublicKeyBase64, bridge, null,
            pollAttempts, pollIntervalMillis);
    }

    public ProjectProvisioningService(WorkspaceStore store, KubernetesGateway gateway, WorkspaceService workspace,
                                      WorkspaceResourceFactory factory, WorkspaceTemplate template,
                                      String capabilityPublicKeyBase64, WorkspaceBridge bridge,
                                      Predicate<WorkspaceStore.ProjectRecord> diagnosticHoldSelector,
                                      int pollAttempts, long pollIntervalMillis) {
        this.store = store;
        this.gateway = gateway;
        this.workspace = workspace;
        this.factory = factory;
        this.template = template;
        this.capabilityPublicKeyBase64 = capabilityPublicKeyBase64;
        this.bridge = bridge;
        this.diagnosticHoldSelector = diagnosticHoldSelector;
        this.pollAttempts = pollAttempts;
        this.pollIntervalMillis = pollIntervalMillis;
    }

    /** Creation returns CREATING to the browser immediately; provisioning continues in background. */
    public void provisionAsync(String projectId) {
        executor.execute(() -> provision(projectId));
    }

    public void provision(String projectId) {
        WorkspaceStore.ProjectRecord project = store.findProject(projectId);
        if (project == null || !"CREATING".equals(project.state())) {
            return;
        }
        try {
            provisionInternal(projectId);
        } catch (Exception ex) {
            WorkspaceStore.ProjectRecord failedProject = store.findProject(projectId);
            boolean hold = diagnosticHoldSelector != null && diagnosticHoldSelector.test(failedProject);
            if (hold) {
                if (bridge != null) bridge.hold(projectId);
                LOG.warn("project provisioning failed; preserving diagnostic resources: projectId={} failureClass={}",
                    projectId, ex.getClass().getSimpleName());
            } else {
                LOG.warn("project provisioning failed; cleaning up label-scoped resources", ex);
                cleanup(projectId);
            }
            store.markProjectFailed(projectId, hold
                ? "WORKSPACE_RECONCILIATION_REQUIRED"
                : ProjectRecoveryService.CREATION_FAILED);
        }
    }

    private void provisionInternal(String projectId) {
        gateway.createPvc(factory.createPvc(projectId));
        gateway.createPod(factory.createInitializerPod(projectId));
        if (!awaitInitializer(projectId)) {
            throw new IllegalStateException("initializer did not succeed");
        }
        gateway.createPod(factory.createWorkspacePod(projectId, capabilityPublicKeyBase64));
        gateway.createService(factory.createWorkspaceService(projectId));
        if (!gateway.workspacePodReady(projectId) && !awaitWorkspacePod(projectId)) {
            throw new IllegalStateException("workspace pod did not become ready");
        }
        // Design: delete the one-shot initializer as soon as it has succeeded.
        gateway.deletePod(WorkspaceResourceFactory.initializerPodName(projectId));
        if (bridge != null) {
            bridge.allocate(projectId); // 6A: the bridge must exist before the first template write
        }
        writeTemplate(projectId);
        store.markProjectReady(projectId);
    }

    private boolean awaitInitializer(String projectId) {
        for (int attempt = 0; attempt < pollAttempts; attempt++) {
            if (gateway.initializerSucceeded(projectId)) return true;
            sleep(pollIntervalMillis);
        }
        return gateway.initializerSucceeded(projectId);
    }

    private boolean awaitWorkspacePod(String projectId) {
        for (int attempt = 0; attempt < pollAttempts; attempt++) {
            if (gateway.workspacePodReady(projectId)) return true;
            sleep(pollIntervalMillis);
        }
        return gateway.workspacePodReady(projectId);
    }

    /** Template directories and files go through the same two-phase workspace protocol. */
    private void writeTemplate(String projectId) {
        long revision = 0;
        for (String directory : template.directories()) {
            revision = workspace.applyInternal(projectId, "CREATE", directory, null, "directory", new byte[0], revision);
        }
        for (Map.Entry<String, String> file : template.files().entrySet()) {
            revision = workspace.applyInternal(projectId, "CREATE", file.getKey(), null, "file", new byte[0], revision);
            revision = workspace.applyInternal(projectId, "SAVE", file.getKey(), null, null,
                file.getValue().getBytes(StandardCharsets.UTF_8), revision);
        }
    }

    private void cleanup(String projectId) {
        try {
            if (bridge != null) bridge.release(projectId);
        } catch (RuntimeException ex) {
            LOG.warn("workspace bridge release failed for a provisioning project", ex);
        }
        try {
            gateway.deleteProjectResources(projectId);
        } catch (RuntimeException ex) {
            LOG.warn("label-scoped cleanup failed for a provisioning project", ex);
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting for workspace resources", ex);
        }
    }
}
