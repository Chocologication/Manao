package com.manao.poc4.run;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.RunState;
import java.util.Map;
import java.util.Optional;

/**
 * Pure Run state machine. Locking states (STARTING, RUNNING, STOPPING, RECOVERING) block a
 * second Run and workspace writes; terminal states absorb every event.
 *
 * <p>{@link #settleOutcome} is the single terminal classification shared by live observation and
 * startup recovery: Job {@code DeadlineExceeded} wins over an ordinary failed classification, a
 * web application that exits (even with exit 0) is APPLICATION_EXITED rather than
 * BUILD_SUCCEEDED, a user stop is USER_STOPPED and startup/lifetime budgets map to their own
 * reasons. No caller keeps a second copy of these branches.</p>
 */
public final class RunStateReducer {
    public enum Event {
        JOB_STARTED, JOB_SUCCEEDED, JOB_FAILED, JOB_DEADLINE_EXCEEDED,
        USER_STOP_REQUESTED, STOP_CONFIRMED, START_FAILED, RECOVERY_ENTERED, RECOVERY_FAILED_MISMATCH
    }

    public record Outcome(RunState state, String terminationReason) { }

    private static final Map<RunState, Map<Event, Outcome>> TRANSITIONS = Map.of(
        RunState.STARTING, Map.of(
            Event.JOB_STARTED, new Outcome(RunState.RUNNING, null),
            Event.START_FAILED, new Outcome(RunState.FAILED, "START_FAILED"),
            Event.USER_STOP_REQUESTED, new Outcome(RunState.STOPPING, null),
            Event.RECOVERY_ENTERED, new Outcome(RunState.RECOVERING, null)),
        RunState.RUNNING, Map.of(
            Event.JOB_SUCCEEDED, new Outcome(RunState.SUCCEEDED, "BUILD_SUCCEEDED"),
            Event.JOB_FAILED, new Outcome(RunState.FAILED, "BUILD_FAILED"),
            Event.JOB_DEADLINE_EXCEEDED, new Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"),
            Event.USER_STOP_REQUESTED, new Outcome(RunState.STOPPING, null),
            Event.RECOVERY_ENTERED, new Outcome(RunState.RECOVERING, null)),
        RunState.STOPPING, Map.of(
            Event.STOP_CONFIRMED, new Outcome(RunState.CANCELLED, "USER_STOPPED"),
            Event.RECOVERY_ENTERED, new Outcome(RunState.RECOVERING, null)),
        RunState.RECOVERING, Map.of(
            Event.JOB_STARTED, new Outcome(RunState.RUNNING, null),
            Event.JOB_SUCCEEDED, new Outcome(RunState.SUCCEEDED, "BUILD_SUCCEEDED"),
            Event.JOB_FAILED, new Outcome(RunState.FAILED, "BUILD_FAILED"),
            Event.JOB_DEADLINE_EXCEEDED, new Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"),
            Event.STOP_CONFIRMED, new Outcome(RunState.CANCELLED, "USER_STOPPED"),
            Event.RECOVERY_FAILED_MISMATCH, new Outcome(RunState.FAILED, "RECOVERY_FAILED")));

    private RunStateReducer() { }

    public static Optional<Outcome> reduce(RunState state, Event event) {
        Map<Event, Outcome> allowed = TRANSITIONS.get(state);
        if (allowed == null) return Optional.empty();
        return Optional.ofNullable(allowed.get(event));
    }

    /**
     * Terminal classification from identity-verified facts plus the execution receipt. A null
     * {@code facts} means the Job and every matching Pod are gone: only a persisted stop intent
     * settles there, absence of a live run is otherwise the recovery fail-closed decision. A
     * DENIED receipt (a replacement container that lost the claim) never settles the claimed run.
     */
    public static Optional<Outcome> settleOutcome(boolean serviceRun, boolean stopRequested, boolean readyRecorded,
                                                  JobCoordinator.JobFacts facts, RunExecutionReceipt receipt) {
        if (facts == null) {
            if (stopRequested) {
                return Optional.of(new Outcome(RunState.CANCELLED, "USER_STOPPED"));
            }
            return Optional.empty();
        }
        // The Job condition DeadlineExceeded (type=Failed, reason=DeadlineExceeded) outranks the
        // ordinary failed classification for both execution kinds.
        if (facts.deadlineExceeded()) {
            if (serviceRun && !readyRecorded && !receiptIndicatesReady(receipt)) {
                return Optional.of(new Outcome(RunState.TIMED_OUT, "STARTUP_TIME_LIMIT_EXCEEDED"));
            }
            return Optional.of(new Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"));
        }
        if (!serviceRun) {
            if (facts.succeeded()) {
                return Optional.of(new Outcome(RunState.SUCCEEDED, "BUILD_SUCCEEDED"));
            }
            if (facts.failed()) {
                return Optional.of(new Outcome(RunState.FAILED, "BUILD_FAILED"));
            }
            return Optional.empty();
        }
        if (receipt != null) {
            return switch (receipt.state()) {
                case RunExecutionReceipt.STATE_TIMED_OUT ->
                    Optional.of(new Outcome(RunState.TIMED_OUT, "TIME_LIMIT_EXCEEDED"));
                case RunExecutionReceipt.STATE_STARTUP_TIMED_OUT ->
                    Optional.of(new Outcome(RunState.TIMED_OUT, "STARTUP_TIME_LIMIT_EXCEEDED"));
                case RunExecutionReceipt.STATE_EXITED -> "USER_STOPPED".equals(receipt.reason())
                    ? Optional.of(new Outcome(RunState.CANCELLED, "USER_STOPPED"))
                    : Optional.of(new Outcome(RunState.FAILED, "APPLICATION_EXITED"));
                case RunExecutionReceipt.STATE_CLAIMED, RunExecutionReceipt.STATE_READY -> facts.applicationTerminated()
                    // A stale pre-termination receipt carries no exit reason: the persisted stop
                    // intent decides between a user stop and an unexpected application exit.
                    ? Optional.of(stopRequested
                        ? new Outcome(RunState.CANCELLED, "USER_STOPPED")
                        : new Outcome(RunState.FAILED, "APPLICATION_EXITED"))
                    : Optional.empty();
                default -> Optional.empty(); // DENIED or unknown: the claim owner decides the outcome
            };
        }
        if (facts.applicationTerminated()) {
            return stopRequested
                ? Optional.of(new Outcome(RunState.CANCELLED, "USER_STOPPED"))
                : Optional.of(new Outcome(RunState.FAILED, "APPLICATION_EXITED"));
        }
        return Optional.empty();
    }

    private static boolean receiptIndicatesReady(RunExecutionReceipt receipt) {
        return receipt != null && receipt.indicatesReady();
    }

    public static boolean isTerminal(RunState state) {
        return state == RunState.SUCCEEDED || state == RunState.FAILED
            || state == RunState.CANCELLED || state == RunState.TIMED_OUT;
    }

    public static boolean isLocking(RunState state) {
        return !isTerminal(state);
    }
}
