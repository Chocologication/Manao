package com.manao.poc4.audit;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.terminal.TerminalStore;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RetentionCleanupJobTest {
    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");

    private FakeCleanupStore store;
    private RetentionCleanupJob job;

    @BeforeEach
    void setUp() {
        store = new FakeCleanupStore();
        job = new RetentionCleanupJob(store, new FixedClock(NOW));
    }

    @Test
    void sevenDayCleanupRemovesExpiredLogChunksTicketsAndAudits() {
        job.cleanupExpired();
        Instant cutoff = NOW.minus(Duration.ofDays(7));
        assertThat(store.calls).containsExactly(
            "log-chunks<" + cutoff, "log-tickets<" + cutoff, "terminal-audits<" + cutoff);
    }

    @Test
    void reservedReservationsExpireEveryTenSecondsByDatabaseTime() {
        store.reservedReservations.put("stale", NOW.minus(Duration.ofSeconds(11)));
        store.reservedReservations.put("fresh", NOW.plus(Duration.ofSeconds(9)));

        int expired = job.expireStaleReservations();

        assertThat(expired).isEqualTo(1);
        assertThat(store.expiredReservations).containsExactly("stale");
    }

    @Test
    void cleanupNeverTouchesRecentEntries() {
        job.cleanupExpired();
        // The cutoff is strictly the seven-day boundary; nothing newer is passed to the store.
        assertThat(store.calls).allSatisfy(call -> assertThat(call).doesNotContain(NOW.toString()));
    }

    static final class FixedClock extends Clock {
        private final Instant now;
        FixedClock(Instant now) { this.now = now; }
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    static final class FakeCleanupStore implements RetentionCleanupJob.CleanupStore {
        final List<String> calls = new ArrayList<>();
        final Map<String, Instant> reservedReservations = new HashMap<>();
        final List<String> expiredReservations = new ArrayList<>();

        @Override public int deleteLogChunksBefore(Instant cutoff) {
            calls.add("log-chunks<" + cutoff);
            return 0;
        }

        @Override public int deleteLogTicketsBefore(Instant cutoff) {
            calls.add("log-tickets<" + cutoff);
            return 0;
        }

        @Override public int deleteTerminalAuditsBefore(Instant cutoff) {
            calls.add("terminal-audits<" + cutoff);
            return 0;
        }

        @Override public Map<String, Instant> reservedReservations() {
            return reservedReservations;
        }

        @Override public int expireReservation(String sessionId) {
            expiredReservations.add(sessionId);
            return 1;
        }
    }
}
