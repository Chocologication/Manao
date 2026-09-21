package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.kubernetes.JobCoordinator.ObservationKind;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.util.Optional;
import java.util.OptionalLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Live observation loop over STARTING/RUNNING/RECOVERING/STOPPING runs, driven by
 * identity-verified Job observations. STARTING -> RUNNING happens as soon as the application
 * container is up; a verified READY service receipt persists the immutable lifetime (CAS on the
 * claimed Pod UID) and routes the stable Service to that Pod; terminal facts settle the run.
 * UNKNOWN and IDENTITY_MISMATCH never settle or unlock anything.
 */
public final class RunObservationService {
    private static final Logger LOG = LoggerFactory.getLogger(RunObservationService.class);

    private final RunStore store;
    private final JobCoordinator coordinator;
    private final RunLogIngestor logIngestor;
    private final RunCompletionListener completionListener;
    private final ProjectLifecycleGate lifecycle;
    private final PublicEndpointGateway endpoints;

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor) {
        this(store, coordinator, logIngestor, null, new ProjectLifecycleGate(), null);
    }

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                                 RunCompletionListener completionListener) {
        this(store, coordinator, logIngestor, completionListener, new ProjectLifecycleGate(), null);
    }

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                                 RunCompletionListener completionListener, PublicEndpointGateway endpoints) {
        this(store, coordinator, logIngestor, completionListener, new ProjectLifecycleGate(), endpoints);
    }

    public RunObservationService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                                 RunCompletionListener completionListener, ProjectLifecycleGate lifecycle,
                                 PublicEndpointGateway endpoints) {
        this.store = store;
        this.coordinator = coordinator;
        this.logIngestor = logIngestor;
        this.completionListener = completionListener;
        this.lifecycle = lifecycle;
        this.endpoints = endpoints;
    }

    public void observe() {
        OptionalLong lease = store.acquireFencingToken();
        if (lease.isEmpty()) return;
        for (RunRecord snapshot : store.findRunsInState(RunState.STARTING, RunState.RUNNING,
                RunState.RECOVERING, RunState.STOPPING)) {
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
        JobCoordinator.JobObservation observation = coordinator.observe(run);

        // Handle RECOVERING: check what the cluster actually says before continuing.
        if (run.state() == RunState.RECOVERING) {
            if (observation.kind() == ObservationKind.MISSING) {
                // Job does not exist; safe to mark as FAILED now.
                settleAndComplete(run, RunState.FAILED, "START_FAILED", null);
                return;
            }
            if (observation.kind() != ObservationKind.FOUND) {
                return; // UNKNOWN or IDENTITY_MISMATCH keep RECOVERING; nothing is guessed.
            }
            if (!store.transition(run.id(), run.projectId(), run.version(), RunState.STARTING,
                run.fencingToken(), RunState.RECOVERING)) {
                return;
            }
            run = store.findRun(run.id()).orElse(run);
        }

        if (run.state() == RunState.STOPPING) {
            observeStopping(run, observation);
            return;
        }

        if (observation.kind() != ObservationKind.FOUND) {
            return; // MISSING/UNKNOWN/IDENTITY_MISMATCH: recovery handles absence; never guess.
        }
        JobCoordinator.JobFacts job = observation.facts();
        if (run.state() == RunState.STARTING && job.running()) {
            store.markRunning(run.id(), run.projectId(), run.version());
            run = store.findRun(run.id()).orElse(run);
        }
        if (job.running() && isServiceRun(run)) {
            run = recordReadinessAndRoute(run, observation);
        }
        if (job.running() && job.podName() != null) {
            // Persist the live Pod reference and attach the persistence-first log watch, bound to
            // the claimed Pod UID so a denied replacement Pod can never become the source.
            if (!job.podName().equals(run.podRef())) {
                store.updatePodRef(run.id(), job.podName());
            }
            logIngestor.ensureWatch(run.id(), job.podName(), job.podUid());
        }
        RunRecord settled = run;
        RunStateReducer.settleOutcome(isServiceRun(settled), stopRequested(settled), settled.firstReadyAt() != null,
                job, observation.receipt())
            .ifPresent(outcome -> settleAndComplete(settled, outcome.state(), outcome.terminationReason(),
                job.exitCode()));
    }

    /**
     * Observation covers STOPPING: the run settles only on conclusive evidence — the Job gone
     * with no active matching Pod (a Job 404 alone is not enough), or the verified termination of
     * the claimed application. Unknown, forbidden or mismatched facts keep STOPPING.
     */
    private void observeStopping(RunRecord run, JobCoordinator.JobObservation observation) {
        if (observation.kind() == ObservationKind.MISSING) {
            settleAndComplete(run, RunState.CANCELLED, "USER_STOPPED", null);
            return;
        }
        if (observation.kind() != ObservationKind.FOUND) {
            return; // Unknown/Forbidden keep STOPPING for the next scan.
        }
        JobCoordinator.JobFacts job = observation.facts();
        RunStateReducer.settleOutcome(isServiceRun(run), true, run.firstReadyAt() != null,
                job, observation.receipt())
            .ifPresent(outcome -> settleAndComplete(run, outcome.state(), outcome.terminationReason(),
                job.exitCode()));
    }

    /**
     * The verified READY receipt is the only lifetime source: its firstReadyAt is persisted once
     * (CAS on the claimed Pod UID), then the claimed Pod gets its server-side identity label and
     * the stable Service routes to it. Re-reading the receipt later never moves the lifetime.
     */
    private RunRecord recordReadinessAndRoute(RunRecord run, JobCoordinator.JobObservation observation) {
        RunExecutionReceipt receipt = observation.receipt();
        JobCoordinator.JobFacts facts = observation.facts();
        if (receipt == null || !RunExecutionReceipt.STATE_READY.equals(receipt.state())
            || receipt.firstReadyAt() == null || receipt.expiresAt() == null || facts.podUid() == null) {
            return run;
        }
        if (run.firstReadyAt() == null && store.recordFirstReady(run.id(), facts.podUid(),
                receipt.firstReadyAt(), receipt.expiresAt())) {
            run = store.findRun(run.id()).orElse(run);
        }
        if (run.firstReadyAt() != null && endpoints != null) {
            try {
                endpoints.routeToRun(run.projectId(), run.id(), facts.podUid());
            } catch (RuntimeException ex) {
                // Routing retries on the next scan; the ready lifetime stays untouched.
                LOG.warn("service routing failed; the next observation re-attempts it: runId={}", run.id(), ex);
            }
        }
        return run;
    }

    private static boolean stopRequested(RunRecord run) {
        return run.state() == RunState.STOPPING || "USER_STOPPED".equals(run.terminationIntent());
    }

    private static boolean isServiceRun(RunRecord run) {
        try {
            return RunPolicy.fromJson(run.policyJson()).isService();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private void settleAndComplete(RunRecord run, RunState state, String reason, Integer exitCode) {
        if (!store.settle(run.id(), state, reason, exitCode)) return;
        if (endpoints != null && isServiceRun(run)) {
            try {
                endpoints.withdraw(run.projectId());
            } catch (RuntimeException ex) {
                LOG.warn("endpoint withdraw failed after settlement: runId={}", run.id(), ex);
            }
        }
        logIngestor.finish(run.id());
        if (completionListener != null) completionListener.onRunCompleted(run.id());
    }
}
