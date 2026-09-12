package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.api.ApiException;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LogTicketServiceTest {
    private static final String ALICE = "alice-id";
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");

    static final class MutableClock extends java.time.Clock {
        private Instant instant = NOW;
        void advance(Duration duration) { instant = instant.plus(duration); }
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return instant; }
    }

    static final class FakeTicketStore implements LogTicketService.Store {
        final Map<String, LogTicketService.TicketRecord> tickets = new HashMap<>();
        java.util.function.Supplier<Instant> now = () -> NOW;

        @Override public void insert(LogTicketService.TicketRecord record) {
            tickets.put(record.ticketHash(), record);
        }

        @Override public Optional<LogTicketService.TicketRecord> consumeByHash(String ticketHash) {
            LogTicketService.TicketRecord record = tickets.get(ticketHash);
            Instant nowInstant = now.get();
            if (record == null || record.consumedAt() != null || !record.expiresAt().isAfter(nowInstant)) {
                return Optional.empty();
            }
            LogTicketService.TicketRecord consumed = new LogTicketService.TicketRecord(record.ticketHash(),
                record.userId(), record.projectId(), record.runId(), record.expiresAt(), nowInstant);
            tickets.put(ticketHash, consumed);
            return Optional.of(consumed);
        }
    }

    private final FakeTicketStore store = new FakeTicketStore();
    private final MutableClock clock = new MutableClock();
    private LogTicketService service;

    @BeforeEach
    void setUp() {
        store.now = clock::instant;
        // Only the seeded run owned by Alice is resolvable.
        service = new LogTicketService(store, clock,
            (ownerId, projectId, runId) -> ownerId.equals(ALICE) && runId.equals(RUN));
    }

    @Test
    void issueReturnsOpaqueTicketWithThirtySecondExpiry() {
        LogTicketService.IssuedTicket ticket = service.issue(ALICE, PROJECT, RUN);
        assertThat(ticket.ticket()).isNotBlank();
        assertThat(ticket.ticket().length()).isGreaterThanOrEqualTo(32);
        assertThat(ticket.expiresAt()).isEqualTo(NOW.plus(Duration.ofSeconds(30)));
        // Only the hash is persisted; the raw ticket value is never stored.
        assertThat(store.tickets).doesNotContainKey(ticket.ticket());
        assertThat(store.tickets).hasSize(1);
    }

    @Test
    void consumeIsSingleUseAndReturnsBinding() {
        LogTicketService.IssuedTicket ticket = service.issue(ALICE, PROJECT, RUN);
        Optional<LogTicketService.TicketRecord> first = service.consume(ticket.ticket());
        assertThat(first).isPresent();
        assertThat(first.get().userId()).isEqualTo(ALICE);
        assertThat(first.get().projectId()).isEqualTo(PROJECT);
        assertThat(first.get().runId()).isEqualTo(RUN);
        assertThat(service.consume(ticket.ticket())).isEmpty();
    }

    @Test
    void expiredTicketsAreRejected() {
        LogTicketService.IssuedTicket ticket = service.issue(ALICE, PROJECT, RUN);
        clock.advance(Duration.ofSeconds(31));
        assertThat(service.consume(ticket.ticket())).isEmpty();
    }

    @Test
    void unknownTicketsAndUnresolvedRunsAreRejected() {
        assertThat(service.consume("totally-unknown")).isEmpty();
        assertThatThrownBy(() -> service.issue(ALICE, PROJECT, "missing-run"))
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("RUN_NOT_FOUND"));
    }

    @Test
    void deletingProjectRejectsNewTickets() {
        service = new LogTicketService(store, clock,
            (ownerId, projectId, runId) -> ownerId.equals(ALICE) && runId.equals(RUN),
            new com.manao.poc4.project.ProjectLifecycleGate(), projectId -> "DELETING");
        assertThatThrownBy(() -> service.issue(ALICE, PROJECT, RUN))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                assertThat(ex.status()).isEqualTo(409);
            });
        assertThat(store.tickets).isEmpty();
    }
}
