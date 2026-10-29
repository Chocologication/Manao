package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V17 schema contract. The upgrade is additive: legacy accounts, their BCrypt hashes and their
 * projects survive untouched with a NULL email and auth_version 0; the email identity is
 * uniquely constrained with binary comparison; the shared challenge table and the ticket
 * version columns exist for the account lifecycle tasks that follow.
 */
class AccountSchemaTest {
    private static final Instant NOW = Instant.parse("2026-02-03T04:05:06Z");
    private static final Timestamp TS = Timestamp.from(NOW);
    private static final String LEGACY_HASH = new PasswordService().hash("legacy-password");

    @Test
    void upgradeFromV16PreservesLegacyUsersProjectsAndPasswordHashes() {
        try (var db = JdbcStoreTestSupport.createAtVersion("16")) {
            JdbcTemplate jdbc = db.jdbc();
            insertUser(jdbc, "legacy-user", "legacy-name");
            insertProject(jdbc, "legacy-project", "legacy-user");
            assertThat(latestVersion(jdbc)).isEqualTo("16");

            db.migrateToLatest();

            assertThat(latestVersion(jdbc)).isEqualTo("18");
            Map<String, Object> user = jdbc.queryForMap(
                "SELECT id, username, password_hash, email, email_verified_at, auth_version FROM app_user WHERE id=?",
                "legacy-user");
            assertThat(user.get("id")).isEqualTo("legacy-user");
            assertThat(user.get("username")).isEqualTo("legacy-name");
            assertThat(user.get("password_hash")).isEqualTo(LEGACY_HASH);
            assertThat(user.get("email")).isNull();
            assertThat(user.get("email_verified_at")).isNull();
            assertThat(((Number) user.get("auth_version")).longValue()).isZero();
            assertThat(jdbc.queryForObject("SELECT enabled FROM app_user WHERE id=?", Boolean.class, "legacy-user"))
                .isTrue();
            // The pre-migration BCrypt hash still authenticates through the reused password service.
            assertThat(new PasswordService().matches("legacy-password", LEGACY_HASH)).isTrue();
            assertThat(jdbc.queryForObject("SELECT owner_id FROM project WHERE id=?", String.class, "legacy-project"))
                .isEqualTo("legacy-user");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_user", Integer.class)).isEqualTo(1);
        }
    }

    @Test
    void upgradedLegacyAccountLogsInThroughTheRealStoreAndIssuesAVersionZeroToken() {
        try (var db = JdbcStoreTestSupport.createAtVersion("16")) {
            JdbcTemplate jdbc = db.jdbc();
            insertUser(jdbc, "legacy-user", "legacy-name");
            db.migrateToLatest();

            // End-to-end on the upgraded schema: real UserStore + BCrypt + current-version signing.
            JwtService jwt = new JwtService("legacy-login-test-secret-0123456789ab", Duration.ofMinutes(15));
            AuthProperties properties = new AuthProperties(false, "", null, null);
            AuthService service = new AuthService(jdbc, new UserStore(jdbc), new PasswordService(), jwt,
                new AuthChallengeStore(jdbc, properties), properties);
            AuthContracts.LoginResponse response = service.login(
                new AuthContracts.LoginRequest("legacy-name", "legacy-password"));

            JwtService.Claims claims = jwt.parse(response.accessToken());
            assertThat(claims.subject()).isEqualTo("legacy-user");
            assertThat(claims.authVersion()).isZero();
            assertThat(response.user().id()).isEqualTo("legacy-user");
            assertThat(response.user().username()).isEqualTo("legacy-name");
            assertThat(response.user().email()).isNull();
            assertThat(response.user().emailVerified()).isFalse();
        }
    }

