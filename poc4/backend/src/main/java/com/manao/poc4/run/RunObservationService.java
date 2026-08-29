package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.RunState;
import java.util.Optional;
import java.util.OptionalLong;

/**
 * Live observation loop: drives STARTING/RUNNING runs from identity-verified Job facts.
 * STARTING -> RUNNING happens as soon as the application container is up; terminal facts settle
 * the run. Every write carries the current fencing token; without the lease nothing is written.
 */
public final class RunObservationService {
    private final RunStore store;
    private final JobCoordinator coordinator;

    public RunObservationService(RunStore store, JobCoordinator coordinator) {
        this.store = store;
        this.coordinator = coordinator;
    }

    public void observe() {
        OptionalLong lease = store.acquireFencingToken();
        if (lease.isEmpty()) return;
        long token = lease.getAsLong();
        for (RunRecord run : store.findRunsInState(RunState.STARTING, RunState.RUNNING)) {
            Optional<JobCoordinator.JobFacts> facts = coordinator.facts(run);
            if (facts.isEmpty()) continue; // job not observable yet; recovery handles absence
            JobCoordinator.JobFacts job = facts.get();
            if (run.state() == RunState.STARTING && job.running()) {
                store.markRunning(run.id(), run.projectId(), run.version(), token);
                run = store.findRun(run.id()).orElse(run);
            }
            if (job.succeeded()) {
                store.settle(run.id(), RunState.SUCCEEDED, "BUILD_SUCCEEDED",
                    job.exitCode() == null ? 0 : job.exitCode(), token);
            } else if (job.failed()) {
                store.settle(run.id(), RunState.FAILED, "BUILD_FAILED", job.exitCode(), token);
            } else if (job.deadlineExceeded()) {
                store.settle(run.id(), RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED", null, token);
            }
        }
    }
}
