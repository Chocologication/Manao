package com.manao.poc4.run;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Browser-facing Run summary. The policy node is the persisted fixed snapshot; job/pod
 * references and image/env facts never appear here.
 */
public record RunSummary(String id, String state, String requestedWorkspaceRevision, JsonNode policy,
                         String createdAt, String startedAt, String finishedAt, String terminationReason,
                         Integer exitCode, boolean logTruncated, long logEvictedBytes, Integer lastLogSeq) { }
