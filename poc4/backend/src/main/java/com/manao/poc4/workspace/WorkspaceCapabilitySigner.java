package com.manao.poc4.workspace;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;

/**
 * Backend-side signer for the workspace capability line protocol. The private key is environment
 * injected, never logged, and every request carries a fresh 128-bit CSPRNG nonce.
 */
public final class WorkspaceCapabilitySigner {
    private final PrivateKey privateKey;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public WorkspaceCapabilitySigner(byte[] rawPrivateKey, Clock clock) {
        this.privateKey = Ed25519Keys.privateKeyFromRaw(rawPrivateKey);
        this.clock = clock;
    }

    /** Builds the capability header for one request; each call uses a fresh nonce. */
    public String sign(String method, String pathAndQuery, byte[] body, String projectId) {
        try {
            long issuedAt = clock.instant().toEpochMilli();
            byte[] nonce = new byte[16];
            random.nextBytes(nonce);
            String nonceBase64 = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce);
            String canonical = "v1\n" + method.toUpperCase() + "\n" + pathAndQuery + "\n"
                + sha256Hex(body) + "\n" + projectId + "\n" + issuedAt + "\n" + nonceBase64;
            Signature signature = Signature.getInstance("Ed25519");
            signature.initSign(privateKey);
            signature.update(canonical.getBytes(StandardCharsets.UTF_8));
            String signatureBase64 = Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign());
            return "v1." + projectId + "." + issuedAt + "." + nonceBase64 + "." + signatureBase64;
        } catch (Exception ex) {
            throw new IllegalStateException("cannot sign workspace capability", ex);
        }
    }

    public static Instant issuedAt(String header) {
        String[] parts = header.split("\\.");
        return Instant.ofEpochMilli(Long.parseLong(parts[2]));
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
