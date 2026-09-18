package com.manao.poc4.audit;

import java.time.Instant;
import java.util.List;

/** Persistence boundary for structured terminal audits produced by the server-owned wrapper. */
public interface AuditStore {
    String insertRunning(String sessionId, String projectId, String runId, String userId, long seq,
                         String command, boolean sensitiveDetected, String trustLevel, Instant startedAt);

    boolean settle(String auditId, String state, Integer exitCode, Instant finishedAt);

    List<AuditRecord> list(String runId, int limit);

    /** Keyset pagination: entries strictly older than (startedAt, idExclusive). */
    List<AuditRecord> listBefore(String runId, Instant startedAt, String idExclusive, int limit);

    int deleteExpiredBefore(Instant cutoff);

    record AuditRecord(String id, String sessionId, long seq, String command, String state,
                       Instant startedAt, Instant finishedAt, Integer exitCode, boolean sensitiveDetected) { }
}
