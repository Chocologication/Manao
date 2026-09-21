package com.manao.poc4.kubernetes;

import com.manao.poc4.run.RunExecutionReceipt;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.EnvVar;
import java.util.List;
import java.util.Optional;

/**
 * Kubernetes Job coordination for Maven Runs; implementations verify resource identity internally.
 * The observation replaces the former Optional-empty facts contract: MISSING (job gone and no
 * active matching Pod), UNKNOWN (API unavailable or the workload is not observable yet) and
 * IDENTITY_MISMATCH (a look-alike resource) are distinct facts, never one empty guess.
 */
public interface JobCoordinator {
    /** Idempotently ensures the Job exists for this run and returns its server-derived reference. */
    String ensureJob(RunRecord run, String projectId, int primaryPort, List<EnvVar> applicationEnvironment);

    /**
     * Identity-verified observation of the run's single execution. For a FOUND observation the
     * receipt comes either from the fixed exec read on the verified claimed Pod/container while
     * it lives, or from the container termination message after it exits; a receipt whose
     * identity does not match the verified chain is refused (null), never trusted by parse alone.
     */
    JobObservation observe(RunRecord run);

    /**
     * Resolves the currently live application Pod for a run. Empty unless exactly one Pod matches
     * the server labels, the Job ownerReference chain verifies, and the fixed application
     * container is Running.
     */
    Optional<LivePod> findLivePod(String runId);

    /**
     * Deletes the Job with a bounded grace period; true only when the Job is confirmed absent
     * after the call. Pod-level termination is verified separately by the observation loops.
     */
    boolean stop(String jobName);

    record JobFacts(boolean running, boolean succeeded, boolean failed, boolean deadlineExceeded, Integer exitCode,
                    String podName, String podUid, boolean applicationReady, boolean applicationTerminated) { }

    record JobObservation(ObservationKind kind, JobFacts facts, RunExecutionReceipt receipt) { }

    enum ObservationKind { FOUND, MISSING, UNKNOWN, IDENTITY_MISMATCH }

    record LivePod(String podName, String containerName) { }
}
