package com.manao.poc4.share;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Independent snapshot persistence. Source project/run identifiers deliberately have no FK. */
public final class JdbcRunShareStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public JdbcRunShareStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(
            new DataSourceTransactionManager(Objects.requireNonNull(jdbc.getDataSource())));
    }

    public record NewShare(String id, String ownerId, String sourceProjectId, String sourceRunId,
        String sourceProjectName, String token, String title, String description,
        String runSnapshotJson, String logText, String requestId, String requestDigest) {}

    public record StoredShare(String id, String ownerId, String sourceProjectId, String sourceRunId,
        String sourceProjectName, String token, String title, String description,
        String runSnapshotJson, String logText, Instant createdAt, Instant expiresAt,
        Instant revokedAt, String requestId, String requestDigest) {}

    public void insert(NewShare share) {
        transaction.executeWithoutResult(status -> {
            LocalDateTime createdAt = jdbc.queryForObject("SELECT UTC_TIMESTAMP(6)", LocalDateTime.class);
            jdbc.update("INSERT INTO run_share(id,owner_id,source_project_id,source_run_id,source_project_name,"
                    + "token,title,description,run_snapshot_json,log_text,created_at,expires_at,request_id,request_digest) "
                    + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                share.id(), share.ownerId(), share.sourceProjectId(), share.sourceRunId(),
                share.sourceProjectName(), share.token(), share.title(), share.description(),
                share.runSnapshotJson(), share.logText(), createdAt, createdAt.plusHours(72),
                share.requestId(), share.requestDigest());
        });
    }

    /** Retained request receipts remain readable after source deletion or content reclamation. */
    public Optional<StoredShare> findByRequest(String ownerId, String requestId) {
        var rows = jdbc.query("SELECT id,owner_id,source_project_id,source_run_id,source_project_name,"
                + "token,title,description,run_snapshot_json,log_text,created_at,expires_at,revoked_at,"
                + "request_id,request_digest FROM run_share WHERE owner_id=? AND request_id=?",
            (rs, row) -> new StoredShare(rs.getString("id"), rs.getString("owner_id"),
                rs.getString("source_project_id"), rs.getString("source_run_id"),
                rs.getString("source_project_name"), rs.getString("token"), rs.getString("title"),
                rs.getString("description"), rs.getString("run_snapshot_json"), rs.getString("log_text"),
                utcInstant(rs, "created_at"), utcInstant(rs, "expires_at"), utcInstant(rs, "revoked_at"),
                rs.getString("request_id"), rs.getString("request_digest")),
            ownerId, requestId);
        return rows.stream().findFirst();
    }

    private static Instant utcInstant(ResultSet rs, String column) throws SQLException {
        LocalDateTime value = rs.getObject(column, LocalDateTime.class);
        return value == null ? null : value.toInstant(ZoneOffset.UTC);
    }
}
