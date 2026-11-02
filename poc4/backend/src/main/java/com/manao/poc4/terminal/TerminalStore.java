package com.manao.poc4.terminal;

import java.time.Instant;
import java.util.Optional;

/** Single-use terminal ticket storage; the terminal_session row itself carries the ticket hash. */
public interface TerminalStore {
    enum InsertResult { INSERTED, ACTIVE_SESSION_EXISTS, STALE_CREDENTIALS }

    InsertResult insertReservation(ReservationRecord record);

    /** Atomically consumes a RESERVED session into LIVE by ticket hash, expiry and account version. */
    Optional<SessionRecord> consumeReservation(String ticketHash);

    Optional<SessionRecord> findSession(String sessionId);

    boolean settle(String sessionId, String state, String closeReason, Integer exitCode);

    /** Persists the verified live Pod/container references once the PTY exec is established. */
    void updateLiveRefs(String sessionId, String podRef, String containerRef);

    /**
     * Releases a pre-V17 RESERVED row (NULL auth_version) into the existing legal EXPIRED state so
     * the one-live-session unique slot is not blocked forever; run records are never deleted.
     * Returns the number of rows released.
     */
    int expireLegacyReservations(String runId);

    record ReservationRecord(String sessionId, String projectId, String runId, String userId,
                             long authVersion, String ticketHash, Instant expiresAt, int cols, int rows) { }

    record SessionRecord(String sessionId, String projectId, String runId, String userId,
                         long authVersion, String ticketHash, Instant expiresAt, Instant consumedAt,
                         String state, String podRef, String containerRef, String closeReason,
                         int cols, int rows) { }
}
