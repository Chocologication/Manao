package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The email-code send state machine: reserve SENDING in a short transaction, send outside it,
 * conditionally activate/fail the same id. Reset recovery answers uniformly (same 202 shape) for
 * unknown, unverified, disabled and SMTP-failed addresses while only a bound verified enabled
 * account receives mail; a missing mail configuration is a global 503 checked before any account
 * lookup. Automated runs use a capturing sender only.
 */
class EmailVerificationServiceTest {
    private static final String SECRET = "test-only-challenge-secret-0123456789";
    private static final String CAPTCHA_ANSWER = "AB23C";
    private static final String CODE = "654321";
    private static final String MAIL_PASSWORD = "test-only-client-authorization-code";
    private static final Instant NOW = Instant.parse("2026-05-06T07:08:09Z");

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private MutableClock clock;
    private AuthChallengeStore store;
    private CaptchaService captcha;
    private UserStore users;
    private CapturingMail mail;
    private EmailVerificationService service;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        clock = new MutableClock(NOW);
        AuthProperties properties = properties(true, MAIL_PASSWORD);
        store = new AuthChallengeStore(jdbc, properties, clock);
        captcha = new CaptchaService(store, properties, clock, () -> CAPTCHA_ANSWER);
        users = new UserStore(jdbc);
        mail = new CapturingMail();
        service = new EmailVerificationService(store, captcha, users, mail, properties, () -> CODE);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void registerCodeIsDeliveredOnceStoredAsHmacAndConsumableOnce() {
        AuthContracts.EmailCodeResponse response = service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, " Carol@Example.TEST ", issueCaptcha(), CAPTCHA_ANSWER));

        assertThat(response.challengeId()).matches("[0-9a-f]{32}");
        assertThat(response.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(10)));
        assertThat(response.retryAfterSeconds()).isEqualTo(60);

        assertThat(mail.attempts).isEqualTo(1);
        assertThat(mail.sends).hasSize(1);
        SentMail sent = mail.sends.get(0);
        assertThat(sent.email()).isEqualTo("carol@example.test");
        assertThat(sent.purpose()).isEqualTo(AuthContracts.EmailPurpose.REGISTER_EMAIL);
        assertThat(sent.code()).isEqualTo(CODE);
        assertThat(sent.expiresAt()).isEqualTo(response.expiresAt());

        Map<String, Object> row = row(response.challengeId());
        assertThat(row.get("state")).isEqualTo("ACTIVE");
        assertThat(row.get("purpose")).isEqualTo("REGISTER_EMAIL");
        assertThat(row.get("email")).isEqualTo("carol@example.test");
        assertThat(row.get("user_id")).isNull();
        assertThat(((Number) row.get("window_send_count")).intValue()).isEqualTo(1);
        String storedMac = (String) row.get("answer_mac");
        assertThat(storedMac).matches("[0-9a-f]{64}");
        assertThat(storedMac).isEqualTo(expectedMac(response.challengeId(), "REGISTER_EMAIL",
            "carol@example.test", CODE));
        assertThat(storedMac).isNotEqualTo(CODE);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM auth_challenge WHERE answer_mac=?", Integer.class, CODE)).isZero();

        var consumed = store.verifyAndConsume(response.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "carol@example.test", CODE);
        assertThat(consumed.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(store.verifyAndConsume(response.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "carol@example.test", CODE).outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void resetRecoveryIsUniformForUnknownUnverifiedAndDisabledAddresses() {
        insertUser("disabled-user", "disabled@example.test", false, NOW, 0);
        insertUser("unverified-user", "unverified@example.test", true, null, 0);

        List<AuthContracts.EmailCodeResponse> responses = new ArrayList<>();
        for (String email : new String[] {"unknown@example.test", "unverified@example.test", "disabled@example.test"}) {
            responses.add(service.request(new AuthContracts.EmailCodeRequest(
                AuthContracts.EmailPurpose.RESET_PASSWORD, email, issueCaptcha(), CAPTCHA_ANSWER)));
        }

        // No recovery mail may be attempted for any of these addresses.
        assertThat(mail.attempts).isZero();
        assertThat(mail.sends).isEmpty();
        for (AuthContracts.EmailCodeResponse response : responses) {
            assertThat(response.challengeId()).matches("[0-9a-f]{32}");
            assertThat(response.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(10)));
            assertThat(response.retryAfterSeconds()).isEqualTo(60);
            // The bounded slot exists but is terminal and can never be consumed.
            assertThat(row(response.challengeId()).get("state")).isEqualTo("FAILED");
            assertThat(row(response.challengeId()).get("user_id")).isNull();
            assertThat(store.verifyAndConsume(response.challengeId(),
                AuthContracts.EmailPurpose.RESET_PASSWORD, "unknown@example.test", CODE).outcome())
                .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        }

        // Unknown recovery addresses still consume the same cooldown as a real send.
        ApiException cooldown = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "unknown@example.test", issueCaptcha(), CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(cooldown.code()).isEqualTo("AUTH_RATE_LIMITED");
        assertThat(cooldown.status()).isEqualTo(429);
        assertThat(mail.attempts).isZero();
    }

    @Test
    void resetRecoverySendsOnlyToABoundVerifiedEnabledAccount() {
        insertUser("target-user", "target@example.test", true, NOW, 2);

        AuthContracts.EmailCodeResponse response = service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "Target@Example.TEST", issueCaptcha(), CAPTCHA_ANSWER));

        assertThat(mail.sends).hasSize(1);
        assertThat(mail.sends.get(0).email()).isEqualTo("target@example.test");
        assertThat(mail.sends.get(0).purpose()).isEqualTo(AuthContracts.EmailPurpose.RESET_PASSWORD);
        Map<String, Object> row = row(response.challengeId());
        assertThat(row.get("state")).isEqualTo("ACTIVE");
        assertThat(row.get("user_id")).isEqualTo("target-user");
        assertThat(((Number) row.get("auth_version_snapshot")).longValue()).isEqualTo(2);

        var consumed = store.verifyAndConsume(response.challengeId(),
            AuthContracts.EmailPurpose.RESET_PASSWORD, "target@example.test", CODE);
        assertThat(consumed.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(consumed.userId()).isEqualTo("target-user");
        assertThat(consumed.authVersionSnapshot()).isEqualTo(2L);
    }

    @Test
    void resetSmtpFailureKeepsTheUniformAcceptedResponse() {
        insertUser("target-user", "target@example.test", true, NOW, 0);
        mail.failure = new RuntimeException("smtp unavailable at fake.test");

        AuthContracts.EmailCodeResponse response = service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "target@example.test", issueCaptcha(), CAPTCHA_ANSWER));

        assertThat(mail.attempts).isEqualTo(1);
        assertThat(response.challengeId()).matches("[0-9a-f]{32}");
        assertThat(response.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(10)));
        assertThat(response.retryAfterSeconds()).isEqualTo(60);
        assertThat(row(response.challengeId()).get("state")).isEqualTo("FAILED");
        assertThat(store.verifyAndConsume(response.challengeId(),
            AuthContracts.EmailPurpose.RESET_PASSWORD, "target@example.test", CODE).outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void registerSmtpFailureReturnsMailSendFailedAndCountsTowardTheCooldown() {
        mail.failure = new RuntimeException("smtp unavailable at fake.test");

        ApiException failed = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "register@example.test", issueCaptcha(), CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(failed.code()).isEqualTo("MAIL_SEND_FAILED");
        assertThat(failed.status()).isEqualTo(503);
        assertThat(mail.attempts).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT state FROM auth_challenge WHERE purpose='REGISTER_EMAIL' AND email='register@example.test'",
            String.class)).isEqualTo("FAILED");
        // The failed send occupied the cooldown, so an immediate retry is rate limited.
        ApiException cooldown = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "register@example.test", issueCaptcha(), CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(cooldown.code()).isEqualTo("AUTH_RATE_LIMITED");
        assertThat(mail.attempts).isEqualTo(1);
    }

    @Test
    void unconfiguredMailReturns503BeforeAnyAccountLookupAndBeforeConsumingCaptcha() {
        AuthProperties disabled = properties(false, "");
        UserStore unreachable = new UserStore(
            new JdbcTemplate(new DriverManagerDataSource("jdbc:invalid:test")));
        EmailVerificationService withoutMail = new EmailVerificationService(
            store, captcha, unreachable, mail, disabled, () -> CODE);
        String captchaId = issueCaptcha();

        ApiException error = catchThrowableOfType(() -> withoutMail.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "whoever@example.test", captchaId, CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(error.code()).isEqualTo("MAIL_NOT_CONFIGURED");
        assertThat(error.status()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_challenge "
            + "WHERE purpose IN ('REGISTER_EMAIL', 'RESET_PASSWORD')", Integer.class)).isZero();
        // The captcha was not touched (the configuration check runs first).
        Map<String, Object> captchaRow = jdbc.queryForMap(
            "SELECT state, attempts FROM auth_challenge WHERE id=?", captchaId);
        assertThat(captchaRow.get("state")).isEqualTo("ACTIVE");
        assertThat(((Number) captchaRow.get("attempts")).intValue()).isZero();

        // Enabled but missing the runtime-only password still counts as not configured.
        EmailVerificationService missingPassword = new EmailVerificationService(
            store, captcha, users, mail, properties(true, ""), () -> CODE);
        ApiException passwordError = catchThrowableOfType(() -> missingPassword.request(
            new AuthContracts.EmailCodeRequest(AuthContracts.EmailPurpose.REGISTER_EMAIL,
                "someone@example.test", issueCaptcha(), CAPTCHA_ANSWER)), ApiException.class);
        assertThat(passwordError.code()).isEqualTo("MAIL_NOT_CONFIGURED");
        assertThat(passwordError.status()).isEqualTo(503);
    }

    @Test
    void restartLeftoverSendingCannotBeConsumedAndCanBeRequestedAgainAfterCooldown() {
        insertChallenge("leftover-sending", "REGISTER_EMAIL", "restart@example.test", "SENDING",
            NOW.plus(Duration.ofMinutes(10)), NOW.plus(Duration.ofSeconds(60)), NOW, 1, "123456");
        // A SENDING row from a crashed send is not consumable even with the right code.
        assertThat(store.verifyAndConsume("leftover-sending", AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "restart@example.test", "123456").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);

        clock.advance(Duration.ofSeconds(61));
        AuthContracts.EmailCodeResponse response = service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "restart@example.test", issueCaptcha(), CAPTCHA_ANSWER));

        assertThat(response.challengeId()).isNotEqualTo("leftover-sending");
        assertThat(mail.sends).hasSize(1);
        assertThat(mail.sends.get(0).code()).isEqualTo(CODE);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM auth_challenge WHERE id='leftover-sending'", Integer.class)).isZero();
        assertThat(store.verifyAndConsume("leftover-sending", AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "restart@example.test", "123456").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(store.verifyAndConsume(response.challengeId(), AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "restart@example.test", CODE).outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
    }

    @Test
    void captchaValidationAndCooldownMapToTheFixedErrors() {
        // Wrong captcha: fixed 422 and the failed attempt is persisted.
        String captchaId = issueCaptcha();
        ApiException wrongCaptcha = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "errors@example.test", captchaId, "ZZZZZ")), ApiException.class);
        assertThat(wrongCaptcha.code()).isEqualTo("CAPTCHA_INVALID");
        assertThat(wrongCaptcha.status()).isEqualTo(422);
        assertThat(jdbc.queryForObject("SELECT attempts FROM auth_challenge WHERE id=?", Integer.class, captchaId))
            .isEqualTo(1);

        // Malformed request fields never consume the captcha.
        String untouched = issueCaptcha();
        ApiException invalidEmail = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "not-an-email", untouched, CAPTCHA_ANSWER)), ApiException.class);
        assertThat(invalidEmail.code()).isEqualTo("VALIDATION_ERROR");
        assertThat(invalidEmail.status()).isEqualTo(422);
        assertThat(jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?", String.class, untouched))
            .isEqualTo("ACTIVE");
        ApiException missingPurpose = catchThrowableOfType(() -> service.request(
            new AuthContracts.EmailCodeRequest(null, "someone@example.test", issueCaptcha(), CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(missingPurpose.code()).isEqualTo("VALIDATION_ERROR");

        // A successful register send starts the per-email cooldown immediately.
        service.request(new AuthContracts.EmailCodeRequest(AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "cooldown@example.test", issueCaptcha(), CAPTCHA_ANSWER));
        ApiException cooldown = catchThrowableOfType(() -> service.request(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "cooldown@example.test", issueCaptcha(), CAPTCHA_ANSWER)),
            ApiException.class);
        assertThat(cooldown.code()).isEqualTo("AUTH_RATE_LIMITED");
        assertThat(cooldown.status()).isEqualTo(429);
    }

    // --- fixtures -------------------------------------------------------------------------

    private String issueCaptcha() {
        return captcha.issue("203.0.113.9").challengeId();
    }

    private static AuthProperties properties(boolean mailEnabled, String password) {
        return new AuthProperties(false, SECRET,
            new AuthProperties.Mail(mailEnabled, "smtp.example.test", 465, "sender@example.test",
                "sender@example.test", "ssl", password,
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)),
            new AuthProperties.Challenge(Duration.ofMinutes(2), 5, 1000, 1000,
                Duration.ofMinutes(10), 5, Duration.ofSeconds(60), 5));
    }

    private void insertUser(String id, String email, boolean enabled, Instant verifiedAt, long authVersion) {
        jdbc.update("""
            INSERT INTO app_user(id, username, password_hash, enabled, email, email_verified_at,
                auth_version, created_at)
            VALUES (?, ?, 'unused', ?, ?, ?, ?, ?)
            """, id, id, enabled, email,
            verifiedAt == null ? null : Timestamp.from(verifiedAt), authVersion, Timestamp.from(NOW));
    }

    private void insertChallenge(String id, String purpose, String email, String state, Instant expiresAt,
                                 Instant nextSendAt, Instant windowStartedAt, int windowSendCount, String answer) {
        jdbc.update("""
            INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, answer_mac, state,
                expires_at, attempts, next_send_at, window_started_at, window_send_count, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            """, id, purpose, email, expectedMac(id, purpose, email, answer), state,
            Timestamp.from(expiresAt), Timestamp.from(nextSendAt), Timestamp.from(windowStartedAt),
            windowSendCount, Timestamp.from(NOW), Timestamp.from(NOW));
    }

    private Map<String, Object> row(String id) {
        return jdbc.queryForMap("""
            SELECT state, purpose, email, user_id, auth_version_snapshot, answer_mac, window_send_count
            FROM auth_challenge WHERE id=?
            """, id);
    }

    private static String expectedMac(String id, String purpose, String email, String answer) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String material = id + "|" + purpose + "|" + (email == null ? "" : email) + "|" + answer;
            return java.util.HexFormat.of().formatHex(mac.doFinal(material.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    /** Capturing test double: records deliveries and can simulate an SMTP failure. */
    private static final class CapturingMail implements VerificationMailSender {
        private final List<SentMail> sends = new ArrayList<>();
        private int attempts;
        private RuntimeException failure;

        @Override
        public void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
            attempts++;
            if (failure != null) throw failure;
            sends.add(new SentMail(email, purpose, code, expiresAt));
        }
    }

    private record SentMail(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
    }

    /** Mutable UTC clock so TTL, cooldown and expiry windows are deterministic. */
    private static final class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override public Instant instant() {
            return now;
        }
    }
}
