package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.persistence.RunState;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class RunStateReducerTest {
    @Test
    void startingProgressesToRunningAndTerminalStates() {
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.JOB_STARTED))
            .contains(new RunStateReducer.Outcome(RunState.RUNNING, null));
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.START_FAILED))
            .contains(new RunStateReducer.Outcome(RunState.FAILED, "START_FAILED"));
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.USER_STOP_REQUESTED))
            .contains(new RunStateReducer.Outcome(RunState.STOPPING, null));
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.RECOVERY_ENTERED))
            .contains(new RunStateReducer.Outcome(RunState.RECOVERING, null));
    }

    @Test
    void runningSettlesToEveryTerminalState() {
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.JOB_SUCCEEDED))
            .contains(new RunStateReducer.Outcome(RunState.SUCCEEDED, "BUILD_SUCCEEDED"));
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.JOB_FAILED))
            .contains(new RunStateReducer.Outcome(RunState.FAILED, "BUILD_FAILED"));
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.JOB_DEADLINE_EXCEEDED))
            .contains(new RunStateReducer.Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"));
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.USER_STOP_REQUESTED))
            .contains(new RunStateReducer.Outcome(RunState.STOPPING, null));
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.RECOVERY_ENTERED))
            .contains(new RunStateReducer.Outcome(RunState.RECOVERING, null));
    }

    @Test
    void stoppingConfirmsAsCancelledAndStaysLockedUntilConfirmation() {
        assertThat(RunStateReducer.reduce(RunState.STOPPING, RunStateReducer.Event.STOP_CONFIRMED))
            .contains(new RunStateReducer.Outcome(RunState.CANCELLED, "USER_STOPPED"));
        assertThat(RunStateReducer.reduce(RunState.STOPPING, RunStateReducer.Event.RECOVERY_ENTERED))
            .contains(new RunStateReducer.Outcome(RunState.RECOVERING, null));
        assertThat(RunStateReducer.reduce(RunState.STOPPING, RunStateReducer.Event.JOB_SUCCEEDED)).isEmpty();
    }

    @Test
    void recoveringSettlesFromJobFactsOrFailClosed() {
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.JOB_STARTED))
            .contains(new RunStateReducer.Outcome(RunState.RUNNING, null));
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.JOB_SUCCEEDED))
            .contains(new RunStateReducer.Outcome(RunState.SUCCEEDED, "BUILD_SUCCEEDED"));
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.JOB_FAILED))
            .contains(new RunStateReducer.Outcome(RunState.FAILED, "BUILD_FAILED"));
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.JOB_DEADLINE_EXCEEDED))
            .contains(new RunStateReducer.Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"));
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.STOP_CONFIRMED))
            .contains(new RunStateReducer.Outcome(RunState.CANCELLED, "USER_STOPPED"));
        assertThat(RunStateReducer.reduce(RunState.RECOVERING, RunStateReducer.Event.RECOVERY_FAILED_MISMATCH))
            .contains(new RunStateReducer.Outcome(RunState.FAILED, "RECOVERY_FAILED"));
    }

    @Test
    void terminalStatesNeverTransition() {
        for (RunState terminal : java.util.List.of(RunState.SUCCEEDED, RunState.FAILED,
            RunState.CANCELLED, RunState.TIMED_OUT)) {
            for (RunStateReducer.Event event : RunStateReducer.Event.values()) {
                assertThat(RunStateReducer.reduce(terminal, event)).isEmpty();
            }
        }
    }

    @Test
    void lockingStatesRejectPrematureSettlement() {
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.JOB_SUCCEEDED)).isEmpty();
        assertThat(RunStateReducer.reduce(RunState.STARTING, RunStateReducer.Event.JOB_FAILED)).isEmpty();
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.START_FAILED)).isEmpty();
        assertThat(RunStateReducer.reduce(RunState.RUNNING, RunStateReducer.Event.STOP_CONFIRMED)).isEmpty();
    }

    @Test
    void reasonMatchesStateContract() {
        for (RunStateReducer.Event event : RunStateReducer.Event.values()) {
            Optional<RunStateReducer.Outcome> outcome = RunStateReducer.reduce(RunState.RUNNING, event);
            outcome.ifPresent(value -> {
                if (RunStateReducer.isTerminal(value.state())) {
                    assertThat(value.terminationReason()).isNotNull();
                } else {
                    assertThat(value.terminationReason()).isNull();
                }
            });
        }
    }

    @Test
    void aTerminatedServiceRunWithOnlyAStaleReadyReceiptHonorsTheStopIntent() {
        com.manao.poc4.kubernetes.JobCoordinator.JobFacts terminated =
            new com.manao.poc4.kubernetes.JobCoordinator.JobFacts(false, false, false, false, 143,
                "pod-1", "uid-1", false, true);
        // The supervisor never wrote EXITED (hard kill): a stale READY receipt is all that exists.
        RunExecutionReceipt staleReady = RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=uid-1\nstate=READY\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n");
        // With a persisted stop intent the run is a user stop, not an unexpected application exit.
        assertThat(RunStateReducer.settleOutcome(true, true, true, terminated, staleReady))
            .contains(new RunStateReducer.Outcome(RunState.CANCELLED, "USER_STOPPED"));
        // Without one it stays an unexpected exit.
        assertThat(RunStateReducer.settleOutcome(true, false, true, terminated, staleReady))
            .contains(new RunStateReducer.Outcome(RunState.FAILED, "APPLICATION_EXITED"));
    }
}
