package com.manao.poc4.kubernetes;

import com.manao.poc4.run.RunRecord;
import java.util.Optional;

/** Kubernetes Job coordination for Maven Runs; implementations verify resource identity internally. */
public interface JobCoordinator {
    /** Idempotently ensures the Job exists for this run and returns its server-derived reference. */
    String ensureJob(RunRecord run, String projectId);

    /** Identity-verified job facts; empty means the job is missing or does not match the run. */
    Optional<JobFacts> facts(RunRecord run);

    /** Deletes the Job; safe to call repeatedly. */
    boolean stop(String jobName);

    record JobFacts(boolean running, boolean succeeded, boolean failed, boolean deadlineExceeded, Integer exitCode) { }
}
