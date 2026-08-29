package com.manao.poc4.workspaceagent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Verifies the fixed workspace capability line protocol:
 * {@code X-Manao-Workspace-Capability: v1.<projectId>.<issuedAtEpochMs>.<nonceBase64Url>.<signatureBase64Url>}
 * with Ed25519 over {@code v1\n<method>\n<path-and-query>\n<sha256(body)>\n<projectId>\n<issuedAt>\n<nonce>}.
 * The agent holds the public key only; clock skew is ±60 s and nonces replay within 120 s are rejected.
 */
public final class WorkspaceCapabilityVerifier {
    public static final Duration CLOCK_SKEW = Duration.ofSeconds(60);
    public static final Duration NONCE_RETENTION = Duration.ofSeconds(120);
    private static final int MAX_CACHED_NONCES = 100_000;

    private final String projectId;
    private final java.security.PublicKey publicKey;
    private final Clock clock;
    private final ConcurrentHashMap<String, Instant> seenNonces = new ConcurrentHashMap<>();

    public WorkspaceCapabilityVerifier(String projectId, byte[] rawPublicKey, Clock clock) {
        if (projectId == null || projectId.isBlank()) throw new IllegalArgumentException("agent project id is required");
        this.projectId = projectId;
        this.publicKey = Ed25519Keys.publicKey(Ed25519Keys.decodeRawPublicKey(
            Ed25519Keys.encodeRawPublicKey(rawPublicKey)));
        this.clock = clock;
    }

    public Verification verify(String header, String method, String pathAndQuery, byte[] body) {
        try {
            String[] parts = header == null ? new String[0] : header.split("\\.");
            if (parts.length != 5 || !"v1".equals(parts[0])) throw new RejectedException();
            if (!projectId.equals(parts[1])) throw new RejectedException();
            long issuedAt = Long.parseLong(parts[2]);
            Instant now = clock.instant();
            Instant issued = Instant.ofEpochMilli(issuedAt);
            if (issued.isBefore(now.minus(CLOCK_SKEW)) || issued.isAfter(now.plus(CLOCK_SKEW))) {
                throw new RejectedException();
            }
            byte[] nonce = Base64.getUrlDecoder().decode(parts[3]);
            if (nonce.length != 16) throw new RejectedException();
            String canonical = "v1\n" + method.toUpperCase() + "\n" + pathAndQuery + "\n" + sha256Hex(body)
                + "\n" + projectId + "\n" + issuedAt + "\n" + parts[3];
            byte[] signature = Base64.getUrlDecoder().decode(parts[4]);
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(publicKey);
            verifier.update(canonical.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(signature)) throw new RejectedException();
            evictExpired(now);
            if (seenNonces.size() > MAX_CACHED_NONCES) throw new RejectedException();
            if (seenNonces.putIfAbsent(parts[3], now.plus(NONCE_RETENTION)) != null) {
                throw new RejectedException();
            }
            return new Verification(projectId, parts[3]);
        } catch (RejectedException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new RejectedException();
        }
    }

    private void evictExpired(Instant now) {
        Iterator<Map.Entry<String, Instant>> iterator = seenNonces.entrySet().iterator();
        while (iterator.hasNext()) {
            if (iterator.next().getValue().isBefore(now)) iterator.remove();
        }
    }

    static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    public record Verification(String projectId, String nonce) { }

    public static final class RejectedException extends RuntimeException {
        public RejectedException() { super("capability rejected"); }
    }
}
