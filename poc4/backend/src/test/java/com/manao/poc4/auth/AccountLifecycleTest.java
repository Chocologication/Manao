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
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Account lifecycle transactions on disposable MySQL: registration is atomic and leaves no user
 * before success, a username conflict keeps the still-valid email code consumable, a reset code is
 * bound to the issuing user/auth_version, and the password writes are conditional on the request's
 * version. Email delivery is captured, never sent.
 */
class AccountLifecycleTest {
    private static final String JWT_SECRET = "0123456789abcdef0123456789abcdef";
    private static final String CHALLENGE_SECRET = "test-only-challenge-secret-0123456789";
    private static final String CAPTCHA_ANSWER = "AB23C";
    private static final String CODE = "654321";
    private static final String MAIL_PASSWORD = "test-only-client-authorization-code";
    private static final Instant NOW = Instant.parse("2026-05-06T07:08:09Z");

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private MutableClock clock;
    private AuthProperties properties;
    private PasswordService passwords;
    private JwtService jwt;
    private AuthChallengeStore store;
    private CaptchaService captcha;
    private UserStore users;
    private CapturingMail mail;
    private EmailVerificationService emailCodes;
    private AuthService auth;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        clock = new MutableClock(NOW);
        properties = properties(true);
        passwords = new PasswordService();
        jwt = new JwtService(JWT_SECRET, Duration.ofMinutes(15));
        store = new AuthChallengeStore(jdbc, properties, clock);
        captcha = new CaptchaService(store, properties, clock, () -> CAPTCHA_ANSWER);
        users = new UserStore(jdbc);
        mail = new CapturingMail();
        emailCodes = new EmailVerificationService(store, captcha, users, mail, properties, () -> CODE);
        auth = new AuthService(jdbc, users, passwords, jwt, store, properties);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void registrationIsAtomicAndConsumesTheEmailCodeOnce() {
        String email = "register@example.test";
        String challenge = requestCode(AuthContracts.EmailPurpose.REGISTER_EMAIL, email);
        assertThat(count("SELECT COUNT(*) FROM app_user WHERE email=?", email)).isZero();

        AuthContracts.RegisteredUser registered = auth.register(new AuthContracts.RegisterRequest(
            "New_User", "new-password-123", " Register@Example.TEST ", challenge, CODE));

        assertThat(registered.username()).isEqualTo("new_user");
        var row = jdbc.queryForMap("SELECT username, email, email_verified_at, auth_version, password_hash, "
            + "enabled FROM app_user WHERE id=?", registered.id());
        assertThat(row.get("username")).isEqualTo("new_user");
        assertThat(row.get("email")).isEqualTo("register@example.test");
        assertThat(row.get("email_verified_at")).isNotNull();
        assertThat(((Number) row.get("auth_version")).longValue()).isZero();
        assertThat(row.get("enabled")).isEqualTo(true);
        assertThat(passwords.matches("new-password-123", (String) row.get("password_hash"))).isTrue();
        assertThat(challengeState(challenge)).isEqualTo("CONSUMED");

        // The one-time code cannot create a second account (the already-bound address would win
        // with EMAIL_TAKEN first, so probe the code with a different address).
        ApiException reused = catchThrowableOfType(() -> auth.register(new AuthContracts.RegisterRequest(
            "other_user", "new-password-123", "reuse@example.test", challenge, CODE)), ApiException.class);
        assertThat(reused.code()).isEqualTo("EMAIL_CODE_INVALID");
        assertThat(reused.status()).isEqualTo(422);
        assertThat(count("SELECT COUNT(*) FROM app_user WHERE username='other_user'", new Object[0])).isZero();
    }

    @Test
    void usernameConflictKeepsTheEmailCodeValidForRenaming() {
        insertUser("legacy-id", "taken_name", null, false, 0, "legacy-password");
        String email = "rename@example.test";
        String challenge = requestCode(AuthContracts.EmailPurpose.REGISTER_EMAIL, email);

        ApiException conflict = catchThrowableOfType(() -> auth.register(new AuthContracts.RegisterRequest(
            "Taken_Name", "new-password-123", email, challenge, CODE)), ApiException.class);
        assertThat(conflict.code()).isEqualTo("USERNAME_TAKEN");
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(challengeState(challenge)).isEqualTo("ACTIVE");
        assertThat(count("SELECT COUNT(*) FROM app_user WHERE email=?", email)).isZero();

        // The user can rename and reuse the still-valid code.
        AuthContracts.RegisteredUser registered = auth.register(new AuthContracts.RegisterRequest(
            "available_name", "new-password-123", email, challenge, CODE));
        assertThat(registered.username()).isEqualTo("available_name");
        assertThat(challengeState(challenge)).isEqualTo("CONSUMED");
    }

