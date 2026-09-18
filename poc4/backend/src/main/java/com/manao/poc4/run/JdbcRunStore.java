package com.manao.poc4.run;

import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.persistence.RunState;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/** JDBC Run store; the generated active_run_marker enforces one active Run per project. */
import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;

@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public final class JdbcRunStore implements RunStore {
    private static final String LEASE_ID = "backend";
    private static final Duration LEASE_TTL = Duration.ofSeconds(60);
    private static final String RUN_COLUMNS = "id, project_id, requested_revision, state, policy_json, job_ref, pod_ref, started_at, finished_at, exit_code, termination_reason, version, created_at, fencing_token";

    private final JdbcTemplate jdbc;
    private final DatabaseClock clock;
    private final TransactionTemplate transaction;

    @org.springframework.beans.factory.annotation.Autowired
    public JdbcRunStore(JdbcTemplate jdbc) {
        this(jdbc, new DatabaseClock());
    }

    public JdbcRunStore(JdbcTemplate jdbc, DatabaseClock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
        DataSource dataSource = jdbc.getDataSource();
        if (dataSource == null) {
            throw new IllegalStateException("JdbcTemplate requires a DataSource");
        }
        this.transaction = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
    }

    @Override public ProjectRecord findProjectForOwner(String ownerId, String projectId) {
        List<ProjectRecord> records = jdbc.query(
            "SELECT id, owner_id, state, workspace_revision FROM project WHERE id = ? AND owner_id = ?",
            (rs, row) -> new ProjectRecord(rs.getString("id"), rs.getString("owner_id"), rs.getString("state"),
                rs.getLong("workspace_revision")),
            projectId, ownerId);
        return records.isEmpty() ? null : records.get(0);
    }

    @Override public ProjectRecord findProject(String projectId) {
        List<ProjectRecord> records = jdbc.query(
            "SELECT id, owner_id, state, workspace_revision FROM project WHERE id = ?",
            (rs, row) -> new ProjectRecord(rs.getString("id"), rs.getString("owner_id"), rs.getString("state"),
                rs.getLong("workspace_revision")),
            projectId);
        return records.isEmpty() ? null : records.get(0);
    }

    @Override public OptionalLong acquireFencingToken() {
        Instant now = clock.now();
        // Upsert the lease: only a holder change (real takeover) bumps the token; the same
        // holder merely extends the expiry so long-lived Runs keep their fence. The token
        // expression must precede the holder_id assignment because MySQL evaluates ON DUPLICATE
        // KEY UPDATE assignments left to right (later expressions see the new value).
        Timestamp expiry = Timestamp.from(now.plus(LEASE_TTL));
        String currentHolder = holder();
        jdbc.update(
            "INSERT INTO instance_lease(id, holder_id, fencing_token, expires_at) VALUES (?, ?, 1, ?) " +
                "ON DUPLICATE KEY UPDATE " +
                "fencing_token = IF(holder_id <> ?, fencing_token + 1, fencing_token), " +
                "holder_id = ?, expires_at = ?",
            LEASE_ID, currentHolder, expiry, currentHolder, currentHolder, expiry);
        List<Long> tokens = jdbc.query(
            "SELECT fencing_token FROM instance_lease WHERE id = ? AND holder_id = ? AND expires_at >= ?",
            (rs, row) -> rs.getLong(1), LEASE_ID, currentHolder, Timestamp.from(now));
        if (tokens.isEmpty()) return OptionalLong.empty();
        long token = tokens.get(0);
        // Takeover restamp: align every active Run row with the current authority token.
        // A same-holder renewal does not change the token, so this UPDATE is an idempotent no-op.
        jdbc.update("UPDATE run SET fencing_token = ? WHERE active_run_marker = 1 AND fencing_token <> ?",
            token, token);
        return OptionalLong.of(token);
    }

    private String holder() {
        return "backend-" + System.getProperty("manao.instance.id", "local");
    }

    @Override public InsertResult insertRun(RunRecord record, long fencingToken) {
        return transaction.execute(status -> {
            List<Object[]> rows = jdbc.query(
                "SELECT state, workspace_revision FROM project WHERE id = ? FOR UPDATE",
                (rs, row) -> new Object[] { rs.getString(1), rs.getLong(2) },
                record.projectId());
            if (rows.isEmpty()) {
                return InsertResult.PROJECT_NOT_FOUND;
            }
            String state = (String) rows.get(0)[0];
            long revision = (Long) rows.get(0)[1];
            if (!"READY".equals(state)) {
                return InsertResult.PROJECT_LOCKED;
            }
            if (revision != record.requestedRevision()) {
                return InsertResult.REVISION_CONFLICT;
            }
            try {
                jdbc.update("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version, created_at, updated_at, fencing_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    record.id(), record.projectId(), record.requestedRevision(), record.state().name(),
                    record.policyJson(), record.version(), Timestamp.from(record.createdAt()),
                    Timestamp.from(record.createdAt()), fencingToken);
                return InsertResult.INSERTED;
            } catch (org.springframework.dao.DuplicateKeyException ex) {
                return InsertResult.ACTIVE_RUN_EXISTS;
            }
        });
    }

    @Override public Optional<RunRecord> findActiveRun(String projectId) {
        return single("SELECT " + RUN_COLUMNS + " FROM run WHERE project_id = ? AND active_run_marker = 1", projectId);
    }

    @Override public Optional<RunRecord> findRun(String runId) {
        return single("SELECT " + RUN_COLUMNS + " FROM run WHERE id = ?", runId);
    }

    @Override public Optional<RunRecord> findRunForOwner(String ownerId, String projectId, String runId) {
        return single("SELECT " + RUN_COLUMNS + " FROM run WHERE run.id = ? AND run.project_id = ? AND EXISTS (SELECT 1 FROM project p WHERE p.id = run.project_id AND p.owner_id = ?)",
            runId, projectId, ownerId);
    }

    @Override public RunPage listForOwner(String ownerId, String projectId, RunCursor cursor, int limit) {
        String sql = "SELECT " + RUN_COLUMNS
            + " FROM run WHERE project_id = ?"
            + " AND EXISTS (SELECT 1 FROM project p WHERE p.id = run.project_id AND p.owner_id = ?)";
        List<Object> args = new java.util.ArrayList<>();
        args.add(projectId);
        args.add(ownerId);
        if (cursor != null) {
            sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
            args.add(Timestamp.from(cursor.createdAt()));
            args.add(Timestamp.from(cursor.createdAt()));
            args.add(cursor.id());
        }
        sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
        args.add(limit + 1);
        List<RunRecord> records = jdbc.query(sql, (rs, row) -> map(rs), args.toArray());
        boolean hasMore = records.size() > limit;
        if (hasMore) {
            records = records.subList(0, limit);
        }
        return new RunPage(records, hasMore);
    }

    @Override public boolean transition(String runId, String projectId, long expectedVersion, RunState next,
                                        long fencingToken, RunState... allowedStates) {
        String placeholders = Arrays.stream(allowedStates).map(s -> "?").collect(Collectors.joining(", "));
        List<Object> args = new java.util.ArrayList<>();
        args.add(next.name());
        args.add(Timestamp.from(clock.now()));
        args.add(runId);
        args.add(projectId);
        args.add(expectedVersion);
        args.add(fencingToken);
        args.addAll(Arrays.asList(allowedStates).stream().map(Enum::name).toList());
        return jdbc.update("UPDATE run SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND project_id = ? AND version = ? AND fencing_token = ? AND state IN ("
            + placeholders + ")", args.toArray()) == 1;
    }

    @Override public boolean markRunning(String runId, String projectId, long expectedVersion) {
        OptionalLong token = renewLease();
        if (token.isEmpty()) return false;
        return jdbc.update("UPDATE run SET state = 'RUNNING', started_at = ?, version = version + 1, updated_at = ? " +
                "WHERE id = ? AND project_id = ? AND version = ? AND state = 'STARTING' AND fencing_token = ?",
            Timestamp.from(clock.now()), Timestamp.from(clock.now()), runId, projectId, expectedVersion,
            token.getAsLong()) == 1;
    }

    @Override public void updateJobFacts(String runId, String jobRef, String podRef) {
        jdbc.update("UPDATE run SET job_ref = ?, pod_ref = ? WHERE id = ?", jobRef, podRef, runId);
    }

    @Override public void updatePodRef(String runId, String podRef) {
        jdbc.update("UPDATE run SET pod_ref = ? WHERE id = ?", podRef, runId);
    }

    @Override public boolean settle(String runId, RunState state, String terminationReason, Integer exitCode) {
        OptionalLong token = renewLease();
        if (token.isEmpty()) return false;
        return jdbc.update("UPDATE run SET state = ?, finished_at = ?, exit_code = ?, termination_reason = ?, " +
                "version = version + 1 WHERE id = ? AND active_run_marker = 1 AND state <> ? AND fencing_token = ?",
            state.name(), Timestamp.from(clock.now()), exitCode, terminationReason, runId, state.name(),
            token.getAsLong()) == 1;
    }

    /**
     * Renews the instance lease for the current holder and returns the authoritative token.
     * The holder identity is the fence: the same holder can always renew (even after its
     * previous expiry lapsed), while a takeover changes the holder and bumps the token.
     */
    private OptionalLong renewLease() {
        int renewed = jdbc.update(
            "UPDATE instance_lease SET expires_at = ? WHERE id = ? AND holder_id = ?",
            Timestamp.from(clock.now().plus(LEASE_TTL)), LEASE_ID, holder());
        if (renewed != 1) return OptionalLong.empty();
        List<Long> tokens = jdbc.query(
            "SELECT fencing_token FROM instance_lease WHERE id = ? AND holder_id = ?",
            (rs, row) -> rs.getLong(1), LEASE_ID, holder());
        return tokens.isEmpty() ? OptionalLong.empty() : OptionalLong.of(tokens.get(0));
    }

    @Override public List<RunRecord> findRunsInState(RunState... states) {
        String placeholders = Arrays.stream(states).map(s -> "?").collect(Collectors.joining(", "));
        Object[] args = Arrays.stream(states).map(Enum::name).toArray();
        return jdbc.query("SELECT " + RUN_COLUMNS + " FROM run WHERE state IN (" + placeholders + ") ORDER BY created_at, id",
            (rs, row) -> map(rs), args);
    }

    private Optional<RunRecord> single(String sql, Object... args) {
        List<RunRecord> records = jdbc.query(sql, (rs, row) -> map(rs), args);
        return records.isEmpty() ? Optional.empty() : Optional.of(records.get(0));
    }

    private static RunRecord map(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp started = rs.getTimestamp("started_at");
        Timestamp finished = rs.getTimestamp("finished_at");
        int exitCode = rs.getInt("exit_code");
        boolean exitCodeNull = rs.wasNull();
        return new RunRecord(rs.getString("id"), rs.getString("project_id"), rs.getLong("requested_revision"),
            RunState.valueOf(rs.getString("state")), rs.getString("policy_json"), rs.getString("job_ref"),
            rs.getString("pod_ref"), started == null ? null : started.toInstant(),
            finished == null ? null : finished.toInstant(), exitCodeNull ? null : exitCode,
            rs.getString("termination_reason"), rs.getLong("version"), rs.getTimestamp("created_at").toInstant(),
            rs.getLong("fencing_token"));
    }
}
