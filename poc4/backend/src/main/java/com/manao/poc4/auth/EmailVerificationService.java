package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Locale;
import java.util.Optional;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Email verification-code request flow (design sections 5.3 and 7): verify+consume the image
 * captcha and reserve the per purpose+email send slot as SENDING in one short transaction, send
 * synchronously outside that transaction, then conditionally activate or fail the same challenge
 * id. No queue/retry exists; a lost SMTP receipt leaves a code that is simply no longer usable,
 * and a crashed process leaves a SENDING row that is never consumable and can be re-requested
 * after the cooldown.
 *
 * <p>Behavior fixed by the contract: the global mail-not-configured answer is 503
 * MAIL_NOT_CONFIGURED for every address and is checked before any account lookup; a registration
 * send failure may surface 503 MAIL_SEND_FAILED; password recovery always returns the same
 * accepted response shape and only actually sends mail for a bound, verified, enabled account.
 */
public final class EmailVerificationService {
    private static final Logger LOG = LoggerFactory.getLogger(EmailVerificationService.class);
    private static final int CODE_LENGTH = 6;
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final AuthChallengeStore store;
    private final CaptchaService captcha;
    private final UserStore users;
    private final VerificationMailSender mail;
    private final AuthProperties properties;
    private final Supplier<String> codes;

    public EmailVerificationService(AuthChallengeStore store, CaptchaService captcha, UserStore users,
                                    VerificationMailSender mail, AuthProperties properties) {
        this(store, captcha, users, mail, properties, EmailVerificationService::randomCode);
    }

    public EmailVerificationService(AuthChallengeStore store, CaptchaService captcha, UserStore users,
                                    VerificationMailSender mail, AuthProperties properties,
                                    Supplier<String> codes) {
        if (store == null) throw new IllegalArgumentException("challenge store required");
        if (captcha == null) throw new IllegalArgumentException("captcha service required");
        if (users == null) throw new IllegalArgumentException("user store required");
        if (mail == null) throw new IllegalArgumentException("mail sender required");
        if (properties == null) throw new IllegalArgumentException("auth properties required");
        if (codes == null) throw new IllegalArgumentException("code source required");
        this.store = store;
        this.captcha = captcha;
        this.users = users;
        this.mail = mail;
        this.properties = properties;
        this.codes = codes;
    }

    /**
     * Handles POST /api/v1/auth/email-codes. The 422/429 failures are thrown as ApiException after
     * the short transaction has committed the captcha attempts/reservation.
     */
    public AuthContracts.EmailCodeResponse request(AuthContracts.EmailCodeRequest request) {
        // Fixed global 503 before looking at the target account (or consuming the captcha).
        if (!properties.mail().configured()) {
            throw new ApiException("MAIL_NOT_CONFIGURED", 503, "Email delivery is not configured");
        }
        if (request == null || request.purpose() == null) {
            throw validationError();
        }
        AuthContracts.EmailPurpose purpose = request.purpose();
        String email;
        try {
            email = AuthContracts.normalizeEmail(request.email());
        } catch (IllegalArgumentException ex) {
            throw validationError();
        }
        if (request.captchaId() == null || request.captchaId().isBlank()
            || request.captchaAnswer() == null || request.captchaAnswer().isBlank()) {
            throw validationError();
        }
        Outcome outcome = store.inTransaction(status -> reserve(request, purpose, email));
        if (outcome.failureCode() != null) {
            throw new ApiException(outcome.failureCode(), outcome.failureStatus(), "Verification code request refused");
        }
        if (outcome.retryAfterSeconds() > 0) {
            // The real cooldown / remaining hour is propagated; Task 5 maps it to Retry-After.
            throw new AuthContracts.RateLimitedException(outcome.retryAfterSeconds());
        }
        if (!outcome.deliver()) {
            return new AuthContracts.EmailCodeResponse(outcome.challengeId(), outcome.expiresAt(),
                retryAfterSeconds());
        }
        try {
            mail.send(outcome.email(), outcome.purpose(), outcome.code(), outcome.expiresAt());
        } catch (RuntimeException ex) {
            store.failSend(outcome.challengeId());
            // Fixed internal record only: never log the address, answer or transport details.
            LOG.warn("verification mail delivery failed: purpose={}", outcome.purpose());
            if (outcome.purpose() == AuthContracts.EmailPurpose.REGISTER_EMAIL) {
                throw new ApiException("MAIL_SEND_FAILED", 503, "Verification email could not be sent");
            }
            return new AuthContracts.EmailCodeResponse(outcome.challengeId(), outcome.expiresAt(),
                retryAfterSeconds());
        }
        store.activateSent(outcome.challengeId());
        return new AuthContracts.EmailCodeResponse(outcome.challengeId(), outcome.expiresAt(),
            retryAfterSeconds());
    }

    private Outcome reserve(AuthContracts.EmailCodeRequest request, AuthContracts.EmailPurpose purpose,
                            String email) {
        if (!captcha.verifyAndConsume(request.captchaId(), request.captchaAnswer())) {
            return Outcome.failure("CAPTCHA_INVALID", 422);
        }
        String userId = null;
        Long authVersion = null;
        boolean deliver = true;
        if (purpose == AuthContracts.EmailPurpose.RESET_PASSWORD) {
            Optional<UserStore.UserAccount> target = users.findVerifiedByEmail(email)
                .filter(UserStore.UserAccount::enabled);
            if (target.isPresent()) {
                userId = target.get().id();
                authVersion = target.get().authVersion();
            } else {
                // Unknown, unverified or disabled address: reserve the same bounded slot and
                // cooldown, but never deliver. The caller cannot distinguish this from a send.
                deliver = false;
            }
        }
        String code = generatedCode(codes.get());
        AuthChallengeStore.ReserveResult reserved =
            store.reserveEmailSend(purpose, email, code, userId, authVersion);
        if (reserved.outcome() != AuthChallengeStore.ReserveOutcome.RESERVED) {
            return Outcome.rateLimited(reserved.retryAfterSeconds());
        }
        if (!deliver) {
            store.failSend(reserved.challengeId());
        }
        return new Outcome(null, 0, 0, reserved.challengeId(), email, purpose, code,
            reserved.expiresAt(), deliver);
    }

    private long retryAfterSeconds() {
        return Math.max(1, properties.challenge().emailCodeCooldown().toSeconds());
    }

    private static String generatedCode(String raw) {
        if (raw == null) {
            throw new IllegalStateException("verification code source returned no code");
        }
        String code = raw.trim();
        if (code.length() != CODE_LENGTH) {
            throw new IllegalStateException("verification code source returned an invalid code");
        }
        for (int i = 0; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c < '0' || c > '9') {
                throw new IllegalStateException("verification code source returned an invalid code");
            }
        }
        return code;
    }

    private static String randomCode() {
        return String.format(Locale.ROOT, "%06d", SECURE_RANDOM.nextInt(1_000_000));
    }

    private static ApiException validationError() {
        return new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    private record Outcome(String failureCode, int failureStatus, long retryAfterSeconds,
                           String challengeId, String email, AuthContracts.EmailPurpose purpose,
                           String code, Instant expiresAt, boolean deliver) {
        static Outcome failure(String code, int status) {
            return new Outcome(code, status, 0, null, null, null, null, null, false);
        }

        static Outcome rateLimited(long retryAfterSeconds) {
            return new Outcome(null, 0, Math.max(1, retryAfterSeconds), null, null, null, null, null, false);
        }
    }
}
