package com.manao.poc4.auth;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.security.Principal;
import java.time.Instant;
import java.util.Locale;

/**
 * Authentication contracts shared by the HTTP layer and the account lifecycle tasks.
 * The identity is derived only from the verified token claims plus the current app_user row;
 * request bodies never supply the owner or the version. Challenge request/response bodies and
 * the new-email normalization rule live here so the HTTP task and the send/verify services use
 * exactly the same contract (design sections 5.3 and 9).
 */
public final class AuthContracts {
    private AuthContracts() {
    }

    /**
     * The authenticated account for one request: the user id and the auth_version the token was
     * signed with. {@code getName()} keeps returning the user id so all existing owner checks
     * stay unchanged, while follow-up tasks can bind issued tickets/connections to the version.
     */
    public record AccountIdentity(String userId, long authVersion) implements Principal {
        public AccountIdentity {
            if (userId == null || userId.isBlank()) {
                throw new IllegalArgumentException("user identity required");
            }
            if (authVersion < 0) {
                throw new IllegalArgumentException("auth version must be non-negative");
            }
        }

        @Override
        public String getName() {
            return userId;
        }
    }

    /** The only two purposes that can email a one-time code (design section 9). */
    public enum EmailPurpose {
        REGISTER_EMAIL, RESET_PASSWORD
    }

    /** POST /api/v1/auth/email-codes body; unknown JSON fields are rejected. */
    @JsonIgnoreProperties(ignoreUnknown = false)
    public record EmailCodeRequest(@NotNull EmailPurpose purpose,
                                   @NotBlank @Size(max = 254) String email,
                                   @NotBlank String captchaId,
                                   @NotBlank String captchaAnswer) {
    }

    /**
     * The fixed accepted response of POST /api/v1/auth/email-codes. Reset recovery returns the
     * same shape whether or not the address is bound and whether or not the send succeeded.
     */
    public record EmailCodeResponse(String challengeId, Instant expiresAt, long retryAfterSeconds) {
    }

    /** GET /api/v1/auth/captcha response: an opaque id, a PNG as base64 and the expiry. */
    public record CaptchaResponse(String challengeId, String imageBase64, Instant expiresAt) {
    }

    /**
     * Normalizes a NEW email identity: trim, {@link Locale#ROOT} lower-case, length and syntax
     * validation (design section 5.3). The stored value is compared binary, so callers must use
     * this method before binding, sending or looking up an address. Dots and +tags are kept.
     */
    public static String normalizeEmail(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("email required");
        }
        String value = raw.trim().toLowerCase(Locale.ROOT);
        if (value.isEmpty() || value.length() > 254) {
            throw new IllegalArgumentException("email length is invalid");
        }
        int at = value.indexOf('@');
        if (at <= 0 || at != value.lastIndexOf('@') || at == value.length() - 1) {
            throw new IllegalArgumentException("email format is invalid");
        }
        String local = value.substring(0, at);
        String domain = value.substring(at + 1);
        if (local.length() > 64 || local.startsWith(".") || local.endsWith(".") || local.contains("..")) {
            throw new IllegalArgumentException("email format is invalid");
        }
        for (int i = 0; i < local.length(); i++) {
            char c = local.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || "!#$%&'*+/=?^_{|}~.-".indexOf(c) >= 0;
            if (!allowed) {
                throw new IllegalArgumentException("email format is invalid");
            }
        }
        if (domain.length() > 253 || domain.startsWith(".") || domain.endsWith(".")
            || domain.contains("..") || domain.indexOf('.') < 0) {
            throw new IllegalArgumentException("email format is invalid");
        }
        int labelStart = 0;
        for (int i = 0; i <= domain.length(); i++) {
            if (i == domain.length() || domain.charAt(i) == '.') {
                int length = i - labelStart;
                if (length == 0 || length > 63) {
                    throw new IllegalArgumentException("email format is invalid");
                }
                if (domain.charAt(labelStart) == '-' || domain.charAt(i - 1) == '-') {
                    throw new IllegalArgumentException("email format is invalid");
                }
                for (int j = labelStart; j < i; j++) {
                    char c = domain.charAt(j);
                    boolean allowed = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
                    if (!allowed) {
                        throw new IllegalArgumentException("email format is invalid");
                    }
                }
                labelStart = i + 1;
            }
        }
        return value;
    }
}
