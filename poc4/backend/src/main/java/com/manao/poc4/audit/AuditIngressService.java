package com.manao.poc4.audit;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Consumes structured wrapper events from the session-bound MACed FIFO transport. Only
 * HMAC-valid, monotonic, non-duplicate events of a bound session are persisted; command text is
 * redacted before storage and the trust level is limited to "wrapper transport verified".
 */
public final class AuditIngressService {

    private final AuditStore store;
    private final Map<String, SessionContext> sessions = new ConcurrentHashMap<>();

    private static final class SessionContext {
        final String projectId;
        final String runId;
        final String userId;
        final byte[] macKey;
        long lastSeq;
        final Map<Long, String> auditIds = new ConcurrentHashMap<>();

        SessionContext(String projectId, String runId, String userId, byte[] macKey) {
            this.projectId = projectId;
            this.runId = runId;
            this.userId = userId;
            this.macKey = macKey;
        }
    }

    public record WrapperEvent(String sessionId, long seq, String command, Integer exitCode, String state,
                               String mac) { }

    public AuditIngressService(AuditStore store) {
        this.store = store;
    }

    /** Binds a terminal session to its per-session 256-bit MAC key (delivered via exec stdin). */
    public void bindSession(String sessionId, String projectId, String runId, String userId, byte[] macKey) {
        sessions.put(sessionId, new SessionContext(projectId, runId, userId, macKey.clone()));
    }

    public void unbindSession(String sessionId) {
        sessions.remove(sessionId);
    }

    /** Verifies and persists one wrapper event; returns false when the event is rejected. */
    public boolean ingest(WrapperEvent event) {
        SessionContext context = sessions.get(event.sessionId());
        if (context == null) return false;
        if (event.seq() != context.lastSeq + 1) return false;
        if (!hmacValid(context, event)) return false;
        boolean[] sensitive = new boolean[1];
        String redacted = CommandRedactor.redact(event.command(), sensitive);
        String auditId = store.insertRunning(event.sessionId(), context.projectId, context.runId, context.userId,
            event.seq(), redacted, sensitive[0], Instant.now());
        context.lastSeq = event.seq();
        context.auditIds.put(event.seq(), auditId);
        if ("SUCCEEDED".equals(event.state()) || "FAILED".equals(event.state()) || "INTERRUPTED".equals(event.state())) {
            settle(event.sessionId(), event.seq(), event.state(), event.exitCode());
        }
        return true;
    }

    /** Settles one running audit exactly once. */
    public boolean settle(String sessionId, long seq, String state, Integer exitCode) {
        SessionContext context = sessions.get(sessionId);
        if (context == null) return false;
        String auditId = context.auditIds.get(seq);
        if (auditId == null) return false;
        return store.settle(auditId, state, exitCode, Instant.now());
    }

    private boolean hmacValid(SessionContext context, WrapperEvent event) {
        try {
            String canonical = "{\"sessionId\":\"" + event.sessionId() + "\",\"seq\":" + event.seq()
                + ",\"command\":\"" + event.command() + "\",\"exitCode\":"
                + (event.exitCode() == null ? "null" : event.exitCode())
                + ",\"state\":\"" + event.state() + "\"}";
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(context.macKey, "HmacSHA256"));
            String expected = Base64.getEncoder()
                .encodeToString(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
            return java.security.MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                (event.mac() == null ? "" : event.mac()).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            return false;
        }
    }
}
