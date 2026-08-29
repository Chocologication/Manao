package com.manao.poc4.audit;

import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.List;

/** Read-side audit queries with keyset pagination for the stage-five terminal-audits endpoint. */
public final class AuditService {
    private final AuditStore store;
    private final Clock clock;

    public AuditService(AuditStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    public AuditPage list(String runId, String cursor, int limit) {
        if (cursor == null || cursor.isBlank()) {
            List<AuditStore.AuditRecord> items = store.list(runId, limit);
            return new AuditPage(items, cursorOf(items));
        }
        String decoded = new String(Base64.getUrlDecoder().decode(cursor), java.nio.charset.StandardCharsets.UTF_8);
        String[] parts = decoded.split("\\|", 2);
        Instant before = Instant.parse(parts[0]);
        String beforeId = parts.length > 1 ? parts[1] : "";
        List<AuditStore.AuditRecord> items = store.listBefore(runId, before, beforeId, limit);
        return new AuditPage(items, cursorOf(items));
    }

    private String cursorOf(List<AuditStore.AuditRecord> items) {
        if (items.isEmpty()) return null;
        AuditStore.AuditRecord last = items.get(items.size() - 1);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
            (last.startedAt() + "|" + last.id()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    public record AuditPage(List<AuditStore.AuditRecord> items, String nextCursor) { }
}
