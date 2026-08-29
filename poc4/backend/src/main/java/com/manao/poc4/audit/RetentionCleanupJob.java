package com.manao.poc4.audit;

import com.manao.poc4.terminal.TerminalStore;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/**
 * Scheduled retention: seven-day deletion of expired log chunks, log tickets and terminal audits,
 * plus the 10-second RESERVED -> EXPIRED scan driven by database time. Project files and Run
 * recovery metadata are never touched.
 */
public final class RetentionCleanupJob {
    public static final Duration RETENTION = Duration.ofDays(7);

    public interface CleanupStore {
        int deleteLogChunksBefore(Instant cutoff);

        int deleteLogTicketsBefore(Instant cutoff);

        int deleteTerminalAuditsBefore(Instant cutoff);

        Map<String, Instant> reservedReservations();

        int expireReservation(String sessionId);
    }

    private final CleanupStore store;
    private final Clock clock;

    public RetentionCleanupJob(CleanupStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    public void cleanupExpired() {
        Instant cutoff = clock.instant().minus(RETENTION);
        store.deleteLogChunksBefore(cutoff);
        store.deleteLogTicketsBefore(cutoff);
        store.deleteTerminalAuditsBefore(cutoff);
    }

    /** RESERVED -> EXPIRED scan; returns the number of expired reservations. */
    public int expireStaleReservations() {
        Instant now = clock.instant();
        int expired = 0;
        for (Map.Entry<String, Instant> reservation : store.reservedReservations().entrySet()) {
            if (reservation.getValue().isBefore(now)) {
                expired += store.expireReservation(reservation.getKey());
            }
        }
        return expired;
    }
}
