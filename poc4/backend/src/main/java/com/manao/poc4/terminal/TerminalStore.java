package com.manao.poc4.terminal;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/** Single-use terminal ticket storage; the terminal_session row itself carries the ticket hash. */
public interface TerminalStore {
    boolean insertReservation(ReservationRecord record);

    /** Atomically consumes a RESERVED session into LIVE by ticket hash and expiry. */
    Optional<SessionRecord> consumeReservation(String ticketHash);

    Optional<SessionRecord> findSession(String sessionId);

    boolean settle(String sessionId, String state, String closeReason, Integer exitCode);

    record ReservationRecord(String sessionId, String projectId, String runId, String userId,
                             String ticketHash, Instant expiresAt) { }

    record SessionRecord(String sessionId, String projectId, String runId, String userId, String ticketHash,
                         Instant expiresAt, Instant consumedAt, String state, String podRef, String containerRef,
                         String closeReason) { }
}
