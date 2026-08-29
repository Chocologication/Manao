package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.Pod;

/**
 * Cross-confirms that a Kubernetes Job/Pod belongs to a database Run before any attach, watch or
 * settle decision: DB reference, ownerReference, server labels and the fixed application container
 * must all agree; any mismatch refuses the resource instead of guessing a similar one.
 */
public final class ResourceIdentityVerifier {
    public static final String APPLICATION_CONTAINER = "maven";
    public static final String LABEL_RUN_ID = "manao.poc4/run-id";
    public static final String LABEL_PROJECT_ID = "manao.poc4/project-id";

    public boolean verify(com.manao.poc4.run.RunRecord run, Job job, Pod pod) {
        if (run == null || job == null || pod == null) return false;
        if (job.getMetadata() == null || job.getMetadata().getLabels() == null
            || !run.id().equals(job.getMetadata().getLabels().get(LABEL_RUN_ID))
            || !run.projectId().equals(job.getMetadata().getLabels().get(LABEL_PROJECT_ID))) {
            return false;
        }
        if (pod.getMetadata() == null || pod.getMetadata().getOwnerReferences() == null) return false;
        boolean ownedByJob = pod.getMetadata().getOwnerReferences().stream()
            .anyMatch(owner -> "Job".equals(owner.getKind())
                && ("manao-run-" + run.id()).equals(owner.getName()));
        if (!ownedByJob) return false;
        if (pod.getSpec() == null || pod.getSpec().getContainers() == null) return false;
        boolean hasApplicationContainer = pod.getSpec().getContainers().stream()
            .anyMatch(container -> APPLICATION_CONTAINER.equals(container.getName()));
        if (!hasApplicationContainer) return false;
        if (pod.getStatus() == null || !"Running".equals(pod.getStatus().getPhase())) return false;
        return pod.getStatus().getContainerStatuses() == null || pod.getStatus().getContainerStatuses().stream()
            .anyMatch(status -> APPLICATION_CONTAINER.equals(status.getName()) && status.getState() != null
                && status.getState().getRunning() != null);
    }
}
