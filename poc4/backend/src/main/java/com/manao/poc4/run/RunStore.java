package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;

/** Persistence boundary for Runs; the unique active-run marker enforces one Run per project. */
public interface RunStore {
    ProjectRecord findProjectForOwner(String ownerId, String projectId);

    /**
     * Acquires or renews the instance lease and returns the current fencing token. The token is
     * bumped only when the holder changes (real takeover); a same-holder renewal never bumps.
     * After a takeover every active Run row is re-stamped with the new token.
     */
    OptionalLong acquireFencingToken();

    InsertResult insertRun(RunRecord record, long fencingToken);

    Optional<RunRecord> findActiveRun(String projectId);

    Optional<RunRecord> findRunForOwner(String ownerId, String projectId, String runId);

    /** Internal by-id lookup used by ticket-bound WebSocket flows. */
    Optional<RunRecord> findRun(String runId);

    List<RunRecord> listForOwner(String ownerId, String projectId, int limit);

    boolean transition(String runId, String projectId, long expectedVersion, RunState next, long fencingToken,
                       RunState... allowedStates);

    /**
     * STARTING -> RUNNING with started_at; renews the instance lease inside and guards the
     * conditional UPDATE on the token returned by that renewal.
     */
    boolean markRunning(String runId, String projectId, long expectedVersion);

    /** Persists both server-internal references; podRef may be null while no live Pod exists yet. */
    void updateJobFacts(String runId, String jobRef, String podRef);

    /** Updates only the live Pod reference, e.g. when the Job Pod appears or is recreated. */
    void updatePodRef(String runId, String podRef);

    /**
     * Terminal settlement; renews the instance lease inside and guards the conditional UPDATE on
     * the token returned by that renewal (active runs only, never re-settling the same state).
     */
    boolean settle(String runId, RunState state, String terminationReason, Integer exitCode);

    List<RunRecord> findRunsInState(RunState... states);

    enum InsertResult { INSERTED, ACTIVE_RUN_EXISTS }

    record ProjectRecord(String id, String ownerId, String state, long revision) { }
}
