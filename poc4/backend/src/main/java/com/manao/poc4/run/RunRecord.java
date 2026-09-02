package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.time.Instant;

/** Persistence-facing Run record; job/pod references are server-internal only. */
public record RunRecord(String id, String projectId, long requestedRevision, RunState state, String policyJson,
                        String jobRef, String podRef, Instant startedAt, Instant finishedAt, Integer exitCode,
                        String terminationReason, long version, Instant createdAt, long fencingToken) { }
