package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
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
        if (resource == null || resource.getMetadata() == null) return false;
        Map<String, String> labels = resource.getMetadata().getLabels();
        return labels != null && projectId.equals(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID));
    }

    @Override public boolean initializerSucceeded(String projectId) {
        // Fail closed: an invisible or absent initializer is never treated as success. Only a
        // Pod that is currently observable AND Succeeded counts; recovery may treat a
        // confirmed-then-deleted initializer differently, provisioning may not.
        Pod pod = client.pods().inNamespace(namespace)
            .withName(WorkspaceResourceFactory.initializerPodName(projectId)).get();
        if (pod == null) return false;
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
        createIfAbsent(pvc, client.persistentVolumeClaims().inNamespace(namespace).resource(pvc), projectId(pvc));
    }

    @Override public void createPod(Pod pod) {
        createIfAbsent(pod, client.pods().inNamespace(namespace).resource(pod), projectId(pod));
    }

    @Override public void createService(Service service) {
        createIfAbsent(service, client.services().inNamespace(namespace).resource(service), projectId(service));
    }

    /**
     * Idempotent create using only the get/create verbs the design Role grants (no patch/update).
     * An existing resource is reused only when its project identity matches; a create race is
     * re-verified the same way instead of blind retry.
     */
    private <T extends io.fabric8.kubernetes.api.model.HasMetadata> void createIfAbsent(
        T resource, io.fabric8.kubernetes.client.dsl.Resource<T> handle, String projectId) {
        T existing = handle.get();
        if (existing != null) {
            if (!matchesProject(existing, projectId)) {
                throw new IllegalStateException("existing resource does not match the project identity");
            }
            return;
        }
        try {
            handle.create();
        } catch (io.fabric8.kubernetes.client.KubernetesClientException ex) {
            if (ex.getCode() != 409) throw ex;
            T after = handle.get();
            if (after == null || !matchesProject(after, projectId)) throw ex;
        }
    }

    private static String projectId(io.fabric8.kubernetes.api.model.HasMetadata resource) {
        Map<String, String> labels = resource.getMetadata().getLabels();
        if (labels == null) throw new IllegalArgumentException("resource lacks project labels");
        String projectId = labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID);
        if (projectId == null) throw new IllegalArgumentException("resource lacks the project label");
        return projectId;
    }

    @Override public void deleteProjectResources(String projectId) {
        Map<String, String> labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        for (Job job : client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems()) {
            client.batch().v1().jobs().inNamespace(namespace).withName(job.getMetadata().getName()).delete();
        }
        deleteProjectWorkloads(projectId);
        waitForProjectWorkloadsGone(labels, deadline);
        for (PersistentVolumeClaim pvc : client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).list().getItems()) {
            client.persistentVolumeClaims().inNamespace(namespace).withName(pvc.getMetadata().getName()).delete();
        }
        waitForProjectResourcesGone(labels, deadline);
    }

    private void waitForProjectWorkloadsGone(Map<String, String> labels, long deadline) {
        while (true) {
            boolean gone = client.pods().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty()
                && client.services().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty()
                && client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty();
            if (gone) return;
            sleepUntilCleanupDeadline(deadline);
        }
    }

    private void waitForProjectResourcesGone(Map<String, String> labels, long deadline) {
        while (true) {
            boolean gone = client.pods().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty()
                && client.services().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty()
                && client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty()
                && client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).list().getItems().isEmpty();
            if (gone) return;
            sleepUntilCleanupDeadline(deadline);
        }
    }

    private static void sleepUntilCleanupDeadline(long deadline) {
        if (System.nanoTime() >= deadline) {
            throw new IllegalStateException("project Kubernetes resources did not finish deleting");
        }
        try {
            Thread.sleep(250);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("project Kubernetes cleanup was interrupted", ex);
        }
    }

    /**
     * Removes only the project workloads (Pod/Service) and preserves the PVC: used by the
     * WORKSPACE_RECONCILIATION_REQUIRED path where the design demands the file evidence stay
     * on disk ("保留现场"). Never deletes the PVC here.
     */
    public void deleteProjectWorkloads(String projectId) {
        // List + per-item delete: the design Role grants only the delete verb, NOT deletecollection.
        Map<String, String> labels = WorkspaceResourceFactory.projectLabels(projectId);
        for (Pod pod : client.pods().inNamespace(namespace).withLabels(labels).list().getItems()) {
            client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).withGracePeriod(0).delete();
        }
        for (Service service : client.services().inNamespace(namespace).withLabels(labels).list().getItems()) {
            client.services().inNamespace(namespace).withName(service.getMetadata().getName()).delete();
        }
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
