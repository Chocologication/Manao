package com.manao.poc4.log;

import com.manao.poc4.api.ApiException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;

/**
 * Single-use opaque log tickets bound to a run. Only the SHA-256 hash is persisted; consumption
 * is a single atomic check over hash, expiry and unconsumed state.
 */
public final class LogTicketService implements LogTicketAuthenticator {
    public static final Duration TICKET_TTL = Duration.ofSeconds(30);

    /** Ownership + existence gate applied at issuance time. */
    public interface RunAccess {
        boolean check(String ownerId, String projectId, String runId);
    }

    public interface Store {
        void insert(TicketRecord record);

        Optional<TicketRecord> consumeByHash(String ticketHash);
    }

    public record TicketRecord(String ticketHash, String userId, String projectId, String runId,
                               Instant expiresAt, Instant consumedAt) { }

    public record IssuedTicket(String ticket, Instant expiresAt) { }

    private final Store store;
    private final Clock clock;
    private final RunAccess runAccess;
    private final SecureRandom random = new SecureRandom();

    public LogTicketService(Store store, Clock clock, RunAccess runAccess) {
        this.store = store;
        this.clock = clock;
        this.runAccess = runAccess;
    }

    public IssuedTicket issue(String ownerId, String projectId, String runId) {
        if (!runAccess.check(ownerId, projectId, runId)) {
            throw new ApiException("RUN_NOT_FOUND", 404, "Run not found");
        }
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Instant expiresAt = clock.instant().plus(TICKET_TTL);
        store.insert(new TicketRecord(sha256Hex(ticket), ownerId, projectId, runId, expiresAt, null));
        return new IssuedTicket(ticket, expiresAt);
    }

    @Override
    public Optional<TicketRecord> consume(String ticket) {
        if (ticket == null || ticket.isBlank()) return Optional.empty();
        return store.consumeByHash(sha256Hex(ticket));
    }

    static String sha256Hex(String value) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
