package com.manao.poc4.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class JwtService {
    private final byte[] secret;
    private final Duration lifetime;

    public JwtService(String secret, Duration lifetime) {
        if (secret == null || secret.length() < 32) throw new IllegalArgumentException("JWT secret is required");
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.lifetime = lifetime == null ? Duration.ofMinutes(15) : lifetime;
    }

    public IssuedToken issue(String userId) {
        if (userId == null || !userId.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("user identity required");
        Instant expires = Instant.now().plus(lifetime);
        String header = b64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String payload = b64("{\"sub\":\"" + escape(userId) + "\",\"exp\":" + expires.getEpochSecond() + "}");
        String signing = header + "." + payload;
        return new IssuedToken(signing + "." + sign(signing), expires);
    }

    public String subject(String token) { return parse(token).subject(); }

    public Claims parse(String token) {
        try {
            String[] parts = token == null ? new String[0] : token.split("\\.", -1);
            if (parts.length != 3) throw new IllegalArgumentException("invalid token");
            String signing = parts[0] + "." + parts[1];
            if (!MessageDigest.isEqual(sign(signing).getBytes(StandardCharsets.US_ASCII), parts[2].getBytes(StandardCharsets.US_ASCII))) throw new IllegalArgumentException("invalid token");
            if (!new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8).equals("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")) throw new IllegalArgumentException("invalid token");
            String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            if (!payload.matches("\\{\\\"sub\\\":\\\"[^\\\"\\\\]+\\\",\\\"exp\\\":\\d+\\}")) throw new IllegalArgumentException("invalid token");
            String subject = field(payload, "sub");
            long exp = Long.parseLong(field(payload, "exp"));
            if (subject == null || subject.isBlank() || Instant.now().getEpochSecond() >= exp) throw new IllegalArgumentException("invalid token");
            return new Claims(subject, Instant.ofEpochSecond(exp));
        } catch (RuntimeException ex) { throw new IllegalArgumentException("invalid token"); }
    }

    private String sign(String value) {
        try { Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret, "HmacSHA256")); return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception ex) { throw new IllegalStateException(ex); }
    }
    private static String b64(String value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
    private static String field(String json, String key) {
        String marker = "\"" + key + "\":"; int start = json.indexOf(marker); if (start < 0) return null; start += marker.length();
        if (json.charAt(start) == '\"') { int end = json.indexOf('\"', start + 1); return end < 0 ? null : json.substring(start + 1, end); }
        int end = start; while (end < json.length() && Character.isDigit(json.charAt(end))) end++; return json.substring(start, end);
    }
    private static String escape(String value) { return value.replace("\\", "\\\\").replace("\"", "\\\""); }
    public record IssuedToken(String accessToken, Instant expiresAt) {}
    public record Claims(String subject, Instant expiresAt) {}
}
