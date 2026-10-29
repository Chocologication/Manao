package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * One-time challenge storage: the send slot, the SENDING -> ACTIVE/FAILED delivery state machine,
 * attempt limiting, one-time consumption and the reset user/version binding. Tests run against a
 * disposable real MySQL schema; the clock is injected so cooldowns, windows and expiry are
 * deterministic. The answer itself must never be recoverable from the stored row.
 */
class AuthChallengeStoreTest {
    private static final String SECRET = "test-only-challenge-secret-0123456789";
    private static final Instant NOW = Instant.parse("2026-05-06T07:08:09Z");

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private MutableClock clock;
    private AuthChallengeStore store;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        clock = new MutableClock(NOW);
        store = new AuthChallengeStore(jdbc, properties(50, 100), clock);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void sendingStateIsNotConsumableAndPurposeAndEmailAreBoundToOneSlot() {
        var register = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "alice@example.com", "111111", null, null);
        assertThat(register.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        var reset = store.reserveEmailSend(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "alice@example.com", "222222", null, null);
        assertThat(reset.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        // One slot per purpose+email: a different purpose is an independent row.
        assertThat(reset.challengeId()).isNotEqualTo(register.challengeId());
        assertThat(state(register.challengeId())).isEqualTo("SENDING");
        assertThat(state(reset.challengeId())).isEqualTo("SENDING");

        // SENDING means "reserved, send in progress": it is not consumable yet and a wrong/pending
        // state must not burn attempts.
        assertThat(store.verifyAndConsume(register.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "alice@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(attempts(register.challengeId())).isZero();

        assertThat(store.activateSent(register.challengeId())).isTrue();
        assertThat(store.activateSent(reset.challengeId())).isTrue();
        assertThat(state(register.challengeId())).isEqualTo("ACTIVE");

        // The id is bound to its purpose and its email.
        assertThat(store.verifyAndConsume(register.challengeId(),
            AuthContracts.EmailPurpose.RESET_PASSWORD, "alice@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(store.verifyAndConsume(register.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "bob@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);

        var consumed = store.verifyAndConsume(register.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "alice@example.com", "111111");
        assertThat(consumed.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(consumed.userId()).isNull();
        assertThat(state(register.challengeId())).isEqualTo("CONSUMED");
        assertThat(store.verifyAndConsume(register.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "alice@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);

        // A reset slot without the user/version binding can never be consumed.
        assertThat(store.verifyAndConsume(reset.challengeId(),
            AuthContracts.EmailPurpose.RESET_PASSWORD, "alice@example.com", "222222").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void resendReplacesTheChallengeAndALateReceiptCannotActivateIt() {
        var first = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "resend@example.com", "111111", null, null);
        assertThat(first.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        assertThat(store.activateSent(first.challengeId())).isTrue();

        clock.advance(Duration.ofSeconds(61));
        var second = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "resend@example.com", "222222", null, null);
        assertThat(second.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        assertThat(second.challengeId()).isNotEqualTo(first.challengeId());
        // The resend replaces the row id; the old challenge no longer exists.
        assertThat(rowCount(first.challengeId())).isZero();
        assertThat(state(second.challengeId())).isEqualTo("SENDING");
        assertThat(windowCount(second.challengeId())).isEqualTo(2);

        // A late SMTP receipt for the superseded id must not activate the newer challenge.
        assertThat(store.activateSent(first.challengeId())).isFalse();
        assertThat(store.failSend(first.challengeId())).isFalse();
        assertThat(state(second.challengeId())).isEqualTo("SENDING");
        assertThat(store.activateSent(second.challengeId())).isTrue();

        // The old code is invalid, the current one works.
        assertThat(store.verifyAndConsume(first.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "resend@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(store.verifyAndConsume(second.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "resend@example.com", "222222").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
    }

    @Test
    void sendSlotEnforcesTheCooldownAndHourlyLimitAndFailedSendsCount() {
        var first = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "rate@example.com", "111111", null, null);
        assertThat(first.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        // A failed delivery still occupies the cooldown and the hourly window.
        assertThat(store.failSend(first.challengeId())).isTrue();

        var blocked = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "rate@example.com", "222222", null, null);
        assertThat(blocked.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.COOLDOWN);
        assertThat(blocked.retryAfterSeconds()).isEqualTo(60);

        for (int i = 2; i <= 5; i++) {
            clock.advance(Duration.ofSeconds(61));
            var allowed = store.reserveEmailSend(
                AuthContracts.EmailPurpose.REGISTER_EMAIL, "rate@example.com",
                "11111" + i, null, null);
            assertThat(allowed.outcome())
                .as("send %d inside the hour", i)
                .isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        }
        clock.advance(Duration.ofSeconds(61));
        var limited = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "rate@example.com", "999999", null, null);
        assertThat(limited.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RATE_LIMITED);
        assertThat(limited.retryAfterSeconds()).isPositive().isLessThanOrEqualTo(3600);

        // The window restarts after an hour; the slot is reusable again.
        clock.advance(Duration.ofHours(1));
        var nextWindow = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "rate@example.com", "999999", null, null);
        assertThat(nextWindow.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        assertThat(windowCount(nextWindow.challengeId())).isEqualTo(1);
    }

    @Test
    void wrongAnswersPersistAndExhaustTheAttemptLimit() {
        var reserved = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "attempts@example.com", "111111", null, null);
        String id = reserved.challengeId();
        assertThat(store.activateSent(id)).isTrue();

        for (int attempt = 1; attempt <= 5; attempt++) {
            var result = store.verifyAndConsume(id,
                AuthContracts.EmailPurpose.REGISTER_EMAIL, "attempts@example.com", "000000");
            assertThat(result.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
            assertThat(attempts(id)).as("wrong answer %d is persisted", attempt).isEqualTo(attempt);
        }
        assertThat(state(id)).isEqualTo("FAILED");
        // Exhausted challenge: the correct answer no longer works and is not counted as success.
        assertThat(store.verifyAndConsume(id,
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "attempts@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(attempts(id)).isEqualTo(5);
    }

    @Test
    void failedAttemptsCommitWithTheStoreTransactionUnlessTheCallerRollsBack() {
        var reserved = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "commit@example.com", "111111", null, null);
        String id = reserved.challengeId();
        assertThat(store.activateSent(id)).isTrue();

        // The store wraps the attempt write in its own short transaction: a failed verification
        // returns a result (not an exception) and commits before the caller maps the error.
        var result = store.verifyAndConsume(id,
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "commit@example.com", "000000");
        assertThat(result.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(attempts(id)).isEqualTo(1);

        // When the caller composes an outer transaction and rolls it back, the attempt rolls back
        // with it; the caller decides whether to commit or roll back the combined write.
        store.inTransaction(status -> {
            var inside = store.verifyAndConsume(id,
                AuthContracts.EmailPurpose.REGISTER_EMAIL, "commit@example.com", "000001");
            assertThat(inside.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
            status.setRollbackOnly();
            return null;
        });
        assertThat(attempts(id)).isEqualTo(1);
    }

    @Test
    void correctAnswersConsumeOnceAndExpiredChallengesAreRefused() {
        var reserved = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expiry@example.com", "111111", null, null);
        String id = reserved.challengeId();
        assertThat(store.activateSent(id)).isTrue();
        assertThat(store.verifyAndConsume(id,
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expiry@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(store.verifyAndConsume(id,
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expiry@example.com", "111111").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);

        var expiring = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expired@example.com", "333333", null, null);
        assertThat(store.activateSent(expiring.challengeId())).isTrue();
        clock.advance(Duration.ofMinutes(10).plusSeconds(1));
        assertThat(store.verifyAndConsume(expiring.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expired@example.com", "333333").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.EXPIRED);
        assertThat(state(expiring.challengeId())).isEqualTo("FAILED");
        assertThat(store.verifyAndConsume(expiring.challengeId(),
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "expired@example.com", "333333").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void resetCodesAreBoundToTheUserAndIssuingVersion() {
        insertUser("reset-user", "reset@example.com", true, NOW, 3);
        var stale = store.reserveEmailSend(AuthContracts.EmailPurpose.RESET_PASSWORD,
            "reset@example.com", "123456", "reset-user", 3L);
        assertThat(stale.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        assertThat(store.activateSent(stale.challengeId())).isTrue();

        // Any password change bumps auth_version; the previous reset code must die with it.
        jdbc.update("UPDATE app_user SET auth_version=4 WHERE id=?", "reset-user");
        assertThat(store.verifyAndConsume(stale.challengeId(), AuthContracts.EmailPurpose.RESET_PASSWORD,
            "reset@example.com", "123456").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(state(stale.challengeId())).isEqualTo("FAILED");

        clock.advance(Duration.ofSeconds(61));
        var fresh = store.reserveEmailSend(AuthContracts.EmailPurpose.RESET_PASSWORD,
            "reset@example.com", "654321", "reset-user", 4L);
        assertThat(store.activateSent(fresh.challengeId())).isTrue();
        var consumed = store.verifyAndConsume(fresh.challengeId(),
            AuthContracts.EmailPurpose.RESET_PASSWORD, "reset@example.com", "654321");
        assertThat(consumed.outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(consumed.userId()).isEqualTo("reset-user");
        assertThat(consumed.authVersionSnapshot()).isEqualTo(4L);

        // A disabled account is never a reset consumer, even at the matching version.
        clock.advance(Duration.ofSeconds(61));
        var disabled = store.reserveEmailSend(AuthContracts.EmailPurpose.RESET_PASSWORD,
            "reset@example.com", "999999", "reset-user", 4L);
        assertThat(store.activateSent(disabled.challengeId())).isTrue();
        jdbc.update("UPDATE app_user SET enabled=FALSE WHERE id=?", "reset-user");
        assertThat(store.verifyAndConsume(disabled.challengeId(), AuthContracts.EmailPurpose.RESET_PASSWORD,
            "reset@example.com", "999999").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(state(disabled.challengeId())).isEqualTo("FAILED");
    }

    @Test
    void captchaChallengesHaveNoEmailAndRespectTheActiveCap() {
        var capped = new AuthChallengeStore(jdbc, properties(2, 100), clock);
        assertThat(capped.createCaptcha("AB23C").outcome()).isEqualTo(AuthChallengeStore.CaptchaOutcome.ISSUED);
        assertThat(capped.createCaptcha("AB23C").outcome()).isEqualTo(AuthChallengeStore.CaptchaOutcome.ISSUED);
        assertThat(capped.createCaptcha("AB23C").outcome())
            .isEqualTo(AuthChallengeStore.CaptchaOutcome.CAPACITY_EXCEEDED);

        Map<String, Object> captcha = jdbc.queryForMap(
            "SELECT purpose, email, user_id FROM auth_challenge WHERE purpose='CAPTCHA' LIMIT 1");
        assertThat(captcha.get("purpose")).isEqualTo("CAPTCHA");
        assertThat(captcha.get("email")).isNull();
        assertThat(captcha.get("user_id")).isNull();

        // Expired CAPTCHA rows are collected opportunistically, freeing capacity without a scheduler.
        clock.advance(Duration.ofMinutes(2).plusSeconds(1));
        assertThat(capped.createCaptcha("AB23C").outcome()).isEqualTo(AuthChallengeStore.CaptchaOutcome.ISSUED);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM auth_challenge WHERE purpose='CAPTCHA' AND state='ACTIVE'", Integer.class))
            .isEqualTo(1);
    }

    @Test
    void captchaVerificationEnforcesAttemptsExpiryAndOneTimeConsume() {
        var created = store.createCaptcha("AB23C");
        String id = created.challengeId();
        assertThat(created.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(2)));
        for (int attempt = 1; attempt <= 5; attempt++) {
            assertThat(store.verifyAndConsumeCaptcha(id, "ZZZZZ").outcome())
                .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
            assertThat(attempts(id)).isEqualTo(attempt);
        }
        assertThat(state(id)).isEqualTo("FAILED");
        assertThat(store.verifyAndConsumeCaptcha(id, "AB23C").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);

        var expiring = store.createCaptcha("AB23C");
        clock.advance(Duration.ofMinutes(2).plusSeconds(1));
        assertThat(store.verifyAndConsumeCaptcha(expiring.challengeId(), "AB23C").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.EXPIRED);

        var valid = store.createCaptcha("AB23C");
        assertThat(store.verifyAndConsumeCaptcha(valid.challengeId(), "AB23C").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.CONSUMED);
        assertThat(store.verifyAndConsumeCaptcha(valid.challengeId(), "AB23C").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void opportunisticCleanupKeepsLiveAndRecentSendSlots() {
        // Expired CAPTCHA: deletable.
        insertChallenge("captcha-expired", "CAPTCHA", null, null, null, "ACTIVE",
            NOW.minusSeconds(1), 0, "AB23C", null, null, 0);
        // Expired email challenge whose hour window is over: deletable.
        insertChallenge("email-old-window", "REGISTER_EMAIL", "old@example.com", null, null, "FAILED",
            NOW.minusSeconds(1), 5, "111111", NOW.minus(Duration.ofHours(2)).plusSeconds(60),
            NOW.minus(Duration.ofHours(2)), 3);
        // Expired email challenge whose hour window is still active: must stay for the send limit.
        insertChallenge("email-recent-window", "REGISTER_EMAIL", "recent@example.com", null, null, "CONSUMED",
            NOW.minusSeconds(1), 1, "111111", NOW.minus(Duration.ofMinutes(1)).plusSeconds(60),
            NOW.minus(Duration.ofMinutes(1)), 1);
        // A still-running send (expiry in the future) must never be deleted.
        insertChallenge("email-live-sending", "REGISTER_EMAIL", "live@example.com", null, null, "SENDING",
            NOW.plus(Duration.ofMinutes(10)), 0, "111111", NOW.plus(Duration.ofSeconds(60)), NOW, 1);
        // A live CAPTCHA stays.
        insertChallenge("captcha-live", "CAPTCHA", null, null, null, "ACTIVE",
            NOW.plus(Duration.ofMinutes(2)), 0, "AB23C", null, null, 0);

        assertThat(store.createCaptcha("AB23C").outcome()).isEqualTo(AuthChallengeStore.CaptchaOutcome.ISSUED);

        assertThat(rowCount("captcha-expired")).isZero();
        assertThat(rowCount("email-old-window")).isZero();
        assertThat(rowCount("email-recent-window")).isEqualTo(1);
        assertThat(state("email-recent-window")).isEqualTo("CONSUMED");
        assertThat(rowCount("email-live-sending")).isEqualTo(1);
        assertThat(state("email-live-sending")).isEqualTo("SENDING");
        assertThat(rowCount("captcha-live")).isEqualTo(1);
    }

    @Test
    void hmacIsLowercaseHexAndTheAnswerIsNotStored() {
        var reserved = store.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "hmac@example.com", "135790", null, null);
        Map<String, Object> row = jdbc.queryForMap(
            "SELECT id, email, answer_mac FROM auth_challenge WHERE id=?", reserved.challengeId());
        String storedMac = (String) row.get("answer_mac");
        assertThat(storedMac).matches("[0-9a-f]{64}");
        assertThat(storedMac).isEqualTo(expectedMac(
            reserved.challengeId(), "REGISTER_EMAIL", "hmac@example.com", "135790"));
        assertThat(expectedMac(reserved.challengeId(), "REGISTER_EMAIL", "hmac@example.com", "135790"))
            .isNotEqualTo(expectedMac(reserved.challengeId(), "REGISTER_EMAIL", "hmac@example.com", "135791"));
        // The plaintext answer is never persisted in any column.
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM auth_challenge WHERE id=? AND (answer_mac='135790' OR CAST(attempts AS CHAR)='135790')",
            Integer.class, reserved.challengeId())).isZero();
    }

    @Test
    void unconfiguredSecretFailsClosedAndInvalidBindingsAreRejected() {
        var unconfigured = new AuthChallengeStore(jdbc, properties(50, 100, ""), clock);
        assertThatThrownBy(() -> unconfigured.createCaptcha("AB23C"))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> unconfigured.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "alice@example.com", "111111", null, null))
            .isInstanceOf(IllegalStateException.class);

        assertThatThrownBy(() -> store.reserveEmailSend(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "alice@example.com", "111111", "user-a", null))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.reserveEmailSend(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "alice@example.com", "111111", null, 3L))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(store.verifyAndConsume(null, AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "alice@example.com", "111111").outcome()).isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        assertThat(store.verifyAndConsumeCaptcha("missing", "AB23C").outcome())
            .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
    }

    @Test
    void subMicrosecondClockFractionCannotFakeACooldownOnTheFirstSend() {
        // MySQL rounds Timestamp nanos UP to TIMESTAMP(6) microseconds: a first-slot placeholder
        // stamped exactly "now" could read back in the future and produce a spurious 1 s cooldown.
        MutableClock roundUpClock = new MutableClock(Instant.parse("2026-05-06T07:08:09.999999500Z"));
        var roundedStore = new AuthChallengeStore(jdbc, properties(50, 100), roundUpClock);

        var first = roundedStore.reserveEmailSend(AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "rounding@example.test", "111111", null, null);
        assertThat(first.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);

        // A real resend inside the cooldown still reports 60 s (and the same round-trip clock).
        var resend = roundedStore.reserveEmailSend(AuthContracts.EmailPurpose.REGISTER_EMAIL,
            "rounding@example.test", "222222", null, null);
        assertThat(resend.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.COOLDOWN);
        assertThat(resend.retryAfterSeconds()).isEqualTo(60);
    }

    // --- review fixes: concurrency, allocation quota, first-slot creation ------------------

    @Test
    void concurrentVersionBumpInvalidatesTheResetCodeWithTwoConnections() throws Exception {
        insertUser("reset-race-user", "reset-race@example.test", true, NOW, 3);
        insertChallenge("reset-race", "RESET_PASSWORD", "reset-race@example.test", "reset-race-user", 3L,
            "ACTIVE", NOW.plus(Duration.ofMinutes(10)), 0, "123456",
            NOW.plus(Duration.ofSeconds(60)), NOW, 1);

        CountDownLatch snapshotTaken = new CountDownLatch(1);
        CountDownLatch versionBumped = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<AuthChallengeStore.VerifyResult> verification = executor.submit(() ->
                store.inTransaction(status -> {
                    // Establish the first transaction's REPEATABLE READ snapshot before the
                    // second connection changes the account row.
                    Integer snapshotVersion = jdbc.queryForObject(
                        "SELECT auth_version FROM app_user WHERE id=?", Integer.class, "reset-race-user");
                    assertThat(snapshotVersion).isEqualTo(3);
                    snapshotTaken.countDown();
                    try {
                        assertThat(versionBumped.await(5, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException ex) {
                        throw new IllegalStateException(ex);
                    }
                    return store.verifyAndConsume("reset-race", AuthContracts.EmailPurpose.RESET_PASSWORD,
                        "reset-race@example.test", "123456");
                }));
            assertThat(snapshotTaken.await(5, TimeUnit.SECONDS)).isTrue();
            // Second connection commits a password version bump and disabling while the first
            // transaction is open: the stale snapshot must not authorize the reset code.
            jdbc.update("UPDATE app_user SET auth_version=4, enabled=FALSE WHERE id=?", "reset-race-user");
            versionBumped.countDown();

            assertThat(verification.get(15, TimeUnit.SECONDS).outcome())
                .isEqualTo(AuthChallengeStore.VerifyOutcome.INVALID);
        } finally {
            executor.shutdownNow();
        }
        assertThat(state("reset-race")).isEqualTo("FAILED");
    }

    @Test
    void captchaActiveCapIsSerializedAcrossConcurrentAllocations() throws Exception {
        var capped = new AuthChallengeStore(jdbc, properties(2, 100), clock);
        assertThat(capped.createCaptcha("AB23C").outcome())
            .isEqualTo(AuthChallengeStore.CaptchaOutcome.ISSUED);

        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Callable<AuthChallengeStore.CaptchaOutcome> allocation = () -> {
                barrier.await(5, TimeUnit.SECONDS);
                return capped.createCaptcha("AB23C").outcome();
            };
            Future<AuthChallengeStore.CaptchaOutcome> first = executor.submit(allocation);
            Future<AuthChallengeStore.CaptchaOutcome> second = executor.submit(allocation);
            assertThat(List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(AuthChallengeStore.CaptchaOutcome.ISSUED,
                    AuthChallengeStore.CaptchaOutcome.CAPACITY_EXCEEDED);
        } finally {
            executor.shutdownNow();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_challenge WHERE purpose='CAPTCHA' "
            + "AND state='ACTIVE' AND expires_at > ?", Integer.class, Timestamp.from(clock.instant())))
            .isEqualTo(2);
    }

    @Test
    void concurrentFirstReservationCreatesASingleSendSlot() throws Exception {
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Callable<AuthChallengeStore.ReserveResult> reservation = () -> {
                barrier.await(5, TimeUnit.SECONDS);
                return store.reserveEmailSend(AuthContracts.EmailPurpose.REGISTER_EMAIL,
                    "first-slot@example.test", "111111", null, null);
            };
            Future<AuthChallengeStore.ReserveResult> first = executor.submit(reservation);
            Future<AuthChallengeStore.ReserveResult> second = executor.submit(reservation);
            List<AuthChallengeStore.ReserveResult> results =
                List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
            assertThat(results).extracting(AuthChallengeStore.ReserveResult::outcome)
                .containsExactlyInAnyOrder(AuthChallengeStore.ReserveOutcome.RESERVED,
                    AuthChallengeStore.ReserveOutcome.COOLDOWN);
        } finally {
            executor.shutdownNow();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_challenge WHERE purpose='REGISTER_EMAIL' "
            + "AND email='first-slot@example.test'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT window_send_count FROM auth_challenge WHERE purpose='REGISTER_EMAIL' "
            + "AND email='first-slot@example.test'", Integer.class)).isEqualTo(1);
    }

    // --- fixtures -------------------------------------------------------------------------

    private static AuthProperties properties(int maxActive, int perMinute) {
        return properties(maxActive, perMinute, SECRET);
    }

    private static AuthProperties properties(int maxActive, int perMinute, String secret) {
        return new AuthProperties(false, secret,
            new AuthProperties.Mail(false, "", 465, "", "", "ssl", "",
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)),
            new AuthProperties.Challenge(Duration.ofMinutes(2), 5, maxActive, perMinute,
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

    private void insertChallenge(String id, String purpose, String email, String userId, Long authVersion,
                                 String state, Instant expiresAt, int attempts, String answer,
                                 Instant nextSendAt, Instant windowStartedAt, int windowSendCount) {
        jdbc.update("""
            INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, answer_mac, state,
                expires_at, attempts, next_send_at, window_started_at, window_send_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, id, purpose, email, userId, authVersion, expectedMac(id, purpose, email, answer), state,
            Timestamp.from(expiresAt), attempts,
            nextSendAt == null ? null : Timestamp.from(nextSendAt),
            windowStartedAt == null ? null : Timestamp.from(windowStartedAt),
            windowSendCount, Timestamp.from(NOW), Timestamp.from(NOW));
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

    private Map<String, Object> row(String id) {
        return jdbc.queryForMap("SELECT state, attempts, window_send_count FROM auth_challenge WHERE id=?", id);
    }

    private String state(String id) {
        return jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?", String.class, id);
    }

    private int attempts(String id) {
        return jdbc.queryForObject("SELECT attempts FROM auth_challenge WHERE id=?", Integer.class, id);
    }

    private int rowCount(String id) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM auth_challenge WHERE id=?", Integer.class, id);
    }

    private int windowCount(String id) {
        return jdbc.queryForObject("SELECT window_send_count FROM auth_challenge WHERE id=?", Integer.class, id);
    }

    /** Mutable UTC clock so cooldown, window and expiry behaviour is deterministic. */
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
