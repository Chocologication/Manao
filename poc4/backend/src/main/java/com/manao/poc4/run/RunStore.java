package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;

/** Persistence boundary for Runs; the unique active-run marker enforces one Run per project. */
public interface RunStore {
    ProjectRecord findProjectForOwner(String ownerId, String projectId);

    /** Acquires or renews the instance lease and returns the current fencing token. */
    OptionalLong acquireFencingToken();

    InsertResult insertRun(RunRecord record, long fencingToken);

    Optional<RunRecord> findActiveRun(String projectId);

    Optional<RunRecord> findRunForOwner(String ownerId, String projectId, String runId);

    /** Internal by-id lookup used by ticket-bound WebSocket flows. */
    Optional<RunRecord> findRun(String runId);

    List<RunRecord> listForOwner(String ownerId, String projectId, int limit);

    boolean transition(String runId, String projectId, long expectedVersion, RunState next, long fencingToken,
                       RunState... allowedStates);

    /** STARTING -> RUNNING with started_at; guarded by the fencing token. */
    boolean markRunning(String runId, String projectId, long expectedVersion, long fencingToken);

    void updateJobFacts(String runId, String jobRef);

    boolean settle(String runId, RunState state, String terminationReason, Integer exitCode, long fencingToken);

    List<RunRecord> findRunsInState(RunState... states);

    enum InsertResult { INSERTED, ACTIVE_RUN_EXISTS }

    record ProjectRecord(String id, String ownerId, String state, long revision) { }
}
