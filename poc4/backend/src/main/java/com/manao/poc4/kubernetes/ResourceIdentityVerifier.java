package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.Pod;

/**
 * Cross-confirms that a Kubernetes Job/Pod belongs to a database Run before any attach, watch or
 * settle decision: DB reference, ownerReference (by UID, not only by name), server labels and the
 * fixed application container must all agree; any mismatch refuses the resource instead of
 * guessing a similar one.
 */
public final class ResourceIdentityVerifier {
    public static final String APPLICATION_CONTAINER = "maven";
    public static final String LABEL_RUN_ID = "manao.poc4/run-id";
    public static final String LABEL_PROJECT_ID = "manao.poc4/project-id";

    /**
     * Server-label, ownerReference and container-presence checks only: who owns this Pod. No
     * phase or container-state requirement, so callers can distinguish "foreign resource" from
     * "not observable yet".
     */
    public boolean verifyOwnership(com.manao.poc4.run.RunRecord run, Job job, Pod pod) {
        if (run == null || job == null || pod == null) return false;
        if (job.getMetadata() == null || job.getMetadata().getLabels() == null
            || !run.id().equals(job.getMetadata().getLabels().get(LABEL_RUN_ID))
            || !run.projectId().equals(job.getMetadata().getLabels().get(LABEL_PROJECT_ID))) {
            return false;
        }
        if (pod.getMetadata() == null || pod.getMetadata().getOwnerReferences() == null) return false;
        String jobUid = job.getMetadata().getUid();
        boolean ownedByJob = jobUid != null && pod.getMetadata().getOwnerReferences().stream()
            .anyMatch(owner -> "Job".equals(owner.getKind())
                && ("manao-run-" + run.id()).equals(owner.getName())
                && jobUid.equals(owner.getUid()));
        if (!ownedByJob) return false;
        if (pod.getSpec() == null || pod.getSpec().getContainers() == null) return false;
        return pod.getSpec().getContainers().stream()
            .anyMatch(container -> APPLICATION_CONTAINER.equals(container.getName()));
    }

    /** Ownership plus live/terminal container observability: may facts be read from this Pod. */
    public boolean verify(com.manao.poc4.run.RunRecord run, Job job, Pod pod) {
        if (!verifyOwnership(run, job, pod)) return false;
        if (pod.getStatus() == null) return false;
        String phase = pod.getStatus().getPhase();
        // Live runs need a Running pod; recovery settlement must also accept terminal phases.
        boolean acceptablePhase = "Running".equals(phase) || "Succeeded".equals(phase) || "Failed".equals(phase);
        if (!acceptablePhase) return false;
        var statuses = pod.getStatus().getContainerStatuses();
        if (statuses == null) return false;
        return statuses.stream().anyMatch(status -> APPLICATION_CONTAINER.equals(status.getName())
            && status.getState() != null
            && (status.getState().getRunning() != null || status.getState().getTerminated() != null));
    }
}
