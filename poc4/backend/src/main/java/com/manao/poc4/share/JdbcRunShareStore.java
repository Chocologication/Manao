package com.manao.poc4.share;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Independent snapshot persistence. Source project/run identifiers deliberately have no FK. */
public final class JdbcRunShareStore {
    private static final String RECEIPT_SELECT = "SELECT id,title,source_project_name,token,created_at,expires_at,"
        + "request_digest,CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' "
        + "WHEN expires_at<=UTC_TIMESTAMP(6) THEN 'EXPIRED' ELSE 'ACTIVE' END AS status FROM run_share ";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public JdbcRunShareStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(
            new DataSourceTransactionManager(Objects.requireNonNull(jdbc.getDataSource())));
        this.transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
    }

    public record NewShare(String id, String ownerId, String sourceProjectId, String sourceRunId,
        String sourceProjectName, String token, String title, String description,
        String runSnapshotJson, String logText, String requestId, String requestDigest) {}

    public record StoredShare(String id, String ownerId, String sourceProjectId, String sourceRunId,
        String sourceProjectName, String token, String title, String description,
        String runSnapshotJson, String logText, Instant createdAt, Instant expiresAt,
        Instant revokedAt, String requestId, String requestDigest) {}

    record LockedProject(String id, String name, String state) {}

    /** Small durable receipt: source rows and reclaimed snapshot bodies are never needed for retries. */
    public record ShareReceipt(String id, String title, String sourceProjectName, String token,
        Instant createdAt, Instant expiresAt, String status, String requestDigest) {}

    public <T> T inProjectTransaction(String ownerId, String projectId,
                                     Function<Optional<LockedProject>, T> action) {
        return transaction.execute(status -> {
            var projects = jdbc.query("SELECT id,name,state FROM project WHERE id=? AND owner_id=? FOR UPDATE",
                (rs, row) -> new LockedProject(rs.getString("id"), rs.getString("name"), rs.getString("state")),
                projectId, ownerId);
            // A retry must check its receipt even when deletion already removed the source project.
            return action.apply(projects.stream().findFirst());
        });
    }

    public Optional<ShareReceipt> findReceiptByRequest(String ownerId, String requestId) {
        return jdbc.query(RECEIPT_SELECT + "WHERE owner_id=? AND request_id=?",
            (rs, row) -> receipt(rs), ownerId, requestId).stream().findFirst();
    }

    public Optional<ShareReceipt> findActive(String ownerId, String runId) {
        return jdbc.query(RECEIPT_SELECT + "WHERE owner_id=? AND source_run_id=? "
                + "AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(6) LIMIT 1",
            (rs, row) -> receipt(rs), ownerId, runId).stream().findFirst();
    }

    private static ShareReceipt receipt(ResultSet rs) throws SQLException {
        return new ShareReceipt(rs.getString("id"), rs.getString("title"), rs.getString("source_project_name"),
            rs.getString("token"), utcInstant(rs, "created_at"), utcInstant(rs, "expires_at"),
            rs.getString("status"), rs.getString("request_digest"));
    }

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
