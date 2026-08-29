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

    InsertResult insertRun(RunRecord record);

    Optional<RunRecord> findActiveRun(String projectId);

    Optional<RunRecord> findRunForOwner(String ownerId, String projectId, String runId);

    List<RunRecord> listForOwner(String ownerId, String projectId, int limit);

    boolean transition(String runId, String projectId, long expectedVersion, RunState next, RunState... allowedStates);

    void updateJobFacts(String runId, String jobRef);

    boolean settle(String runId, RunState state, String terminationReason, Integer exitCode);

    List<RunRecord> findRunsInState(RunState... states);

    enum InsertResult { INSERTED, ACTIVE_RUN_EXISTS }

    record ProjectRecord(String id, String ownerId, String state, long revision) { }
}
