package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.RunState;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;

/**
 * Startup recovery: only unfinished Runs become RECOVERING, then every recovered Run is settled
 * from identity-verified Kubernetes facts or failed closed when the Job is missing/mismatched.
 */
public final class RunRecoveryService {
    private final RunStore store;
    private final JobCoordinator coordinator;

    public RunRecoveryService(RunStore store, JobCoordinator coordinator) {
        this.store = store;
        this.coordinator = coordinator;
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
            store.transition(run.id(), run.projectId(), run.version(), RunState.RECOVERING,
                token, RunState.STARTING, RunState.RUNNING, RunState.STOPPING);
        }
        for (RunRecord run : store.findRunsInState(RunState.RECOVERING)) {
            processed.add(run.id());
            Optional<JobCoordinator.JobFacts> facts = coordinator.facts(run);
            if (facts.isEmpty()) {
                if (settle(run, RunState.FAILED, "RECOVERY_FAILED", null, token)) failedClosed.add(run.id());
                continue;
            }
            JobCoordinator.JobFacts job = facts.get();
            if (job.succeeded()) {
                if (settle(run, RunState.SUCCEEDED, "BUILD_SUCCEEDED", job.exitCode() == null ? 0 : job.exitCode(),
                    token)) {
                    settled.add(run.id());
                }
            } else if (job.failed()) {
                if (settle(run, RunState.FAILED, "BUILD_FAILED", job.exitCode(), token)) settled.add(run.id());
            } else if (job.deadlineExceeded()) {
                if (settle(run, RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED", null, token)) settled.add(run.id());
            } else if (job.running()) {
                if (store.transition(run.id(), run.projectId(), run.version(), RunState.RUNNING,
                    token, RunState.RECOVERING)) {
                    resumed.add(run.id());
                }
            }
            // Inconclusive facts keep the Run in RECOVERING; a later scan settles it.
        }
        return new RecoveryReport(List.copyOf(processed), List.copyOf(settled), List.copyOf(resumed),
            List.copyOf(failedClosed));
    }

    private boolean settle(RunRecord run, RunState state, String reason, Integer exitCode, long token) {
        return store.settle(run.id(), state, reason, exitCode, token);
    }
}
