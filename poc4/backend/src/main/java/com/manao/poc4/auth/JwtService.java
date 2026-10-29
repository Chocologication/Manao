package com.manao.poc4.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HS256 access tokens. Every token names the account (sub), the expiry (exp) and the
 * auth_version it was signed with (ver). Claim parsing is strict: a missing, negative, floating,
 * string, boolean or overflowing ver is an invalid token, and the existing header/signature and
 * expiry checks are unchanged. The signature alone is never treated as authorization; the
 * authentication filter additionally checks the current app_user row.
 */
public final class JwtService {
    private static final String HEADER_JSON = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    private static final ObjectMapper JSON = new ObjectMapper();

    private final byte[] secret;
    private final Duration lifetime;

    public JwtService(String secret, Duration lifetime) {
        if (secret == null || secret.length() < 32) throw new IllegalArgumentException("JWT secret is required");
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.lifetime = lifetime == null ? Duration.ofMinutes(15) : lifetime;
    }

    public IssuedToken issue(String userId, long authVersion) {
        if (userId == null || !userId.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("user identity required");
        if (authVersion < 0) throw new IllegalArgumentException("auth version must be non-negative");
        Instant expires = Instant.now().plus(lifetime);
        ObjectNode claims = JSON.createObjectNode();
        claims.put("sub", userId);
        claims.put("exp", expires.getEpochSecond());
        claims.put("ver", authVersion);
        String payload;
        try {
            payload = JSON.writeValueAsString(claims);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
        String signing = b64(HEADER_JSON) + "." + b64(payload);
        return new IssuedToken(signing + "." + sign(signing), expires);
    }

    /** Compatibility helper for non-auth call sites; authentication uses {@link #parse(String)}. */
    public String subject(String token) {
        return parse(token).subject();
    }

    public Claims parse(String token) {
        try {
            String[] parts = token == null ? new String[0] : token.split("\\.", -1);
            if (parts.length != 3) throw invalid();
            String signing = parts[0] + "." + parts[1];
            if (!MessageDigest.isEqual(sign(signing).getBytes(StandardCharsets.US_ASCII), parts[2].getBytes(StandardCharsets.US_ASCII))) throw invalid();
            if (!new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8).equals(HEADER_JSON)) throw invalid();
            String payloadJson = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            JsonNode payload = JSON.readTree(payloadJson);
            if (payload == null || !payload.isObject()) throw invalid();
            JsonNode subjectNode = payload.get("sub");
            if (subjectNode == null || !subjectNode.isTextual() || subjectNode.textValue().isBlank()) throw invalid();
            JsonNode expiresNode = payload.get("exp");
            if (!integral(expiresNode)) throw invalid();
            JsonNode versionNode = payload.get("ver");
            if (!integral(versionNode)) throw invalid();
            long authVersion = versionNode.longValue();
            if (authVersion < 0) throw invalid();
            long expiresAt = expiresNode.longValue();
            if (Instant.now().getEpochSecond() >= expiresAt) throw invalid();
            return new Claims(subjectNode.textValue(), Instant.ofEpochSecond(expiresAt), authVersion);
        } catch (RuntimeException ex) {
            throw invalid();
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw invalid();
        }
    }

    private static boolean integral(JsonNode node) {
        return node != null && node.isIntegralNumber() && node.canConvertToLong();
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("invalid token");
    }

    private String sign(String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String b64(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    public record IssuedToken(String accessToken, Instant expiresAt) {}

    public record Claims(String subject, Instant expiresAt, long authVersion) {}
}
