package com.manao.poc4.auth;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.sql.DataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * JDBC storage for the one-time image/email challenges (design section 6).
 *
 * <p>Two kinds of rows share the table:
 * <ul>
 *   <li>CAPTCHA rows have a NULL email and are ACTIVE as soon as they are generated;</li>
 *   <li>REGISTER_EMAIL / RESET_PASSWORD rows live in one send slot per purpose+email. A send
 *       first reserves the slot as SENDING in a short transaction, the synchronous SMTP delivery
 *       happens outside that transaction, and the same id is then conditionally moved to ACTIVE
 *       or FAILED. A late receipt for a superseded id can never activate a newer challenge.</li>
 * </ul>
 *
 * <p>Only a lowercase-hex HMAC-SHA256 of {@code id|purpose|email|answer} is persisted; the answer
 * itself never reaches the database. Verification locks the row, persists wrong-answer attempts
 * before returning a result (the caller commits and only then maps the error), consumes the row
 * exactly once and, for RESET_PASSWORD, binds the user id plus the auth_version captured at send
 * time so any later password change invalidates the code.
 *
 * <p>Expired rows are cleaned opportunistically in small batches on write paths (no background
 * scheduler); a live SENDING row and a send slot whose hourly window is still running are kept so
 * the cooldown/window limits survive restarts.
 */
public final class AuthChallengeStore {
    static final String CAPTCHA_PURPOSE = "CAPTCHA";
    private static final String RESET_PURPOSE = AuthContracts.EmailPurpose.RESET_PASSWORD.name();
    private static final String SENDING = "SENDING";
    private static final String ACTIVE = "ACTIVE";
    private static final String CONSUMED = "CONSUMED";
    private static final String FAILED = "FAILED";
    private static final Duration SEND_WINDOW = Duration.ofHours(1);
    /** Fixed row locked FOR UPDATE while the CAPTCHA active-challenge quota is allocated. */
    private static final String CAPTCHA_ALLOCATION = "captcha";
    /** Fixed row locked FOR UPDATE while an email send slot is reserved. */
    private static final String EMAIL_SLOT_ALLOCATION = "email_send_slot";
    private static final int CLEANUP_BATCH = 20;
    private static final int ID_BYTES = 16;

    private static final String COLUMNS = "id, purpose, email, user_id, auth_version_snapshot, answer_mac, "
        + "state, expires_at, attempts, next_send_at, window_started_at, window_send_count";

    private final JdbcTemplate jdbc;
    private final String secret;
    private final AuthProperties.Challenge limits;
    private final Clock clock;
    private final TransactionTemplate transactions;
    private final TransactionTemplate cleanupTransactions;
    private final SecureRandom random = new SecureRandom();

    public AuthChallengeStore(JdbcTemplate jdbc, AuthProperties properties) {
        this(jdbc, properties, Clock.systemUTC());
    }

