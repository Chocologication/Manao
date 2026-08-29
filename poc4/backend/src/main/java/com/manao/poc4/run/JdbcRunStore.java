package com.manao.poc4.run;

import com.manao.poc4.persistence.RunState;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.stream.Collectors;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** JDBC Run store; the generated active_run_marker enforces one active Run per project. */
@Component
@ConditionalOnBean(JdbcTemplate.class)
public final class JdbcRunStore implements RunStore {
    private static final String LEASE_ID = "backend";
    private static final Duration LEASE_TTL = Duration.ofSeconds(60);
    private static final String RUN_COLUMNS = "id, project_id, requested_revision, state, policy_json, job_ref, pod_ref, started_at, finished_at, exit_code, termination_reason, version, created_at";

    private final JdbcTemplate jdbc;

    public JdbcRunStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override public ProjectRecord findProjectForOwner(String ownerId, String projectId) {
        List<ProjectRecord> records = jdbc.query(
            "SELECT id, owner_id, state, workspace_revision FROM project WHERE id = ? AND owner_id = ?",
            (rs, row) -> new ProjectRecord(rs.getString("id"), rs.getString("owner_id"), rs.getString("state"),
                rs.getLong("workspace_revision")),
            projectId, ownerId);
        return records.isEmpty() ? null : records.get(0);
    }

    @Override public OptionalLong acquireFencingToken() {
        Instant now = Instant.now();
        int renewed = jdbc.update(
            "UPDATE instance_lease SET holder_id = ?, fencing_token = fencing_token + 1, expires_at = ? WHERE id = ? AND expires_at < ?",
            holder(), Timestamp.from(now.plus(LEASE_TTL)), LEASE_ID, Timestamp.from(now));
        if (renewed == 0) {
            jdbc.update("INSERT IGNORE INTO instance_lease(id, holder_id, fencing_token, expires_at) VALUES (?, ?, 1, ?)",
                LEASE_ID, holder(), Timestamp.from(now.plus(LEASE_TTL)));
            jdbc.update(
                "UPDATE instance_lease SET holder_id = ?, fencing_token = fencing_token + 1, expires_at = ? WHERE id = ? AND expires_at < ?",
                holder(), Timestamp.from(now.plus(LEASE_TTL)), LEASE_ID, Timestamp.from(now));
        }
        List<Long> tokens = jdbc.query(
            "SELECT fencing_token FROM instance_lease WHERE id = ? AND holder_id = ? AND expires_at >= ?",
            (rs, row) -> rs.getLong(1), LEASE_ID, holder(), Timestamp.from(now));
        return tokens.isEmpty() ? OptionalLong.empty() : OptionalLong.of(tokens.get(0));
    }

    private String holder() {
        return "backend-" + System.getProperty("manao.instance.id", "local");
    }

    @Override public InsertResult insertRun(RunRecord record) {
        try {
            jdbc.update("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                record.id(), record.projectId(), record.requestedRevision(), record.state().name(),
                record.policyJson(), record.version(), Timestamp.from(record.createdAt()));
            return InsertResult.INSERTED;
        } catch (org.springframework.dao.DuplicateKeyException ex) {
            return InsertResult.ACTIVE_RUN_EXISTS;
        }
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

    @Override public List<RunRecord> listForOwner(String ownerId, String projectId, int limit) {
        return jdbc.query("SELECT " + RUN_COLUMNS + " FROM run WHERE project_id = ? AND EXISTS (SELECT 1 FROM project p WHERE p.id = run.project_id AND p.owner_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?",
            (rs, row) -> map(rs), projectId, ownerId, limit);
    }

    @Override public boolean transition(String runId, String projectId, long expectedVersion, RunState next,
                                        RunState... allowedStates) {
        String placeholders = Arrays.stream(allowedStates).map(s -> "?").collect(Collectors.joining(", "));
        List<Object> args = new java.util.ArrayList<>();
        args.add(next.name());
        args.add(Timestamp.from(Instant.now()));
        args.add(runId);
        args.add(projectId);
        args.add(expectedVersion);
        args.addAll(Arrays.asList(allowedStates).stream().map(Enum::name).toList());
        return jdbc.update("UPDATE run SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND project_id = ? AND version = ? AND state IN ("
            + placeholders + ")", args.toArray()) == 1;
    }

    @Override public void updateJobFacts(String runId, String jobRef) {
        jdbc.update("UPDATE run SET job_ref = ? WHERE id = ?", jobRef, runId);
    }

    @Override public boolean settle(String runId, RunState state, String terminationReason, Integer exitCode) {
        return jdbc.update("UPDATE run SET state = ?, finished_at = ?, exit_code = ?, termination_reason = ?, version = version + 1 WHERE id = ? AND active_run_marker = 1",
            state.name(), Timestamp.from(Instant.now()), exitCode, terminationReason, runId) == 1;
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
            rs.getString("termination_reason"), rs.getLong("version"), rs.getTimestamp("created_at").toInstant());
    }
}
