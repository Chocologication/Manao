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
@Component
@ConditionalOnBean(JdbcTemplate.class)
public final class JdbcTerminalStore implements TerminalStore {
    private static final String COLUMNS = "id, project_id, run_id, user_id, ticket_hash, expires_at, consumed_at, state, pod_ref, container_ref, close_reason";

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public JdbcTerminalStore(JdbcTemplate jdbc) {
        this(jdbc, Clock.systemUTC());
    }

    JdbcTerminalStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override public boolean insertReservation(ReservationRecord record) {
        try {
            jdbc.update("INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)",
                record.sessionId(), record.projectId(), record.runId(), record.userId(), record.ticketHash(),
                Timestamp.from(record.expiresAt()));
            return true;
        } catch (org.springframework.dao.DuplicateKeyException ex) {
            return false;
        }
    }

    @Override public Optional<SessionRecord> consumeReservation(String ticketHash) {
        int consumed = jdbc.update(
            "UPDATE terminal_session SET state = 'LIVE', consumed_at = ? WHERE ticket_hash = ? AND state = 'RESERVED' AND expires_at > ? AND consumed_at IS NULL",
            Timestamp.from(clock.instant()), ticketHash, Timestamp.from(clock.instant()));
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

    private static SessionRecord map(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp consumed = rs.getTimestamp("consumed_at");
        return new SessionRecord(rs.getString("id"), rs.getString("project_id"), rs.getString("run_id"),
            rs.getString("user_id"), rs.getString("ticket_hash"), rs.getTimestamp("expires_at").toInstant(),
            consumed == null ? null : consumed.toInstant(), rs.getString("state"), rs.getString("pod_ref"),
            rs.getString("container_ref"), rs.getString("close_reason"));
    }
}
