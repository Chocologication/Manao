package com.manao.poc4.run;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Browser-facing Run summary. The policy node is the persisted fixed snapshot; job/pod
 * references and image/env facts never appear here. The verified ready lifetime is only exposed
 * for SERVICE runs — TASK runs keep both fields null.
 */
public record RunSummary(String id, String state, String requestedWorkspaceRevision, JsonNode policy,
                         String createdAt, String startedAt, String finishedAt, String terminationReason,
                         Integer exitCode, boolean logTruncated, long logEvictedBytes, Integer lastLogSeq,
                         String firstReadyAt, String expiresAt) {

    /** Legacy-shape convenience for callers that predate the bounded-web-session summary fields. */
    public RunSummary(String id, String state, String requestedWorkspaceRevision, JsonNode policy,
                      String createdAt, String startedAt, String finishedAt, String terminationReason,
                      Integer exitCode, boolean logTruncated, long logEvictedBytes, Integer lastLogSeq) {
        this(id, state, requestedWorkspaceRevision, policy, createdAt, startedAt, finishedAt,
            terminationReason, exitCode, logTruncated, logEvictedBytes, lastLogSeq, null, null);
    }
}
