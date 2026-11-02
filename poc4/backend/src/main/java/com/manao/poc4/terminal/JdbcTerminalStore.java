package com.manao.poc4.terminal;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** JDBC terminal store; the generated active_terminal_marker enforces one live session per run. */
import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;

@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public final class JdbcTerminalStore implements TerminalStore {
    private static final String COLUMNS = "id, project_id, run_id, user_id, auth_version, ticket_hash, expires_at, consumed_at, state, pod_ref, container_ref, close_reason, cols, `rows`";

    private final JdbcTemplate jdbc;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public JdbcTerminalStore(JdbcTemplate jdbc) {
        this(jdbc, Clock.systemUTC());
    }

    JdbcTerminalStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override public InsertResult insertReservation(ReservationRecord record) {
        // Pre-V17 RESERVED rows carry a NULL version and can never be consumed; release the
        // unique run slot into the existing legal EXPIRED state instead of deleting history.
        expireLegacyReservations(record.runId());
        try {
            int inserted = jdbc.update("INSERT INTO terminal_session(id, project_id, run_id, user_id, "
                    + "auth_version, state, ticket_hash, expires_at, cols, `rows`) "
                    + "SELECT ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ? FROM app_user u "
                    + "WHERE u.id = ? AND u.enabled = TRUE AND u.auth_version = ?",
                record.sessionId(), record.projectId(), record.runId(), record.userId(),
                record.authVersion(), record.ticketHash(), Timestamp.from(record.expiresAt()),
                record.cols(), record.rows(), record.userId(), record.authVersion());
            return inserted == 1 ? InsertResult.INSERTED : InsertResult.STALE_CREDENTIALS;
        } catch (org.springframework.dao.DuplicateKeyException ex) {
            return InsertResult.ACTIVE_SESSION_EXISTS;
        }
    }

    @Override public Optional<SessionRecord> consumeReservation(String ticketHash) {
        Instant now = clock.instant();
        // Atomic consume JOIN: RESERVED + unexpired + hydrated account + ticket version = current.
        // A NULL pre-V17 auth_version never satisfies the join and is refused, never upgraded.
        int consumed = jdbc.update(
            "UPDATE terminal_session t JOIN app_user u ON u.id = t.user_id "
                + "SET t.state = 'LIVE', t.consumed_at = ? "
                + "WHERE t.ticket_hash = ? AND t.state = 'RESERVED' AND t.expires_at > ? "
                + "AND t.consumed_at IS NULL AND u.enabled = TRUE "
                + "AND t.auth_version IS NOT NULL AND t.auth_version = u.auth_version",
            Timestamp.from(now), ticketHash, Timestamp.from(now));
        if (consumed != 1) return Optional.empty();
        List<SessionRecord> records = jdbc.query("SELECT " + COLUMNS + " FROM terminal_session WHERE ticket_hash = ?",
            (rs, row) -> map(rs), ticketHash);
        return records.isEmpty() ? Optional.empty() : Optional.of(records.get(0));
    }

    @Override public Optional<SessionRecord> findSession(String sessionId) {
        List<SessionRecord> records = jdbc.query("SELECT " + COLUMNS + " FROM terminal_session WHERE id = ?",
            (rs, row) -> map(rs), sessionId);
        return records.isEmpty() ? Optional.empty() : Optional.of(records.get(0));
    }

    @Override public boolean settle(String sessionId, String state, String closeReason, Integer exitCode) {
        return jdbc.update("UPDATE terminal_session SET state = ?, close_reason = ?, finished_at = ?, exit_code = ?, version = version + 1 WHERE id = ? AND state = 'LIVE'",
            state, closeReason, Timestamp.from(clock.instant()), exitCode, sessionId) == 1;
    }

    @Override public void updateLiveRefs(String sessionId, String podRef, String containerRef) {
        jdbc.update("UPDATE terminal_session SET pod_ref = ?, container_ref = ? WHERE id = ? AND state = 'LIVE'",
            podRef, containerRef, sessionId);
    }

    @Override public int expireLegacyReservations(String runId) {
        return jdbc.update("UPDATE terminal_session SET state = 'EXPIRED', "
                + "close_reason = 'LEGACY_TICKET_INVALID', finished_at = ?, version = version + 1 "
                + "WHERE run_id = ? AND state = 'RESERVED' AND auth_version IS NULL",
            Timestamp.from(clock.instant()), runId);
    }

    private static SessionRecord map(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp consumed = rs.getTimestamp("consumed_at");
        return new SessionRecord(rs.getString("id"), rs.getString("project_id"), rs.getString("run_id"),
            rs.getString("user_id"), rs.getLong("auth_version"), rs.getString("ticket_hash"),
            rs.getTimestamp("expires_at").toInstant(), consumed == null ? null : consumed.toInstant(),
            rs.getString("state"), rs.getString("pod_ref"), rs.getString("container_ref"),
            rs.getString("close_reason"), rs.getInt("cols"), rs.getInt("rows"));
    }
}
