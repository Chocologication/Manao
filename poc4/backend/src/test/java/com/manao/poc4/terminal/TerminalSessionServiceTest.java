package com.manao.poc4.terminal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.run.RunControllerTest;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TerminalSessionServiceTest {
    private static final String ALICE = "alice-id";
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");

    private FakeTerminalStore store;
    private FakeRunStore runStore;
    private MutableClock clock;
    private TerminalSessionService service;

    @BeforeEach
    void setUp() {
        store = new FakeTerminalStore();
        runStore = new FakeRunStore();
        clock = new MutableClock();
        service = new TerminalSessionService(store, runStore, clock);
        runStore.projects.put(PROJECT, "READY");
        runStore.projectOwners.put(PROJECT, ALICE);
        runStore.runs.put(RUN, new RunControllerTest.FakeRun(runningRun()));
    }

    private com.manao.poc4.run.RunRecord runningRun() {
        return new com.manao.poc4.run.RunRecord(RUN, PROJECT, 5, com.manao.poc4.persistence.RunState.RUNNING,
            "{}", "manao-run-" + RUN, null, NOW, null, null, null, 1L, NOW.minus(Duration.ofMinutes(1)), 0L);
    }

    @Test
    void reserveCreatesOneOpaqueReservationForRunningRun() {
        TerminalSessionService.Reservation reservation = service.reserve(80, 24, ALICE, PROJECT, RUN);
        assertThat(reservation.sessionId()).isNotBlank();
        assertThat(reservation.ticket()).isNotBlank();
        assertThat(reservation.expiresAt()).isEqualTo(NOW.plus(Duration.ofSeconds(30)));
        // Only the ticket hash is stored.
        assertThat(store.sessions.values()).anySatisfy(session ->
            assertThat(session.ticketHash()).isEqualTo(TerminalTicketService.sha256Hex(reservation.ticket())));
        assertThat(store.sessions.values()).noneSatisfy(session ->
            assertThat(session.ticketHash()).isEqualTo(reservation.ticket()));
    }

    @Test
    void reserveRejectsNonRunningRunsAndNonReadyProjects() {
        runStore.runs.clear();
        assertThatThrownBy(() -> service.reserve(80, 24, ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.code()).isEqualTo("TERMINAL_NOT_AVAILABLE");
                assertThat(ex.status()).isEqualTo(409);
            });
        runStore.runs.put(RUN, new RunControllerTest.FakeRun(new com.manao.poc4.run.RunRecord(RUN, PROJECT, 5,
            com.manao.poc4.persistence.RunState.SUCCEEDED, "{}", null, null, null, NOW, 0, "BUILD_SUCCEEDED", 2L, NOW, 0L)));
        assertThatThrownBy(() -> service.reserve(80, 24, ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("TERMINAL_NOT_AVAILABLE"));
        runStore.projects.put(PROJECT, "CREATING");
        assertThatThrownBy(() -> service.reserve(80, 24, ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
    }

    @Test
    void reserveEnforcesDimensionBounds() {
        assertThatThrownBy(() -> service.reserve(1, 24, ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> service.reserve(501, 24, ALICE, PROJECT, RUN))
            .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.reserve(80, 0, ALICE, PROJECT, RUN))
            .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.reserve(80, 201, ALICE, PROJECT, RUN))
            .isInstanceOf(ApiException.class);
    }

    @Test
    void secondLiveReservationForTheSameRunConflicts() {
        service.reserve(80, 24, ALICE, PROJECT, RUN);
        assertThatThrownBy(() -> service.reserve(80, 24, ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("TERMINAL_SESSION_ALREADY_ACTIVE"));
    }

    @Test
    void consumeTransitionsReservationToLiveExactlyOnce() {
        TerminalSessionService.Reservation reservation = service.reserve(80, 24, ALICE, PROJECT, RUN);
        Optional<TerminalStore.SessionRecord> first = service.consume(reservation.ticket());
        assertThat(first).isPresent();
        assertThat(first.get().state()).isEqualTo("LIVE");
        assertThat(service.consume(reservation.ticket())).isEmpty();
    }

    @Test
    void expiredReservationsAreNotConsumable() {
        TerminalSessionService.Reservation reservation = service.reserve(80, 24, ALICE, PROJECT, RUN);
        clock.advance(Duration.ofSeconds(31));
        assertThat(service.consume(reservation.ticket())).isEmpty();
    }

    @Test
    void settleIsIdempotent() {
        TerminalSessionService.Reservation reservation = service.reserve(80, 24, ALICE, PROJECT, RUN);
        service.consume(reservation.ticket());
        assertThat(service.settle(reservation.sessionId(), "CLOSED", "CLIENT_CLOSED", null)).isTrue();
        assertThat(service.settle(reservation.sessionId(), "INTERRUPTED", "CONNECTION_LOST", null)).isFalse();
        assertThat(store.sessions.get(reservation.sessionId()).state()).isEqualTo("CLOSED");
    }

    public static final class MutableClock extends java.time.Clock {
        private Instant instant = NOW;
        void advance(Duration duration) { instant = instant.plus(duration); }
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return instant; }
    }

    static final class FakeRunStore extends RunControllerTest.FakeRunStore { }

    public static final class FakeTerminalStore implements TerminalStore {
        final Map<String, SessionRecord> sessions = new HashMap<>();
        final java.util.function.Supplier<Instant> now = () -> NOW;
        boolean failReservation;

        @Override public boolean insertReservation(ReservationRecord record) {
            if (failReservation) return false;
            boolean hasActiveSession = sessions.values().stream().anyMatch(candidate ->
                candidate.runId().equals(record.runId())
                    && ("RESERVED".equals(candidate.state()) || "LIVE".equals(candidate.state())));
            if (hasActiveSession) return false;
            sessions.put(record.sessionId(), new SessionRecord(record.sessionId(), record.projectId(),
                record.runId(), record.userId(), record.ticketHash(), record.expiresAt(), null, "RESERVED",
                null, null, null, record.cols(), record.rows()));
            return true;
        }

        @Override public Optional<SessionRecord> consumeReservation(String ticketHash) {
            SessionRecord session = sessions.values().stream()
                .filter(candidate -> candidate.ticketHash().equals(ticketHash))
                .findFirst().orElse(null);
            if (session == null || !"RESERVED".equals(session.state())
                || !session.expiresAt().isAfter(now.get())) {
                return Optional.empty();
            }
            SessionRecord live = new SessionRecord(session.sessionId(), session.projectId(), session.runId(),
                session.userId(), session.ticketHash(), session.expiresAt(), Instant.now(), "LIVE",
                session.podRef(), session.containerRef(), session.closeReason(), session.cols(), session.rows());
            sessions.put(live.sessionId(), live);
            return Optional.of(live);
        }

        @Override public Optional<SessionRecord> findSession(String sessionId) {
            return Optional.ofNullable(sessions.get(sessionId));
        }

        @Override public boolean settle(String sessionId, String state, String closeReason, Integer exitCode) {
            SessionRecord session = sessions.get(sessionId);
            if (session == null || !"LIVE".equals(session.state())) return false;
            sessions.put(sessionId, new SessionRecord(session.sessionId(), session.projectId(), session.runId(),
                session.userId(), session.ticketHash(), session.expiresAt(), session.consumedAt(), state,
                session.podRef(), session.containerRef(), closeReason, session.cols(), session.rows()));
            return true;
        }
    }
}