    @Test
    void emailColumnIsNullableBinaryAndUniquelyIndexed() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            Map<String, Object> email = jdbc.queryForMap("""
                SELECT COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='app_user' AND COLUMN_NAME='email'
                """);
            assertThat(email.get("COLUMN_TYPE")).isEqualTo("varchar(254)");
            assertThat(email.get("IS_NULLABLE")).isEqualTo("YES");
            assertThat(email.get("COLLATION_NAME")).isEqualTo("utf8mb4_bin");
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='app_user'
                  AND INDEX_NAME='uq_app_user_email' AND NON_UNIQUE=0
                """, Integer.class)).isEqualTo(1);

            // Multiple legacy accounts keep a NULL email (NULL is not a duplicate value).
            insertUser(jdbc, "user-a", "user-a");
            insertUser(jdbc, "user-b", "user-b");
            jdbc.update("UPDATE app_user SET email=? WHERE id=?", "alice@example.com", "user-a");
            assertThatThrownBy(() ->
                jdbc.update("UPDATE app_user SET email=? WHERE id=?", "alice@example.com", "user-b"))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            jdbc.update("UPDATE app_user SET email=?, email_verified_at=? WHERE id=?",
                "bob@example.com", TS, "user-b");
            assertThat(jdbc.queryForObject("SELECT email FROM app_user WHERE id=?", String.class, "user-b"))
                .isEqualTo("bob@example.com");
        }
    }

    @Test
    void authChallengeTableHasOneSendSlotPerPurposeAndEmail() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            insertUser(jdbc, "challenge-user", "challenge-user");
            List<Map<String, Object>> columns = jdbc.queryForList("""
                SELECT COLUMN_NAME, IS_NULLABLE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_challenge'
                ORDER BY ORDINAL_POSITION
                """);
            assertThat(columns).extracting(column -> column.get("COLUMN_NAME")).containsExactly(
                "id", "purpose", "email", "user_id", "auth_version_snapshot", "answer_mac", "state",
                "expires_at", "attempts", "next_send_at", "window_started_at", "window_send_count",
                "created_at", "updated_at");
            assertThat(columns).filteredOn(column -> column.get("IS_NULLABLE").equals("YES"))
                .extracting(column -> column.get("COLUMN_NAME"))
                .containsExactly("email", "user_id", "auth_version_snapshot", "next_send_at", "window_started_at");
            List<Map<String, Object>> uniqueIndex = jdbc.queryForList("""
                SELECT COLUMN_NAME FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_challenge'
                  AND INDEX_NAME='uq_auth_challenge_purpose_email' AND NON_UNIQUE=0
                ORDER BY SEQ_IN_INDEX
                """);
            assertThat(uniqueIndex).extracting(row -> row.get("COLUMN_NAME"))
                .containsExactly("purpose", "email");

            // The send slot is (purpose, email): the same email may hold one register code and
            // one reset code, but never two rows for the same purpose.
            insertChallenge(jdbc, "challenge-1", "REGISTER_EMAIL", "a@example.com", "ACTIVE", null, null);
            assertThatThrownBy(() -> insertChallenge(
                jdbc, "challenge-2", "REGISTER_EMAIL", "a@example.com", "SENDING", null, null))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            // A reset code may bind the real account and (later) its issuing auth_version.
            insertChallenge(jdbc, "challenge-3", "RESET_PASSWORD", "a@example.com", "SENDING", "challenge-user", null);
            // CAPTCHA rows carry no email, so they never collide with each other.
            insertChallenge(jdbc, "challenge-4", "CAPTCHA", null, "ACTIVE", null, null);
            insertChallenge(jdbc, "challenge-5", "CAPTCHA", null, "ACTIVE", null, null);
            // Unknown purposes, states and non-hex answer MACs are refused by the schema.
            assertThatThrownBy(() -> insertChallenge(
                jdbc, "challenge-6", "LOGIN", "b@example.com", "ACTIVE", null, "a".repeat(64)))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            assertThatThrownBy(() -> insertChallenge(
                jdbc, "challenge-7", "REGISTER_EMAIL", "b@example.com", "OPEN", null, "a".repeat(64)))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            assertThatThrownBy(() -> insertChallenge(
                jdbc, "challenge-8", "REGISTER_EMAIL", "c@example.com", "ACTIVE", null, "NOT-A-MAC"))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            // A challenge row may only reference a real account.
            assertThatThrownBy(() -> insertChallenge(
                jdbc, "challenge-9", "RESET_PASSWORD", "d@example.com", "SENDING", "missing-user", "a".repeat(64)))
                .isInstanceOf(DataAccessException.class)
                .hasRootCauseInstanceOf(SQLException.class);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_challenge", Integer.class)).isEqualTo(4);
        }
    }

    @Test
    void legacyTicketsGainNullableVersionColumnsAndNewTicketsCarryAVersion() {
        try (var db = JdbcStoreTestSupport.createAtVersion("16")) {
            JdbcTemplate jdbc = db.jdbc();
            insertUser(jdbc, "ticket-user", "ticket-user");
            insertProject(jdbc, "ticket-project", "ticket-user");
            jdbc.update("""
                INSERT INTO run(id, project_id, requested_revision, state, policy_json, version,
                    created_at, updated_at, fencing_token)
                VALUES (?, ?, 0, 'SUCCEEDED', '{}', 0, ?, ?, 1)
                """, "ticket-run", "ticket-project", TS, TS);
            jdbc.update("""
                INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """, "a".repeat(64), "ticket-user", "ticket-project", "ticket-run", TS);
            jdbc.update("""
                INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at, version)
                VALUES (?, ?, ?, ?, 'EXPIRED', ?, ?, 0)
                """, "ticket-session", "ticket-project", "ticket-run", "ticket-user", "b".repeat(64), TS);

            db.migrateToLatest();

            assertThat(jdbc.queryForObject("SELECT auth_version FROM log_ticket WHERE ticket_hash=?",
                Long.class, "a".repeat(64))).isNull();
            assertThat(jdbc.queryForObject("SELECT auth_version FROM terminal_session WHERE id=?",
                Long.class, "ticket-session")).isNull();
            // New tickets always carry the authenticated version.
            jdbc.update("""
                INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at, auth_version)
                VALUES (?, ?, ?, ?, ?, 0)
                """, "c".repeat(64), "ticket-user", "ticket-project", "ticket-run", TS);
            assertThat(jdbc.queryForObject("SELECT auth_version FROM log_ticket WHERE ticket_hash=?",
                Long.class, "c".repeat(64))).isZero();
        }
    }

    private static String latestVersion(JdbcTemplate jdbc) {
        return jdbc.queryForObject(
            "SELECT version FROM flyway_schema_history WHERE success=1 ORDER BY installed_rank DESC LIMIT 1",
            String.class);
    }

    private static void insertUser(JdbcTemplate jdbc, String id, String username) {
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            id, username, LEGACY_HASH, TS);
    }

    private static void insertProject(JdbcTemplate jdbc, String id, String ownerId) {
        jdbc.update("""
            INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)
            VALUES (?, ?, ?, 'READY', 0, ?, ?)
            """, id, ownerId, id, TS, TS);
    }

    private static void insertChallenge(JdbcTemplate jdbc, String id, String purpose, String email,
                                        String state, String userId, String answerMac) {
        jdbc.update("""
            INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, answer_mac,
                state, expires_at, attempts, next_send_at, window_started_at, window_send_count,
                created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, NULL, 0, ?, ?)
            """, id, purpose, email, userId,
            answerMac == null ? "0".repeat(64) : answerMac, state, TS, TS, TS);
    }
}
