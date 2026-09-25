package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.time.Instant;

/**
 * Persistence-facing Run record; job/pod references are server-internal only. The bounded-web
 * session columns (first ready time, immutable expiry, the claimed execution Pod UID and the
 * persisted termination intent) survive backend restarts so intent is never lost.
 */
public record RunRecord(String id, String projectId, long requestedRevision, RunState state, String policyJson,
                        String jobRef, String podRef, Instant startedAt, Instant finishedAt, Integer exitCode,
                        String terminationReason, long version, Instant createdAt, long fencingToken,
                        Instant firstReadyAt, Instant expiresAt, String executionPodUid, String terminationIntent) {

    /** Legacy-shape convenience for callers that predate the bounded-web-session columns. */
    public RunRecord(String id, String projectId, long requestedRevision, RunState state, String policyJson,
                     String jobRef, String podRef, Instant startedAt, Instant finishedAt, Integer exitCode,
                     String terminationReason, long version, Instant createdAt, long fencingToken) {
        this(id, projectId, requestedRevision, state, policyJson, jobRef, podRef, startedAt, finishedAt,
            exitCode, terminationReason, version, createdAt, fencingToken, null, null, null, null);
    }
}
