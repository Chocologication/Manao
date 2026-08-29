package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.util.Map;
import java.util.Optional;

/**
 * Pure Run state machine. Locking states (STARTING, RUNNING, STOPPING, RECOVERING) block a
 * second Run and workspace writes; terminal states absorb every event.
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

    public static boolean isTerminal(RunState state) {
        return state == RunState.SUCCEEDED || state == RunState.FAILED
            || state == RunState.CANCELLED || state == RunState.TIMED_OUT;
    }

    public static boolean isLocking(RunState state) {
        return !isTerminal(state);
    }
}
