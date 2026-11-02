package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.Timestamp;
import java.time.Instant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * Account lookups and the per-request current-account check. The database is the only
 * authority for {@link UserStore#isCurrent}: a failed lookup denies instead of trusting the
 * JWT alone.
 */
class UserStoreTest {
    private static final Instant NOW = Instant.parse("2026-03-04T05:06:07Z");
    private static final Timestamp TS = Timestamp.from(NOW);

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private UserStore users;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        users = new UserStore(jdbc);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void findsAccountsByIdUsernameAndVerifiedEmail() {
        insertUser("user-a", "alice", "hash-a", true, "alice@example.com", TS, 3);
        insertUser("user-b", "bob", "hash-b", true, null, null, 0);
        insertUser("user-c", "carol", "hash-c", true, "carol@example.com", null, 0);

        UserStore.UserAccount byId = users.findById("user-a").orElseThrow();
        assertThat(byId.id()).isEqualTo("user-a");
        assertThat(byId.username()).isEqualTo("alice");
        assertThat(byId.passwordHash()).isEqualTo("hash-a");
        assertThat(byId.enabled()).isTrue();
        assertThat(byId.email()).isEqualTo("alice@example.com");
        assertThat(byId.emailVerifiedAt()).isEqualTo(NOW);
        assertThat(byId.authVersion()).isEqualTo(3);

        assertThat(users.findById("missing")).isEmpty();
        assertThat(users.findById(null)).isEmpty();
        assertThat(users.findById("  ")).isEmpty();
        assertThat(users.findByUsername("alice")).get().extracting(UserStore.UserAccount::id).isEqualTo("user-a");
        assertThat(users.findByUsername("missing")).isEmpty();
        assertThat(users.findByUsername(null)).isEmpty();

        // Only a bound AND verified address is a recovery candidate; a legacy NULL email can
        // never be used for recovery and an unverified address is not yet an identity.
        assertThat(users.findVerifiedByEmail("alice@example.com")).get()
            .extracting(UserStore.UserAccount::id).isEqualTo("user-a");
        assertThat(users.findVerifiedByEmail("carol@example.com")).isEmpty();
        assertThat(users.findVerifiedByEmail("bob@example.com")).isEmpty();
        assertThat(users.findVerifiedByEmail(null)).isEmpty();
        // Storage uses utf8mb4_bin: callers pass the normalized (trimmed, lower-case) address.
        assertThat(users.findVerifiedByEmail("ALICE@EXAMPLE.COM")).isEmpty();
    }

    @Test
    void isCurrentRequiresAnEnabledAccountAtTheSameVersion() {
        insertUser("user-a", "alice", "hash-a", true, null, null, 3);
        insertUser("user-disabled", "disabled", "hash-d", false, null, null, 0);

        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 3))).isTrue();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 2))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 4))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-disabled", 0))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("missing", 0))).isFalse();
        assertThat(users.isCurrent(null)).isFalse();

        // A password change bumps auth_version; the previous token version stops being current.
        jdbc.update("UPDATE app_user SET auth_version=4 WHERE id=?", "user-a");
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 3))).isFalse();
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 4))).isTrue();

        jdbc.update("UPDATE app_user SET enabled=FALSE WHERE id=?", "user-a");
        assertThat(users.isCurrent(new AuthContracts.AccountIdentity("user-a", 4))).isFalse();
    }

    @Test
    void databaseFailureDeniesTheCurrentCheck() {
        JdbcTemplate broken = new JdbcTemplate(new DriverManagerDataSource("jdbc:invalid:test"));
        UserStore denied = new UserStore(broken);

        assertThat(denied.isCurrent(new AuthContracts.AccountIdentity("user-a", 0))).isFalse();
        // Read lookups surface the failure to the caller; only the per-request authorization
        // decision is fail-closed by returning false.
        assertThatThrownBy(() -> denied.findById("user-a")).isInstanceOf(DataAccessException.class);
    }

    private void insertUser(String id, String username, String passwordHash, boolean enabled,
                            String email, Timestamp emailVerifiedAt, long authVersion) {
        jdbc.update("""
            INSERT INTO app_user(id, username, password_hash, enabled, email, email_verified_at,
                auth_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, id, username, passwordHash, enabled, email, emailVerifiedAt, authVersion, TS);
    }
}
