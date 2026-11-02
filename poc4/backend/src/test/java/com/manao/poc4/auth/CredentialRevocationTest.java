package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.log.LogTicketService;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.terminal.JdbcTerminalStore;
import com.manao.poc4.terminal.TerminalStore;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Credential revocation on real MySQL (design 8.1/8.2): ticket issuance binds the REQUEST version
 * and is re-checked atomically, consumption JOINs the account version (pre-V17 NULL versions are
 * refused, never treated as current), terminal legacy RESERVED rows are released through the
 * existing legal EXPIRED state, and stream revocation runs only after the password transaction
 * commits — a callback failure never reports the committed password as unchanged.
 */
class CredentialRevocationTest {
    private static final String USER = "user-1";
    private static final String PROJECT = "project-1";
    private static final String RUN = "run-1";
    private static final String SECRET = "test-only-challenge-secret-0123456789";

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private UserStore users;
    private PasswordService passwords;
    private JwtService jwt;
    private AuthProperties properties;
    private AuthChallengeStore challenges;
    private UserSessionRevoker revoker;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        passwords = new PasswordService();
        jwt = new JwtService("0123456789abcdef0123456789abcdef", Duration.ofMinutes(15));
        properties = new AuthProperties(false, SECRET, null, null);
        users = new UserStore(jdbc);
        challenges = new AuthChallengeStore(jdbc, properties);
        revoker = new UserSessionRevoker();
        Timestamp now = Timestamp.from(Instant.now());
        jdbc.update("""
            INSERT INTO app_user(id, username, password_hash, enabled, email, email_verified_at,
                auth_version, created_at)
            VALUES (?, 'user_one', ?, TRUE, 'user@example.test', ?, 1, ?)
            """, USER, passwords.hash("old-password"), now, now);
        jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) "
            + "VALUES (?, ?, 'project', 'READY', 0, ?, ?)", PROJECT, USER, now, now);
        jdbc.update("""
            INSERT INTO run(id, project_id, requested_revision, state, policy_json, version,
                created_at, updated_at, fencing_token)
            VALUES (?, ?, 0, 'RUNNING', '{}', 0, ?, ?, 1)
            """, RUN, PROJECT, now, now);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void ticketIssuanceBindsTheRequestVersionAndConsumptionJoinsTheCurrentVersion() {
        LogTicketService service = new LogTicketService(new JdbcLogStore(jdbc), Clock.systemUTC(),
            (ownerId, projectId, runId) -> true);

        LogTicketService.IssuedTicket ticket = service.issue(USER, 1L, PROJECT, RUN);
        assertThat(jdbc.queryForObject("SELECT auth_version FROM log_ticket WHERE user_id=?",
            Long.class, USER)).isEqualTo(1L);

        // A stale request version can never be stamped with the DB's newer version.
        jdbc.update("UPDATE app_user SET auth_version=2 WHERE id=?", USER);
        ApiException stale = org.assertj.core.api.Assertions.catchThrowableOfType(
            () -> service.issue(USER, 1L, PROJECT, RUN), ApiException.class);
        assertThat(stale.code()).isEqualTo("UNAUTHENTICATED");
        assertThat(stale.status()).isEqualTo(401);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM log_ticket WHERE user_id=?", Integer.class, USER))
            .isEqualTo(1);

        // Atomic consumption: the ticket version no longer matches the account version.
        assertThat(service.consume(ticket.ticket())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM log_ticket WHERE user_id=? AND consumed_at IS NULL",
            Integer.class, USER)).isEqualTo(1);

        // Pre-V17 tickets with a NULL version are refused, never treated as current.
        String legacyRaw = "legacy-ticket-value";
        Timestamp future = Timestamp.from(Instant.now().plusSeconds(30));
        jdbc.update("INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at, auth_version) "
            + "VALUES (?, ?, ?, ?, ?, NULL)", sha256Hex(legacyRaw), USER, PROJECT, RUN, future);
        assertThat(service.consume(legacyRaw)).isEmpty();
    }

    @Test
    void terminalReservationBindsTheRequestVersionAndReleasesLegacyReservedRows() {
        JdbcTerminalStore store = new JdbcTerminalStore(jdbc);
        Instant futureInstant = Instant.now().plusSeconds(30);
        Timestamp future = Timestamp.from(futureInstant);
        jdbc.update("""
            INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at,
                cols, `rows`, auth_version)
            VALUES ('legacy-session', ?, ?, ?, 'RESERVED', ?, ?, 80, 24, NULL)
            """, PROJECT, RUN, USER, "b".repeat(64), future);

        TerminalStore.InsertResult inserted = store.insertReservation(new TerminalStore.ReservationRecord(
            "new-session", PROJECT, RUN, USER, 1L, "a".repeat(64), futureInstant, 80, 24));
        assertThat(inserted).isEqualTo(TerminalStore.InsertResult.INSERTED);
        // The pre-V17 RESERVED row is released through the existing legal EXPIRED state.
        assertThat(jdbc.queryForObject("SELECT state FROM terminal_session WHERE id='legacy-session'",
            String.class)).isEqualTo("EXPIRED");
        assertThat(jdbc.queryForObject("SELECT auth_version FROM terminal_session WHERE id='new-session'",
            Long.class)).isEqualTo(1L);
        // A stale request version cannot reserve.
        assertThat(store.insertReservation(new TerminalStore.ReservationRecord("stale-session", PROJECT, RUN,
            USER, 0L, "c".repeat(64), futureInstant, 80, 24)))
            .isEqualTo(TerminalStore.InsertResult.STALE_CREDENTIALS);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM terminal_session WHERE id='stale-session'",
            Integer.class)).isZero();

        TerminalStore.SessionRecord consumed = store.consumeReservation("a".repeat(64)).orElseThrow();
        assertThat(consumed.authVersion()).isEqualTo(1L);

        // Consumption JOINs the current version: after a password change the ticket is refused.
        jdbc.update("UPDATE app_user SET auth_version=2 WHERE id=?", USER);
        assertThat(store.consumeReservation("a".repeat(64))).isEmpty();
    }

    @Test
    void passwordChangeRevokesAfterCommitAndCallbackFailureNeverLies() {
        AuthService auth = new AuthService(jdbc, users, passwords, jwt, challenges, properties, revoker);
        AtomicInteger closes = new AtomicInteger();
        AtomicReference<Long> versionSeenAtClose = new AtomicReference<>();
        revoker.register(USER, 1, () -> {
            closes.incrementAndGet();
            versionSeenAtClose.set(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id=?",
                Long.class, USER));
        });

        auth.changePassword(new AuthContracts.AccountIdentity(USER, 1),
            new AuthContracts.PasswordChangeRequest("old-password", "new-secret-password"));

        assertThat(closes).hasValue(1);
        // The callback ran after commit: it observed the committed new version.
        assertThat(versionSeenAtClose).hasValue(2L);
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id=?", Long.class, USER))
            .isEqualTo(2L);
        assertThat(passwords.matches("new-secret-password",
            jdbc.queryForObject("SELECT password_hash FROM app_user WHERE id=?", String.class, USER))).isTrue();
        // Old JWTs already fail through the existing per-request version check.
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity(USER, 1))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity(USER, 2))).isTrue();

        // A broken close callback is contained: the committed password change still succeeds.
        revoker.register(USER, 2, () -> {
            throw new IllegalStateException("broken connection");
        });
        auth.changePassword(new AuthContracts.AccountIdentity(USER, 2),
            new AuthContracts.PasswordChangeRequest("new-secret-password", "third-secret-password"));
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id=?", Long.class, USER))
            .isEqualTo(3L);
    }

    @Test
    void bcryptRunsOnlyAfterTheEmailCodeWasAccepted() {
        AuthChallengeStore.ReserveResult reserved = challenges.reserveEmailSend(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "fresh@example.test", "654321", null, null);
        assertThat(challenges.activateSent(reserved.challengeId())).isTrue();
        PasswordService bcrypt = mock(PasswordService.class);
        // Registration must be enabled for this test to reach the code validation/hash ordering.
        AuthProperties enabled = new AuthProperties(true, SECRET, null, null);
        AuthService auth = new AuthService(jdbc, users, bcrypt, jwt, challenges, enabled, revoker);

        ApiException invalid = org.assertj.core.api.Assertions.catchThrowableOfType(() -> auth.register(
            new AuthContracts.RegisterRequest("fresh_name", "new-password-123", "fresh@example.test",
                reserved.challengeId(), "000000")), ApiException.class);
        assertThat(invalid.code()).isEqualTo("EMAIL_CODE_INVALID");
        // An anonymous invalid-code request must not reach the expensive password hash.
        org.mockito.Mockito.verify(bcrypt, org.mockito.Mockito.never()).hash(anyString());

        when(bcrypt.hash(anyString())).thenReturn("bcrypt-hash");
        AuthContracts.RegisteredUser registered = auth.register(new AuthContracts.RegisterRequest(
            "fresh_name", "new-password-123", "fresh@example.test", reserved.challengeId(), "654321"));
        assertThat(registered.username()).isEqualTo("fresh_name");
        org.mockito.Mockito.verify(bcrypt).hash("new-password-123");
    }

    @Test
    void aRolledBackPasswordTransactionNeverRevokes() {
        AuthChallengeStore.ReserveResult reserved = challenges.reserveEmailSend(
            AuthContracts.EmailPurpose.RESET_PASSWORD, "user@example.test", "654321", USER, 1L);
        assertThat(reserved.outcome()).isEqualTo(AuthChallengeStore.ReserveOutcome.RESERVED);
        assertThat(challenges.activateSent(reserved.challengeId())).isTrue();
        AtomicInteger closes = new AtomicInteger();
        revoker.register(USER, 1, closes::incrementAndGet);

        UserStore failing = mock(UserStore.class);
        when(failing.updatePassword(anyString(), anyString(), anyLong()))
            .thenThrow(new IllegalStateException("simulated write failure"));
        AuthService auth = new AuthService(jdbc, failing, passwords, jwt, challenges, properties, revoker);

        assertThatThrownBy(() -> auth.resetPassword(new AuthContracts.PasswordResetRequest(
            "user@example.test", reserved.challengeId(), "654321", "another-secret-password")))
            .isInstanceOf(IllegalStateException.class);

        // Rollback: no revocation and the still-valid challenge was not consumed.
        assertThat(closes).hasValue(0);
        assertThat(jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?",
            String.class, reserved.challengeId())).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT auth_version FROM app_user WHERE id=?", Long.class, USER))
            .isEqualTo(1L);
        assertThat(passwords.matches("old-password",
            jdbc.queryForObject("SELECT password_hash FROM app_user WHERE id=?", String.class, USER))).isTrue();
    }

    private static String sha256Hex(String value) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
