package com.manao.poc4.auth;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * JDBC-backed account state for HTTP authentication and the account lifecycle tasks.
 * Read methods surface database failures; {@link #isCurrent(com.manao.poc4.auth.AuthContracts.AccountIdentity)}
 * is the per-request authorization decision and fails closed (denies) when the lookup fails, so
 * a token is never accepted without a successful database check.
 */
public final class UserStore {
    private static final String ACCOUNT_COLUMNS =
        "id, username, password_hash, enabled, email, email_verified_at, auth_version";

    private final JdbcTemplate jdbc;

    public UserStore(JdbcTemplate jdbc) {
        if (jdbc == null) throw new IllegalArgumentException("jdbc template required");
        this.jdbc = jdbc;
    }

    public Optional<UserAccount> findById(String userId) {
        if (userId == null || userId.isBlank()) return Optional.empty();
        return findOne("SELECT " + ACCOUNT_COLUMNS + " FROM app_user WHERE id = ?", userId);
    }

    public Optional<UserAccount> findByUsername(String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        return findOne("SELECT " + ACCOUNT_COLUMNS + " FROM app_user WHERE username = ?", username);
    }

    /**
     * Looks up a bound AND verified email address. A legacy NULL email (or an address that was
     * never verified) is never a recovery candidate. The caller supplies the normalized
     * (trimmed, lower-case) address; the column uses utf8mb4_bin for exact comparison.
     */
    public Optional<UserAccount> findVerifiedByEmail(String email) {
        if (email == null || email.isBlank()) return Optional.empty();
        return findOne("SELECT " + ACCOUNT_COLUMNS
            + " FROM app_user WHERE email = ? AND email_verified_at IS NOT NULL", email);
    }

    /**
     * True only while the account exists, is enabled and still has the token's auth_version.
     * Any database failure returns false: authorization never falls back to the JWT alone.
     */
    public boolean isCurrent(AuthContracts.AccountIdentity identity) {
        if (identity == null || identity.userId().isBlank()) return false;
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT enabled, auth_version FROM app_user WHERE id = ?", identity.userId());
            if (rows.size() != 1) return false;
            Map<String, Object> row = rows.get(0);
            if (!isEnabled(row.get("enabled"))) return false;
            Object version = row.get("auth_version");
            return version instanceof Number number && number.longValue() == identity.authVersion();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private Optional<UserAccount> findOne(String sql, Object argument) {
        List<UserAccount> accounts = jdbc.query(sql, (rows, rowNumber) -> new UserAccount(
            rows.getString("id"),
            rows.getString("username"),
            rows.getString("password_hash"),
            rows.getBoolean("enabled"),
            rows.getString("email"),
            verifiedAt(rows.getTimestamp("email_verified_at")),
            rows.getLong("auth_version")), argument);
        return accounts.isEmpty() ? Optional.empty() : Optional.of(accounts.get(0));
    }

    private static Instant verifiedAt(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static boolean isEnabled(Object value) {
        return (value instanceof Boolean flag && flag)
            || (value instanceof Number number && number.longValue() != 0);
    }

    /**
     * Account row for authentication and lifecycle use. It is deliberately not a response
     * contract: the hash is ignored by Jackson so an accidental serialization cannot leak it.
     */
    public record UserAccount(String id, String username, @JsonIgnore String passwordHash,
                              boolean enabled, String email, Instant emailVerifiedAt,
                              long authVersion) {
    }
}
