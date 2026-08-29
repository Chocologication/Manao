package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Fabric8-backed gateway. All resource interaction is scoped by the server-generated project
 * labels; deletion only ever touches resources carrying this project's identity.
 */
public final class Fabric8KubernetesGateway implements KubernetesGateway {
    private static final long READY_TIMEOUT_SECONDS = 120;
    private final KubernetesClient client;
    private final String namespace;

    public Fabric8KubernetesGateway(KubernetesClient client, String namespace) {
        this.client = client;
        this.namespace = namespace;
    }

    @Override public boolean projectPvcExists(String projectId) {
        var pvc = client.persistentVolumeClaims().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.pvcName(projectId)).get();
        return matchesProject(pvc, projectId);
    }

    /** Name lookups are always re-verified against the server-generated project label. */
    private static boolean matchesProject(io.fabric8.kubernetes.api.model.HasMetadata resource, String projectId) {
        return resource != null && resource.getMetadata() != null
            && projectId.equals(resource.getMetadata().getLabels()
                .get(WorkspaceResourceFactory.LABEL_PROJECT_ID));
    }

    @Override public boolean initializerSucceeded(String projectId) {
        // The initializer is deleted right after success, so "gone" also counts as done.
        Pod pod = client.pods().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.initializerPodName(projectId)).get();
        if (pod == null) return true;
        return "Succeeded".equals(pod.getStatus() == null ? null : pod.getStatus().getPhase());
    }

    @Override public boolean workspacePodReady(String projectId) {
        Pod pod = client.pods().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.workspacePodName(projectId)).get();
        if (!matchesProject(pod, projectId) || pod.getStatus() == null) return false;
        return pod.getStatus().getConditions().stream()
            .anyMatch(condition -> "Ready".equals(condition.getType()) && "True".equals(condition.getStatus()));
    }

    @Override public boolean workspaceServiceExists(String projectId) {
        var service = client.services().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.serviceName(projectId)).get();
        return matchesProject(service, projectId);
    }

    @Override public void deletePod(String podName) {
        client.pods().inNamespace(namespace).withName(podName).withGracePeriod(0).delete();
    }

    @Override public void createPvc(PersistentVolumeClaim pvc) {
        client.persistentVolumeClaims().inNamespace(namespace).resource(pvc).serverSideApply();
    }

    @Override public void createPod(Pod pod) {
        client.pods().inNamespace(namespace).resource(pod).serverSideApply();
    }

    @Override public void createService(Service service) {
        client.services().inNamespace(namespace).resource(service).serverSideApply();
    }

    @Override public void deleteProjectResources(String projectId) {
        Map<String, String> labels = WorkspaceResourceFactory.projectLabels(projectId);
        client.pods().inNamespace(namespace).withLabels(labels).withGracePeriod(0).delete();
        client.services().inNamespace(namespace).withLabels(labels).delete();
        client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).delete();
    }

    /** Waits until the workspace pod is Ready; returns false on timeout. */
    public boolean awaitWorkspacePodReady(String projectId) {
        return client.pods().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.workspacePodName(projectId))
            .waitUntilCondition(this::isReady, READY_TIMEOUT_SECONDS, TimeUnit.SECONDS) != null;
    }

    /** Waits until the initializer pod reaches Succeeded; returns false on timeout or failure. */
    public boolean awaitInitializerSucceeded(String projectId) {
        return client.pods().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.initializerPodName(projectId))
            .waitUntilCondition(this::isSucceeded, READY_TIMEOUT_SECONDS, TimeUnit.SECONDS) != null;
    }

    private boolean isReady(Pod pod) {
        return pod != null && pod.getStatus() != null && pod.getStatus().getConditions().stream()
            .anyMatch(condition -> "Ready".equals(condition.getType()) && "True".equals(condition.getStatus()));
    }

    private boolean isSucceeded(Pod pod) {
        return pod != null && pod.getStatus() != null && "Succeeded".equals(pod.getStatus().getPhase());
    }
}
