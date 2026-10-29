package com.manao.poc4.terminal;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.auth.AuthContracts;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunStore;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;

/**
 * One opaque terminal reservation per RUNNING Run of a READY project; the unique active-terminal
 * marker makes the single-live-session rule a database guarantee instead of a race. A reservation
 * binds the REQUEST's auth_version; the conditional INSERT re-checks the current account version
 * so an old JWT can neither race a password change nor be upgraded to the DB's newer version.
 */
public final class TerminalSessionService implements TerminalTicketService {
    public static final Duration TICKET_TTL = Duration.ofSeconds(30);

    private final TerminalStore store;
    private final RunStore runStore;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public TerminalSessionService(TerminalStore store, RunStore runStore, Clock clock) {
        this.store = store;
        this.runStore = runStore;
        this.clock = clock;
    }

    public record Reservation(String sessionId, String ticket, Instant expiresAt) { }

    /** Production path: binds the authenticated request identity (user id + version). */
    public Reservation reserve(int cols, int rows, AuthContracts.AccountIdentity identity,
                               String projectId, String runId) {
        if (identity == null) throw new ApiException("UNAUTHENTICATED", 401, "Authentication required");
        return reserve(cols, rows, identity.userId(), identity.authVersion(), projectId, runId);
    }

    private Reservation reserve(int cols, int rows, String ownerId, long authVersion,
                                String projectId, String runId) {
        requireDimension(cols, 2, 500, "cols");
        requireDimension(rows, 1, 200, "rows");
        RunStore.ProjectRecord project = runStore.findProjectForOwner(ownerId, projectId);
        if (project == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        if (!"READY".equals(project.state())) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        Optional<RunRecord> activeRun = runStore.findActiveRun(projectId);
        boolean running = activeRun.isPresent() && activeRun.get().state() == RunState.RUNNING
            && activeRun.get().id().equals(runId);
        if (!running) {
            throw new ApiException("TERMINAL_NOT_AVAILABLE", 409, "Terminal is not available");
        }
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        String sessionId = UUID.randomUUID().toString();
        Instant expiresAt = clock.instant().plus(TICKET_TTL);
        TerminalStore.InsertResult result = store.insertReservation(new TerminalStore.ReservationRecord(
            sessionId, projectId, runId, ownerId, authVersion, TerminalTicketService.sha256Hex(ticket),
            expiresAt, cols, rows));
        if (result == TerminalStore.InsertResult.STALE_CREDENTIALS) {
            throw new ApiException("UNAUTHENTICATED", 401, "Authentication required");
        }
        if (result != TerminalStore.InsertResult.INSERTED) {
            throw new ApiException("TERMINAL_SESSION_ALREADY_ACTIVE", 409, "Terminal session already active");
        }
        return new Reservation(sessionId, ticket, expiresAt);
    }

    @Override
    public Optional<TerminalStore.SessionRecord> consume(String ticket) {
        if (ticket == null || ticket.isBlank()) return Optional.empty();
        Optional<TerminalStore.SessionRecord> session = store.consumeReservation(TerminalTicketService.sha256Hex(ticket));
        session = session.filter(record -> record.expiresAt().isAfter(clock.instant()));
        return session;
    }

    public boolean settle(String sessionId, String state, String closeReason, Integer exitCode) {
        return store.settle(sessionId, state, closeReason, exitCode);
    }

    public void updateLiveRefs(String sessionId, String podRef, String containerRef) {
        store.updateLiveRefs(sessionId, podRef, containerRef);
    }

    private static void requireDimension(int value, int min, int max, String name) {
        if (value < min || value > max) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }
}
