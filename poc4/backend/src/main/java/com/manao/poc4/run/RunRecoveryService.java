package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.kubernetes.JobCoordinator.ObservationKind;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Startup recovery: only unfinished Runs become RECOVERING, then every recovered Run is settled
 * from identity-verified Kubernetes observations. A persisted stop intent is re-driven (the Job
 * delete is re-issued and the run returns to STOPPING) — recovery never resurrects a stopped run
 * into RUNNING and never recreates a lost application execution. Unknown or identity-mismatched
 * facts keep RECOVERING; a definitively missing Job fails closed unless a stop intent settles it.
 */
public final class RunRecoveryService {
    private static final Logger LOG = LoggerFactory.getLogger(RunRecoveryService.class);

    private final RunStore store;
    private final JobCoordinator coordinator;
    private final RunLogIngestor logIngestor;
    private final RunCompletionListener completionListener;
    private final ProjectLifecycleGate lifecycle;
    private final PublicEndpointGateway endpoints;

    public RunRecoveryService(RunStore store, JobCoordinator coordinator) {
        this(store, coordinator, null, null, new ProjectLifecycleGate(), null);
    }

    public RunRecoveryService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                              RunCompletionListener completionListener) {
        this(store, coordinator, logIngestor, completionListener, new ProjectLifecycleGate(), null);
    }

    public RunRecoveryService(RunStore store, JobCoordinator coordinator, RunLogIngestor logIngestor,
                              RunCompletionListener completionListener, ProjectLifecycleGate lifecycle,
                              PublicEndpointGateway endpoints) {
        this.store = store;
        this.coordinator = coordinator;
        this.logIngestor = logIngestor;
        this.completionListener = completionListener;
        this.lifecycle = lifecycle;
        this.endpoints = endpoints;
    }

    public record RecoveryReport(List<String> processed, List<String> settled,
                                 List<String> resumed, List<String> failedClosed) { }

    public RecoveryReport recoverRuns() {
        List<String> processed = new ArrayList<>();
        List<String> settled = new ArrayList<>();
        List<String> resumed = new ArrayList<>();
        List<String> failedClosed = new ArrayList<>();
        // Every recovery write carries the current fencing token; without the lease we cannot act.
        OptionalLong lease = store.acquireFencingToken();
        if (lease.isEmpty()) {
            return new RecoveryReport(List.of(), List.of(), List.of(), List.of());
        }
        long token = lease.getAsLong();
        for (RunRecord run : store.findRunsInState(RunState.STARTING, RunState.RUNNING, RunState.STOPPING)) {
            try (var projectLease = lifecycle.tryAcquire(run.projectId()).orElse(null)) {
                if (projectLease == null || deleting(run.projectId())) {
                    continue;
                }
                store.transition(run.id(), run.projectId(), run.version(), RunState.RECOVERING,
                    token, RunState.STARTING, RunState.RUNNING, RunState.STOPPING);
            }
        }
        for (RunRecord snapshot : store.findRunsInState(RunState.RECOVERING)) {
            try (var projectLease = lifecycle.tryAcquire(snapshot.projectId()).orElse(null)) {
                if (projectLease == null || deleting(snapshot.projectId())) {
                    continue;
                }
                RunRecord run = store.findRun(snapshot.id()).orElse(null);
                if (run == null) {
                    continue;
                }
                processed.add(run.id());
                recoverOne(run, token, settled, resumed, failedClosed);
            }
        }
        return new RecoveryReport(List.copyOf(processed), List.copyOf(settled), List.copyOf(resumed),
            List.copyOf(failedClosed));
    }

    private void recoverOne(RunRecord run, long token, List<String> settled, List<String> resumed,
                            List<String> failedClosed) {
        JobCoordinator.JobObservation observation = coordinator.observe(run);
        boolean serviceRun = isServiceRun(run);
        boolean stopRequested = "USER_STOPPED".equals(run.terminationIntent());
        switch (observation.kind()) {
            case MISSING -> {
                if (stopRequested) {
                    if (settle(run, RunState.CANCELLED, "USER_STOPPED", null)) settled.add(run.id());
                    return;
                }
                if (settle(run, RunState.FAILED, "RECOVERY_FAILED", null)) failedClosed.add(run.id());
                return;
            }
            case UNKNOWN, IDENTITY_MISMATCH -> {
                // The cluster could not be judged; the run stays RECOVERING and keeps its lock.
                return;
            }
            case FOUND -> { /* classified below */ }
        }
        JobCoordinator.JobFacts job = observation.facts();
        Optional<RunStateReducer.Outcome> outcome = RunStateReducer.settleOutcome(serviceRun, stopRequested,
            run.firstReadyAt() != null, job, observation.receipt());
        if (outcome.isPresent()) {
            if (settle(run, outcome.get().state(), outcome.get().terminationReason(), job.exitCode())) {
                settled.add(run.id());
            }
            return;
        }
        if (!job.running()) {
            return; // inconclusive; the next scan re-checks
        }
        if (stopRequested) {
            // Re-drive the persisted stop: delete the Job again and hand back to observation.
            coordinator.stop(jobRef(run));
            store.transition(run.id(), run.projectId(), run.version(), RunState.STOPPING, token,
                RunState.RECOVERING);
            return;
        }
        if (store.transition(run.id(), run.projectId(), run.version(), RunState.RUNNING, token,
            RunState.RECOVERING)) {
            resumed.add(run.id());
        }
    }

    private boolean deleting(String projectId) {
        RunStore.ProjectRecord project = store.findProject(projectId);
        return project != null && "DELETING".equals(project.state());
    }

    private String jobRef(RunRecord run) {
        return run.jobRef() == null ? JobResourceFactory.jobName(run.id()) : run.jobRef();
    }

    private static boolean isServiceRun(RunRecord run) {
        try {
            return RunPolicy.fromJson(run.policyJson()).isService();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private boolean settle(RunRecord run, RunState state, String reason, Integer exitCode) {
        if (!store.settle(run.id(), state, reason, exitCode)) return false;
        if (endpoints != null && isServiceRun(run)) {
            try {
                endpoints.withdraw(run.projectId());
            } catch (RuntimeException ex) {
                LOG.warn("endpoint withdraw failed after recovery settlement: runId={}", run.id(), ex);
            }
        }
        if (logIngestor != null) logIngestor.finish(run.id());
        if (completionListener != null) completionListener.onRunCompleted(run.id());
        return true;
    }
}
