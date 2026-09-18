package com.manao.poc4.kubernetes;

import com.manao.poc4.run.RunRecord;
import java.util.Optional;

/** Kubernetes Job coordination for Maven Runs; implementations verify resource identity internally. */
public interface JobCoordinator {
    /** Idempotently ensures the Job exists for this run and returns its server-derived reference. */
    String ensureJob(RunRecord run, String projectId);

    /** Identity-verified job facts; empty means the job is missing or does not match the run. */
    Optional<JobFacts> facts(RunRecord run);

    /**
     * Resolves the currently live application Pod for a run. Empty unless exactly one Pod matches
     * the server labels, the Job ownerReference chain verifies, and the fixed application
     * container is Running.
     */
    Optional<LivePod> findLivePod(String runId);

    /** Deletes the Job; safe to call repeatedly. */
    boolean stop(String jobName);

    record JobFacts(boolean running, boolean succeeded, boolean failed, boolean deadlineExceeded, Integer exitCode,
                    String podName) { }

    record LivePod(String podName, String containerName) { }
}
