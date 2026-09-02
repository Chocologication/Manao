package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.persistence.RunState;
import java.util.Optional;
import java.util.OptionalLong;

/**
 * Live observation loop: drives STARTING/RUNNING runs from identity-verified Job facts.
 * STARTING -> RUNNING happens as soon as the application container is up; terminal facts settle
 * the run. The lease is guarded at the top of each scan; markRunning/settle renew it inside and
 * write under the returned token, so nothing is written without a live lease.
 */
public final class RunObservationService {
    private final RunStore store;
    private final JobCoordinator coordinator;
    private final RunLogIngestor logIngestor;

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor) {
        this.store = store;
        this.coordinator = coordinator;
        this.logIngestor = logIngestor;
    }

    public void observe() {
        OptionalLong lease = store.acquireFencingToken();
        if (lease.isEmpty()) return;
        for (RunRecord run : store.findRunsInState(RunState.STARTING, RunState.RUNNING)) {
            Optional<JobCoordinator.JobFacts> facts = coordinator.facts(run);
            if (facts.isEmpty()) continue; // job not observable yet; recovery handles absence
            JobCoordinator.JobFacts job = facts.get();
            if (run.state() == RunState.STARTING && job.running()) {
                store.markRunning(run.id(), run.projectId(), run.version());
                run = store.findRun(run.id()).orElse(run);
            }
            if (job.running() && job.podName() != null) {
                // Persist the live Pod reference and attach the persistence-first log watch.
                if (!job.podName().equals(run.podRef())) {
                    store.updatePodRef(run.id(), job.podName());
                }
                logIngestor.ensureWatch(run.id(), job.podName());
            }
            if (job.succeeded()) {
                store.settle(run.id(), RunState.SUCCEEDED, "BUILD_SUCCEEDED",
                    job.exitCode() == null ? 0 : job.exitCode());
            } else if (job.failed()) {
                store.settle(run.id(), RunState.FAILED, "BUILD_FAILED", job.exitCode());
            } else if (job.deadlineExceeded()) {
                store.settle(run.id(), RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED", null);
            }
        }
    }
}
