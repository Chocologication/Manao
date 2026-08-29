package com.manao.poc4.audit;

import com.manao.poc4.terminal.TerminalStore;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** JDBC persistence for terminal audits, retention cleanup and the RESERVED -> EXPIRED scan. */
@Component
@ConditionalOnBean(JdbcTemplate.class)
public final class JdbcAuditStore implements AuditStore, RetentionCleanupJob.CleanupStore {
    private static final String COLUMNS = "id, session_id, project_id, run_id, user_id, command, state, started_at, finished_at, exit_code, sensitive_detected";

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public JdbcAuditStore(JdbcTemplate jdbc) {
        this(jdbc, Clock.systemUTC());
    }

    JdbcAuditStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override public String insertRunning(String sessionId, String projectId, String runId, String userId, long seq,
                                          String command, boolean sensitiveDetected, String trustLevel, Instant startedAt) {
        String id = java.util.UUID.randomUUID().toString();
        jdbc.update("INSERT INTO terminal_audit(id, session_id, project_id, run_id, user_id, command, state, started_at, sensitive_detected, trust_level) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)",
            id, sessionId, projectId, runId, userId, command, Timestamp.from(startedAt), sensitiveDetected, trustLevel);
        return id;
    }

    @Override public boolean settle(String auditId, String state, Integer exitCode, Instant finishedAt) {
        return jdbc.update("UPDATE terminal_audit SET state = ?, finished_at = ?, exit_code = ? WHERE id = ? AND state = 'RUNNING'",
            state, Timestamp.from(finishedAt), exitCode, auditId) == 1;
    }

    @Override public List<AuditRecord> list(String runId, int limit) {
        return jdbc.query("SELECT " + COLUMNS + " FROM terminal_audit WHERE run_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
            (rs, row) -> map(rs), runId, limit);
    }

    @Override public List<AuditRecord> listBefore(String runId, Instant startedAt, String idExclusive, int limit) {
        return jdbc.query("SELECT " + COLUMNS + " FROM terminal_audit WHERE run_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?",
            (rs, row) -> map(rs), runId, Timestamp.from(startedAt), Timestamp.from(startedAt), idExclusive, limit);
    }

    @Override public int deleteExpiredBefore(Instant cutoff) {
        return jdbc.update("DELETE FROM terminal_audit WHERE started_at < ?", Timestamp.from(cutoff));
    }

    @Override public int deleteTerminalAuditsBefore(Instant cutoff) {
        return jdbc.update("DELETE FROM terminal_audit WHERE started_at < ?", Timestamp.from(cutoff));
    }

    @Override public int deleteLogChunksBefore(Instant cutoff) {
        return jdbc.update("DELETE FROM run_log_chunk WHERE created_at < ?", Timestamp.from(cutoff));
    }

    @Override public int deleteLogTicketsBefore(Instant cutoff) {
        return jdbc.update("DELETE FROM log_ticket WHERE expires_at < ?", Timestamp.from(cutoff));
    }

    @Override public Map<String, Instant> reservedReservations() {
        Map<String, Instant> reservations = new HashMap<>();
        jdbc.query("SELECT id, expires_at FROM terminal_session WHERE state = 'RESERVED'",
            (rs, row) -> reservations.put(rs.getString("id"), rs.getTimestamp("expires_at").toInstant()));
        return reservations;
    }

    @Override public int expireReservation(String sessionId) {
        return jdbc.update("UPDATE terminal_session SET state = 'EXPIRED', version = version + 1 WHERE id = ? AND state = 'RESERVED' AND expires_at <= ?",
            sessionId, Timestamp.from(clock.instant()));
    }

    private static AuditRecord map(ResultSet rs) throws SQLException {
        Timestamp finished = rs.getTimestamp("finished_at");
        int exitCode = rs.getInt("exit_code");
        boolean exitNull = rs.wasNull();
        return new AuditRecord(rs.getString("id"), rs.getString("session_id"), 0, rs.getString("command"),
            rs.getString("state"), rs.getTimestamp("started_at").toInstant(),
            finished == null ? null : finished.toInstant(), exitNull ? null : exitCode,
            rs.getBoolean("sensitive_detected"));
    }
}
