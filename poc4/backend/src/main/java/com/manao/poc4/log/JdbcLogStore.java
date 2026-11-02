package com.manao.poc4.log;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** JDBC persistence for single-use log tickets and the retention window's chunks. */
import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;

@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public final class JdbcLogStore implements LogTicketService.Store, RunLogService.ChunkStore {
    private final JdbcTemplate jdbc;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public JdbcLogStore(JdbcTemplate jdbc) {
        this(jdbc, Clock.systemUTC());
    }

    JdbcLogStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override public boolean insert(LogTicketService.TicketRecord record) {
        // Conditional INSERT: the ticket carries the request's auth_version only while the account
        // is still enabled at that version (design 8.1); no unconditional write can upgrade it.
        int inserted = jdbc.update("INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, "
                + "expires_at, auth_version) SELECT ?, ?, ?, ?, ?, ? FROM app_user u "
                + "WHERE u.id = ? AND u.enabled = TRUE AND u.auth_version = ?",
            record.ticketHash(), record.userId(), record.projectId(), record.runId(),
            Timestamp.from(record.expiresAt()), record.authVersion(), record.userId(), record.authVersion());
        return inserted == 1;
    }

    @Override public Optional<LogTicketService.TicketRecord> consumeByHash(String ticketHash) {
        Instant now = clock.instant();
        // Atomic consume JOIN: hash + unconsumed + unexpired + enabled + ticket version = current
        // user version. A pre-V17 NULL auth_version can never satisfy the join.
        int consumed = jdbc.update(
            "UPDATE log_ticket t JOIN app_user u ON u.id = t.user_id SET t.consumed_at = ? "
                + "WHERE t.ticket_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ? "
                + "AND u.enabled = TRUE AND t.auth_version IS NOT NULL AND t.auth_version = u.auth_version",
            Timestamp.from(now), ticketHash, Timestamp.from(now));
        if (consumed != 1) return Optional.empty();
        List<LogTicketService.TicketRecord> records = jdbc.query(
            "SELECT ticket_hash, user_id, auth_version, project_id, run_id, expires_at, consumed_at "
                + "FROM log_ticket WHERE ticket_hash = ?",
            (rs, row) -> new LogTicketService.TicketRecord(rs.getString("ticket_hash"), rs.getString("user_id"),
                rs.getLong("auth_version"), rs.getString("project_id"), rs.getString("run_id"),
                rs.getTimestamp("expires_at").toInstant(), rs.getTimestamp("consumed_at").toInstant()),
            ticketHash);
        return records.isEmpty() ? Optional.empty() : Optional.of(records.get(0));
    }

    @Override public void insertChunk(String runId, RunLogWindow.Chunk chunk) {
        jdbc.update("INSERT INTO run_log_chunk(run_id, seq, text_utf8, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
            runId, chunk.seq(), chunk.text(), chunk.byteLength(), Timestamp.from(chunk.persistedAt()));
    }

    @Override public List<RunLogWindow.Chunk> loadChunks(String runId) {
        return jdbc.query("SELECT seq, text_utf8, byte_length, created_at FROM run_log_chunk WHERE run_id = ? ORDER BY seq",
            (rs, row) -> new RunLogWindow.Chunk(rs.getLong("seq"), rs.getString("text_utf8"), rs.getInt("byte_length"),
                rs.getTimestamp("created_at").toInstant()),
            runId);
    }

    @Override public void deleteBefore(String runId, long seqExclusive) {
        jdbc.update("DELETE FROM run_log_chunk WHERE run_id = ? AND seq < ?", runId, seqExclusive);
    }

    @Override public java.util.OptionalLong lastSeq(String runId) {
        List<Long> values = jdbc.query("SELECT MAX(seq) FROM run_log_chunk WHERE run_id = ?",
            (rs, row) -> rs.getLong(1), runId);
        long max = values.isEmpty() || values.get(0) == null ? 0 : values.get(0);
        return max == 0 ? java.util.OptionalLong.empty() : java.util.OptionalLong.of(max);
    }
}