    @Test
    void emailConflictIsRejectedWithoutCreatingAnAccount() {
        insertUser("existing-id", "existing_name", "dup@example.test", true, 0, "old-password");
        String challenge = requestCode(AuthContracts.EmailPurpose.REGISTER_EMAIL, "dup@example.test");

        ApiException conflict = catchThrowableOfType(() -> auth.register(new AuthContracts.RegisterRequest(
            "fresh_name", "new-password-123", "dup@example.test", challenge, CODE)), ApiException.class);
        assertThat(conflict.code()).isEqualTo("EMAIL_TAKEN");
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(count("SELECT COUNT(*) FROM app_user WHERE username='fresh_name'", new Object[0])).isZero();
        assertThat(challengeState(challenge)).isEqualTo("ACTIVE");
    }

    @Test
    void registrationClosedRefusesTheFinalSubmitEvenWithAValidCode() {
        String challenge = requestCode(AuthContracts.EmailPurpose.REGISTER_EMAIL, "closed@example.test");
        AuthService closed = new AuthService(jdbc, users, passwords, jwt, store, properties(false));

        ApiException refused = catchThrowableOfType(() -> closed.register(new AuthContracts.RegisterRequest(
            "closed_user", "new-password-123", "closed@example.test", challenge, CODE)), ApiException.class);
        assertThat(refused.code()).isEqualTo("REGISTRATION_CLOSED");
        assertThat(refused.status()).isEqualTo(403);
        assertThat(count("SELECT COUNT(*) FROM app_user WHERE email='closed@example.test'", new Object[0])).isZero();
        assertThat(challengeState(challenge)).isEqualTo("ACTIVE");
    }