    public AuthChallengeStore(JdbcTemplate jdbc, AuthProperties properties, Clock clock) {
        if (jdbc == null) throw new IllegalArgumentException("jdbc template required");
        if (properties == null) throw new IllegalArgumentException("auth properties required");
        Objects.requireNonNull(clock, "clock");
        this.jdbc = jdbc;
        this.secret = properties.authChallengeSecret();
        this.limits = properties.challenge();
        this.clock = clock;
        DataSource dataSource = jdbc.getDataSource();
        if (dataSource == null) {
            throw new IllegalArgumentException("JdbcTemplate requires a DataSource");
        }
        DataSourceTransactionManager transactionManager = new DataSourceTransactionManager(dataSource);
        this.transactions = new TransactionTemplate(transactionManager);
        // Opportunistic cleanup never joins the caller's password/reservation transaction: it
        // runs in its own short transaction and can never mark the caller's transaction
        // rollback-only.
        this.cleanupTransactions = new TransactionTemplate(transactionManager);
        this.cleanupTransactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public Clock clock() {
        return clock;
    }

    /** The transaction template callers reuse to combine challenge consumption with account writes. */
    public TransactionTemplate transactions() {
        return transactions;
    }

    public <T> T inTransaction(TransactionCallback<T> callback) {
        return transactions.execute(callback);
    }

    // --- email code send slot -------------------------------------------------------------

    /**
     * Reserves (or re-reserves) the per purpose+email send slot as SENDING and returns the new
     * challenge id and expiry. A resend replaces the id/answer/state and keeps the hourly window
     * counter, invalidating the previous code. Cooldown and hourly limits both count failed sends.
     */
    public ReserveResult reserveEmailSend(AuthContracts.EmailPurpose purpose, String email, String answer,
                                          String userId, Long authVersionSnapshot) {
        requireConfigured();
        if (purpose == null) throw new IllegalArgumentException("purpose required");
        String normalizedEmail = AuthContracts.normalizeEmail(email);
        if (answer == null || answer.isBlank()) throw new IllegalArgumentException("answer required");
        if ((userId == null) != (authVersionSnapshot == null)) {
            throw new IllegalArgumentException("reset binding requires both user id and auth version");
        }
        // Opportunistic cleanup runs outside the reservation transaction: its index scans must
        // never become part of (or deadlock with) the send-slot serialization.
        cleanupExpiredBestEffort(clock.instant());
        return transactions.execute(status ->
            reserveInTransaction(purpose, normalizedEmail, answer, userId, authVersionSnapshot));
    }

    private ReserveResult reserveInTransaction(AuthContracts.EmailPurpose purpose, String email, String answer,
                                               String userId, Long authVersionSnapshot) {
        Instant now = clock.instant();
        // Serialize slot reservation on a fixed row: a concurrent FIRST reservation of the same
        // slot cannot deadlock on the unique key or the SELECT FOR UPDATE gap, and the slot
        // logic (cooldown/window/insert-or-replace) always runs against a committed row set. The
        // reservation transaction contains no SMTP work, so this short global lock is acceptable
        // for the single-backend small-scale release.
        List<String> allocation = jdbc.query(
            "SELECT name FROM auth_challenge_allocation WHERE name = ? FOR UPDATE",
            (rs, index) -> rs.getString(1), EMAIL_SLOT_ALLOCATION);
        if (allocation.isEmpty()) {
            throw new IllegalStateException("email slot allocation lock row is missing");
        }
        ensureSendSlot(purpose, email, now);
        List<SlotRow> slots = jdbc.query(
            "SELECT " + COLUMNS + " FROM auth_challenge WHERE purpose = ? AND email = ? FOR UPDATE",
            SLOT_ROW, purpose.name(), email);
        if (slots.isEmpty()) throw new IllegalStateException("email challenge slot is missing");
        SlotRow slot = slots.get(0);
        Instant windowStartedAt = now;
        int windowSendCount = 0;
        if (slot.nextSendAt() != null && now.isBefore(slot.nextSendAt())) {
            return new ReserveResult(ReserveOutcome.COOLDOWN, null, null,
                secondsUntil(now, slot.nextSendAt()));
        }
        if (slot.windowStartedAt() != null && now.isBefore(slot.windowStartedAt().plus(SEND_WINDOW))) {
            windowStartedAt = slot.windowStartedAt();
            windowSendCount = slot.windowSendCount();
        }
        if (windowSendCount >= limits.emailCodeHourlyLimit()) {
            return new ReserveResult(ReserveOutcome.RATE_LIMITED, null, null,
                secondsUntil(now, windowStartedAt.plus(SEND_WINDOW)));
        }
        String id = newIdentifier();
        String mac = answerMac(secret, id, purpose.name(), email, answer);
        Instant expiresAt = now.plus(limits.emailCodeTtl());
        Instant nextSendAt = now.plus(limits.emailCodeCooldown());
        Timestamp nowTimestamp = Timestamp.from(now);
        int updated = jdbc.update("UPDATE auth_challenge SET id = ?, user_id = ?, auth_version_snapshot = ?, "
                + "answer_mac = ?, state = 'SENDING', expires_at = ?, attempts = 0, next_send_at = ?, "
                + "window_started_at = ?, window_send_count = ?, created_at = ?, updated_at = ? "
                + "WHERE purpose = ? AND email = ?",
            id, userId, authVersionSnapshot, mac, Timestamp.from(expiresAt),
            Timestamp.from(nextSendAt), Timestamp.from(windowStartedAt), windowSendCount + 1,
            nowTimestamp, nowTimestamp, purpose.name(), email);
        if (updated != 1) throw new IllegalStateException("email challenge slot update lost");
        return new ReserveResult(ReserveOutcome.RESERVED, id, expiresAt,
            limits.emailCodeCooldown().toSeconds());
    }

    /**
     * Creates the slot row if it is missing. The no-op duplicate branch serializes concurrent
     * first reservations on the unique (purpose,email) key instead of relying on gap locks.
     */
    private void ensureSendSlot(AuthContracts.EmailPurpose purpose, String email, Instant now) {
        Timestamp nowTimestamp = Timestamp.from(now);
        Timestamp pastTimestamp = Timestamp.from(now.minusSeconds(1));
        jdbc.update("INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, "
                + "answer_mac, state, expires_at, attempts, next_send_at, window_started_at, "
                + "window_send_count, created_at, updated_at) "
                + "VALUES (?, ?, ?, NULL, NULL, ?, 'FAILED', ?, 0, ?, ?, 0, ?, ?) "
                + "ON DUPLICATE KEY UPDATE id = id",
            newIdentifier(), purpose.name(), email, "0".repeat(64), nowTimestamp, pastTimestamp,
            pastTimestamp, nowTimestamp, nowTimestamp);
    }

    /** SENDING -> ACTIVE; only the exact challenge id can be activated. */
    public boolean activateSent(String challengeId) {
        requireConfigured();
        if (challengeId == null || challengeId.isBlank()) return false;
        Timestamp now = Timestamp.from(clock.instant());
        return Boolean.TRUE.equals(transactions.execute(status -> jdbc.update(
            "UPDATE auth_challenge SET state = 'ACTIVE', updated_at = ? WHERE id = ? AND state = 'SENDING'",
            now, challengeId) == 1));
    }

    /** SENDING -> FAILED; a failed or lost send is terminal and never retried automatically. */
    public boolean failSend(String challengeId) {
        requireConfigured();
        if (challengeId == null || challengeId.isBlank()) return false;
        Timestamp now = Timestamp.from(clock.instant());
        return Boolean.TRUE.equals(transactions.execute(status -> jdbc.update(
            "UPDATE auth_challenge SET state = 'FAILED', updated_at = ? WHERE id = ? AND state = 'SENDING'",
            now, challengeId) == 1));
    }

    // --- verification ---------------------------------------------------------------------

    /** Verifies and consumes an email code bound to its purpose and normalized email. */
    public VerifyResult verifyAndConsume(String challengeId, AuthContracts.EmailPurpose purpose,
                                         String email, String answer) {
        requireConfigured();
        if (purpose == null) throw new IllegalArgumentException("purpose required");
        String normalizedEmail = AuthContracts.normalizeEmail(email);
        if (challengeId == null || challengeId.isBlank() || answer == null || answer.isBlank()) {
            return invalid();
        }
        return transactions.execute(status ->
            verifyEmailCode(challengeId, purpose.name(), normalizedEmail, answer));
    }

    private VerifyResult verifyEmailCode(String challengeId, String purpose, String email, String answer) {
        List<SlotRow> rows = lockChallenge(challengeId);
        if (rows.isEmpty()) return invalid();
        SlotRow row = rows.get(0);
        if (!row.purpose().equals(purpose) || !Objects.equals(row.email(), email)) {
            return invalid();
        }
        return consume(row, answer, limits.emailCodeAttempts());
    }

    /** Verifies and consumes an image captcha challenge (purpose CAPTCHA, NULL email). */
    public VerifyResult verifyAndConsumeCaptcha(String challengeId, String answer) {
        requireConfigured();
        if (challengeId == null || challengeId.isBlank() || answer == null || answer.isBlank()) {
            return invalid();
        }
        return transactions.execute(status -> {
            List<SlotRow> rows = lockChallenge(challengeId);
            if (rows.isEmpty()) return invalid();
            SlotRow row = rows.get(0);
            if (!row.purpose().equals(CAPTCHA_PURPOSE) || row.email() != null) return invalid();
            return consume(row, answer, limits.captchaAttempts());
        });
    }

    private VerifyResult consume(SlotRow row, String answer, int maxAttempts) {
        Instant now = clock.instant();
        if (!ACTIVE.equals(row.state())) {
            return invalid();
        }
        if (!now.isBefore(row.expiresAt())) {
            markState(row.id(), FAILED, now);
            return new VerifyResult(VerifyOutcome.EXPIRED, null, null);
        }
        if (row.attempts() >= maxAttempts) {
            markState(row.id(), FAILED, now);
            return new VerifyResult(VerifyOutcome.ATTEMPTS_EXCEEDED, null, null);
        }
        String expected = answerMac(secret, row.id(), row.purpose(), row.email(), answer);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
            row.answerMac().getBytes(StandardCharsets.US_ASCII))) {
            int attempts = row.attempts() + 1;
            String state = attempts >= maxAttempts ? FAILED : ACTIVE;
            jdbc.update("UPDATE auth_challenge SET attempts = ?, state = ?, updated_at = ? WHERE id = ?",
                attempts, state, Timestamp.from(now), row.id());
            return invalid();
        }
        if (RESET_PURPOSE.equals(row.purpose()) && !resetTargetIsCurrent(row, now)) {
            return invalid();
        }
        int updated = jdbc.update(
            "UPDATE auth_challenge SET state = 'CONSUMED', updated_at = ? WHERE id = ? AND state = 'ACTIVE'",
            Timestamp.from(now), row.id());
        if (updated != 1) return invalid();
        return new VerifyResult(VerifyOutcome.CONSUMED, row.userId(), row.authVersionSnapshot());
    }

    private boolean resetTargetIsCurrent(SlotRow row, Instant now) {
        if (row.userId() == null || row.authVersionSnapshot() == null) {
            markState(row.id(), FAILED, now);
            return false;
        }
        // Locking read (not a plain snapshot read): a concurrent password change/disable that
        // committed since this transaction started must be visible before the code is consumed.
        // Lock order is always challenge row -> app_user row, shared by reserve/verify.
        List<AccountRow> accounts = jdbc.query(
            "SELECT enabled, auth_version FROM app_user WHERE id = ? FOR UPDATE",
            (rs, index) -> new AccountRow(rs.getBoolean("enabled"), rs.getLong("auth_version")), row.userId());
        if (accounts.isEmpty() || !accounts.get(0).enabled()
            || accounts.get(0).authVersion() != row.authVersionSnapshot().longValue()) {
            markState(row.id(), FAILED, now);
            return false;
        }
        return true;
    }

    // --- image captcha --------------------------------------------------------------------

    /**
     * Creates one ACTIVE image-captcha challenge unless the configured cap on currently active
     * CAPTCHA rows is reached. CAPTCHA rows carry a NULL email, so they never occupy a send slot.
     */
    public CaptchaResult createCaptcha(String answer) {
        requireConfigured();
        if (answer == null || answer.isBlank()) throw new IllegalArgumentException("answer required");
        cleanupExpiredBestEffort(clock.instant());
        return transactions.execute(status -> {
            Instant now = clock.instant();
            // Serialize the whole count+insert allocation. The fixed quota row is the mutex; the
            // opportunistic DELETE runs outside this transaction and is never relied on for
            // mutual exclusion.
            List<String> allocation = jdbc.query(
                "SELECT name FROM auth_challenge_allocation WHERE name = ? FOR UPDATE",
                (rs, index) -> rs.getString(1), CAPTCHA_ALLOCATION);
            if (allocation.isEmpty()) {
                throw new IllegalStateException("captcha allocation lock row is missing");
            }
            Integer active = jdbc.queryForObject(
                "SELECT COUNT(*) FROM auth_challenge WHERE purpose = ? AND state = 'ACTIVE' AND expires_at > ?",
                Integer.class, CAPTCHA_PURPOSE, Timestamp.from(now));
            if (active != null && active >= limits.captchaMaxActive()) {
                return new CaptchaResult(CaptchaOutcome.CAPACITY_EXCEEDED, null, null);
            }
            String id = newIdentifier();
            String mac = answerMac(secret, id, CAPTCHA_PURPOSE, null, answer);
            Instant expiresAt = now.plus(limits.captchaTtl());
            Timestamp nowTimestamp = Timestamp.from(now);
            jdbc.update("INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, answer_mac, "
                    + "state, expires_at, attempts, next_send_at, window_started_at, window_send_count, "
                    + "created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, 'ACTIVE', ?, 0, NULL, NULL, 0, ?, ?)",
                id, CAPTCHA_PURPOSE, mac, Timestamp.from(expiresAt), nowTimestamp, nowTimestamp);
            return new CaptchaResult(CaptchaOutcome.ISSUED, id, expiresAt);
        });
    }

    // --- helpers --------------------------------------------------------------------------

    /**
     * Small opportunistic cleanup, best effort and deliberately outside any allocation
     * transaction. Expired CAPTCHA rows are deleted; an expired email challenge is deleted only
     * once its hourly send window has ended, so the cooldown/window counters stay effective. Rows
     * that are not expired (including a live SENDING send) are never touched. A transient
     * lock/deadlock failure only skips this cleanup pass; it must never affect the caller's
     * request or be used as mutual exclusion.
     */
    private void cleanupExpiredBestEffort(Instant now) {
        // A suspended caller can hold rows this new transaction would wait on itself.
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) return;
        try {
            cleanupTransactions.executeWithoutResult(status -> jdbc.update(
                "DELETE FROM auth_challenge WHERE expires_at < ? AND (purpose = ? "
                    + "OR window_started_at IS NULL OR window_started_at <= ?) ORDER BY expires_at LIMIT "
                    + CLEANUP_BATCH,
                Timestamp.from(now), CAPTCHA_PURPOSE, Timestamp.from(now.minus(SEND_WINDOW))));
        } catch (DataAccessException | org.springframework.transaction.TransactionException ex) {
            // Opportunistic cleanup only: a concurrent lock conflict skips this pass.
        }
    }

    private List<SlotRow> lockChallenge(String challengeId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM auth_challenge WHERE id = ? FOR UPDATE",
            SLOT_ROW, challengeId);
    }

    private void markState(String challengeId, String state, Instant now) {
        jdbc.update("UPDATE auth_challenge SET state = ?, updated_at = ? WHERE id = ?",
            state, Timestamp.from(now), challengeId);
    }

    private String newIdentifier() {
        byte[] bytes = new byte[ID_BYTES];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private void requireConfigured() {
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException("MANAO_AUTH_CHALLENGE_SECRET is not configured");
        }
    }

    private static VerifyResult invalid() {
        return new VerifyResult(VerifyOutcome.INVALID, null, null);
    }

    /** Ceiling seconds so a reported retry delay never tells the client to retry too early. */
    private static long secondsUntil(Instant now, Instant target) {
        Duration remaining = Duration.between(now, target);
        if (remaining.isNegative()) return 0;
        long millis = remaining.toMillis();
        if (millis <= 0) return remaining.isZero() ? 0 : 1;
        return (millis + 999) / 1000;
    }

    /**
     * Lowercase hex HMAC-SHA256 over {@code id|purpose|email|answer}; a NULL email is the empty
     * string. Package-private so refusal tests can reproduce the exact stored value.
     */
    static String answerMac(String secret, String id, String purpose, String email, String answer) {
        String material = id + "|" + purpose + "|" + (email == null ? "" : email) + "|" + answer;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(material.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", ex);
        }
    }

    private static final RowMapper<SlotRow> SLOT_ROW = (rs, rowNumber) -> new SlotRow(
        rs.getString("id"),
        rs.getString("purpose"),
        rs.getString("email"),
        rs.getString("user_id"),
        nullableLong(rs, "auth_version_snapshot"),
        rs.getString("answer_mac"),
        rs.getString("state"),
        rs.getTimestamp("expires_at").toInstant(),
        rs.getInt("attempts"),
        instantOrNull(rs.getTimestamp("next_send_at")),
        instantOrNull(rs.getTimestamp("window_started_at")),
        rs.getInt("window_send_count"));

    private static Long nullableLong(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
        long value = rs.getLong(column);
        return rs.wasNull() ? null : value;
    }

    private static Instant instantOrNull(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    private record SlotRow(String id, String purpose, String email, String userId, Long authVersionSnapshot,
                           String answerMac, String state, Instant expiresAt, int attempts,
                           Instant nextSendAt, Instant windowStartedAt, int windowSendCount) {
    }

    private record AccountRow(boolean enabled, long authVersion) {
    }

    /** Outcome of reserving the per purpose+email send slot. */
    public enum ReserveOutcome {
        RESERVED, COOLDOWN, RATE_LIMITED
    }

    public record ReserveResult(ReserveOutcome outcome, String challengeId, Instant expiresAt,
                                long retryAfterSeconds) {
    }

    /** Outcome of one verification attempt; only CONSUMED is a success. */
    public enum VerifyOutcome {
        CONSUMED, INVALID, EXPIRED, ATTEMPTS_EXCEEDED
    }

    public record VerifyResult(VerifyOutcome outcome, String userId, Long authVersionSnapshot) {
        public boolean consumed() {
            return outcome == VerifyOutcome.CONSUMED;
        }
    }

    /** Outcome of creating one image captcha. */
    public enum CaptchaOutcome {
        ISSUED, CAPACITY_EXCEEDED
    }

    public record CaptchaResult(CaptchaOutcome outcome, String challengeId, Instant expiresAt) {
    }
}
