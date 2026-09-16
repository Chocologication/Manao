package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectLifecycleGate;
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
    private final RunCompletionListener completionListener;
    private final ProjectLifecycleGate lifecycle;

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor) {
        this(store, coordinator, logIngestor, null, new ProjectLifecycleGate());
    }

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                                 RunCompletionListener completionListener) {
        this(store, coordinator, logIngestor, completionListener, new ProjectLifecycleGate());
    }

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                                 RunCompletionListener completionListener, ProjectLifecycleGate lifecycle) {
        this.store = store;
        this.coordinator = coordinator;
        this.logIngestor = logIngestor;
        this.completionListener = completionListener;
        this.lifecycle = lifecycle;
    }

    public void observe() {
        OptionalLong lease = store.acquireFencingToken();
        if (lease.isEmpty()) return;
        for (RunRecord snapshot : store.findRunsInState(RunState.STARTING, RunState.RUNNING, RunState.RECOVERING)) {
            try (var projectLease = lifecycle.tryAcquire(snapshot.projectId()).orElse(null)) {
                if (projectLease == null) {
                    continue;
                }
                observeOne(snapshot);
            }
        }
    }

    private void observeOne(RunRecord snapshot) {
        RunRecord run = store.findRun(snapshot.id()).orElse(null);
        if (run == null) {
            return;
        }
        RunStore.ProjectRecord project = store.findProject(run.projectId());
        if (project != null && "DELETING".equals(project.state())) {
            return;
        }
        Optional<JobCoordinator.JobFacts> facts = coordinator.facts(run);

        // Handle RECOVERING: check if Job actually exists
        if (run.state() == RunState.RECOVERING) {
            if (facts.isEmpty()) {
                // Job does not exist; safe to mark as FAILED now
                settleAndComplete(run, RunState.FAILED, "START_FAILED", null);
                return;
            } else {
                // Job exists; transition to STARTING to continue normal flow
                store.transition(run.id(), run.projectId(), run.version(), RunState.STARTING,
                    run.fencingToken(), RunState.RECOVERING);
                run = store.findRun(run.id()).orElse(run);
            }
        }

        if (facts.isEmpty()) return; // job not observable yet; recovery handles absence
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
            settleAndComplete(run, RunState.SUCCEEDED, "BUILD_SUCCEEDED",
                job.exitCode() == null ? 0 : job.exitCode());
        } else if (job.failed()) {
            settleAndComplete(run, RunState.FAILED, "BUILD_FAILED", job.exitCode());
        } else if (job.deadlineExceeded()) {
            settleAndComplete(run, RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED", null);
        }
    }

    private void settleAndComplete(RunRecord run, RunState state, String reason, Integer exitCode) {
        if (!store.settle(run.id(), state, reason, exitCode)) return;
        logIngestor.finish(run.id());
        if (completionListener != null) completionListener.onRunCompleted(run.id());
    }
}