    @Test
    void resetConsumesTheVersionBoundCodeAndBumpsThePasswordVersion() {
        insertUser("reset-id", "reset_user", "reset@example.test", true, 0, "old-password");
        String challenge = requestCode(AuthContracts.EmailPurpose.RESET_PASSWORD, "reset@example.test");

        auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "reset@example.test", challenge, CODE, "brand-new-password"));

        var row = jdbc.queryForMap("SELECT password_hash, auth_version FROM app_user WHERE id='reset-id'");
        assertThat(passwords.matches("brand-new-password", (String) row.get("password_hash"))).isTrue();
        assertThat(passwords.matches("old-password", (String) row.get("password_hash"))).isFalse();
        assertThat(((Number) row.get("auth_version")).longValue()).isEqualTo(1);
        assertThat(challengeState(challenge)).isEqualTo("CONSUMED");
        // The old token version stops being current; Task 6 owns stream revocation.
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("reset-id", 0))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("reset-id", 1))).isTrue();

        ApiException reused = catchThrowableOfType(() -> auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "reset@example.test", challenge, CODE, "another-password")), ApiException.class);
        assertThat(reused.code()).isEqualTo("EMAIL_CODE_INVALID");
        assertThat(reused.status()).isEqualTo(422);
    }

    @Test
    void resetRefusalsAreUniformAndAttemptsAreNotRolledBack() {
        insertUser("reset-id", "reset_user", "reset@example.test", true, 0, "old-password");
        String challenge = requestCode(AuthContracts.EmailPurpose.RESET_PASSWORD, "reset@example.test");
        String originalHash = jdbc.queryForObject(
            "SELECT password_hash FROM app_user WHERE id='reset-id'", String.class);

        // Wrong code: same fixed error; the failed attempt persists in the committed transaction.
        ApiException wrong = catchThrowableOfType(() -> auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "reset@example.test", challenge, "000000", "brand-new-password")), ApiException.class);
        assertThat(wrong.code()).isEqualTo("EMAIL_CODE_INVALID");
        assertThat(jdbc.queryForObject("SELECT attempts FROM auth_challenge WHERE id=?", Integer.class, challenge))
            .isEqualTo(1);

        // Unknown address uses exactly the same fixed error.
        ApiException unknown = catchThrowableOfType(() -> auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "nobody@example.test", challenge, CODE, "brand-new-password")), ApiException.class);
        assertThat(unknown.code()).isEqualTo("EMAIL_CODE_INVALID");

        // A concurrent password change invalidates the code that was bound to the old version.
        jdbc.update("UPDATE app_user SET auth_version=1 WHERE id='reset-id'");
        ApiException stale = catchThrowableOfType(() -> auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "reset@example.test", challenge, CODE, "brand-new-password")), ApiException.class);
        assertThat(stale.code()).isEqualTo("EMAIL_CODE_INVALID");
        assertThat(jdbc.queryForObject("SELECT password_hash FROM app_user WHERE id='reset-id'", String.class))
            .isEqualTo(originalHash);
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id='reset-id'", Long.class))
            .isEqualTo(1L);
    }

    @Test
    void changePasswordIsConditionalOnTheRequestVersionAndSupportsLegacyNullEmail() {
        insertUser("change-id", "change_user", null, true, 2, "old-password");

        ApiException wrong = catchThrowableOfType(() -> auth.changePassword(
            new AuthContracts.AccountIdentity("change-id", 2),
            new AuthContracts.PasswordChangeRequest("wrong-password", "new-secret-password")), ApiException.class);
        assertThat(wrong.code()).isEqualTo("CURRENT_PASSWORD_INVALID");
        assertThat(wrong.status()).isEqualTo(422);

        auth.changePassword(new AuthContracts.AccountIdentity("change-id", 2),
            new AuthContracts.PasswordChangeRequest("old-password", "new-secret-password"));
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id='change-id'", Long.class))
            .isEqualTo(3L);
        assertThat(passwords.matches("new-secret-password", jdbc.queryForObject(
            "SELECT password_hash FROM app_user WHERE id='change-id'", String.class))).isTrue();
        // The legacy NULL-email account changed its password with only currentPassword.

        // A stale request version (another tab/connection already changed the password) is
        // refused without overwriting the newer hash.
        String currentHash = jdbc.queryForObject(
            "SELECT password_hash FROM app_user WHERE id='change-id'", String.class);
        ApiException stale = catchThrowableOfType(() -> auth.changePassword(
            new AuthContracts.AccountIdentity("change-id", 2),
            new AuthContracts.PasswordChangeRequest("new-secret-password", "third-secret-password")), ApiException.class);
        assertThat(stale.status()).isEqualTo(401);
        assertThat(jdbc.queryForObject("SELECT password_hash FROM app_user WHERE id='change-id'", String.class))
            .isEqualTo(currentHash);
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id='change-id'", Long.class))
            .isEqualTo(3L);
    }

    @Test
    void newPasswordRulesApplyOnlyToNewPasswordsWhileLegacyLoginKeepsWorking() {
        insertUser("legacy-id", "legacy_user", null, true, 0, "old");
        // Legacy (short) passwords still log in; the new minimum is not applied to login.
        AuthContracts.LoginResponse login = auth.login(new AuthContracts.LoginRequest("legacy_user", "old"));
        assertThat(jwt.parse(login.accessToken()).authVersion()).isZero();

        for (String invalid : new String[] {"short7c", "a".repeat(65), "é".repeat(40)}) {
            ApiException validation = catchThrowableOfType(() -> auth.changePassword(
                new AuthContracts.AccountIdentity("legacy-id", 0),
                new AuthContracts.PasswordChangeRequest("old", invalid)), ApiException.class);
            assertThat(validation.code())
                .as("password %s", invalid)
                .isEqualTo("VALIDATION_ERROR");
            assertThat(validation.status()).isEqualTo(422);
        }
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id='legacy-id'", Long.class))
            .isZero();
        assertThat(passwords.matches("old", jdbc.queryForObject(
            "SELECT password_hash FROM app_user WHERE id='legacy-id'", String.class))).isTrue();
    }

    @Test
    void loginSignsTheCurrentVersionAndUsesTheGenericUnauthenticatedError() {
        insertUser("login-id", "login_user", "login@example.test", true, 4, "correct-password");
        AuthContracts.LoginResponse response =
            auth.login(new AuthContracts.LoginRequest("login_user", "correct-password"));
        JwtService.Claims claims = jwt.parse(response.accessToken());
        assertThat(claims.subject()).isEqualTo("login-id");
        assertThat(claims.authVersion()).isEqualTo(4);
        assertThat(response.user().email()).isEqualTo("login@example.test");
        assertThat(response.user().emailVerified()).isTrue();

        for (AuthContracts.LoginRequest request : new AuthContracts.LoginRequest[] {
            new AuthContracts.LoginRequest("login_user", "wrong-password"),
            new AuthContracts.LoginRequest("missing_user", "correct-password")}) {
            ApiException error = catchThrowableOfType(() -> auth.login(request), ApiException.class);
            assertThat(error.code()).isEqualTo("UNAUTHENTICATED");
            assertThat(error.status()).isEqualTo(401);
        }
    }

    // --- fixtures -------------------------------------------------------------------------

    private String requestCode(AuthContracts.EmailPurpose purpose, String email) {
        String captchaId = captcha.issue("203.0.113.9").challengeId();
        return emailCodes.request(new AuthContracts.EmailCodeRequest(purpose, email, captchaId, CAPTCHA_ANSWER))
            .challengeId();
    }

    private static AuthProperties properties(boolean registrationEnabled) {
        return new AuthProperties(registrationEnabled, CHALLENGE_SECRET,
            new AuthProperties.Mail(true, "smtp.example.test", 465, "sender@example.test",
                "sender@example.test", "ssl", MAIL_PASSWORD,
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)),
            new AuthProperties.Challenge(Duration.ofMinutes(2), 5, 1000, 1000,
                Duration.ofMinutes(10), 5, Duration.ofSeconds(60), 5));
    }

    private void insertUser(String id, String username, String email, boolean verified, long authVersion,
                            String rawPassword) {
        jdbc.update("""
            INSERT INTO app_user(id, username, password_hash, enabled, email, email_verified_at,
                auth_version, created_at)
            VALUES (?, ?, ?, TRUE, ?, ?, ?, ?)
            """, id, username, passwords.hash(rawPassword), email,
            verified ? Timestamp.from(NOW) : null, authVersion, Timestamp.from(NOW));
    }

    private int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    private String challengeState(String id) {
        return jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?", String.class, id);
    }

    private static final class CapturingMail implements VerificationMailSender {
        private final List<String> codes = new ArrayList<>();
        private RuntimeException failure;

        @Override
        public void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
            if (failure != null) throw failure;
            codes.add(code);
        }
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
