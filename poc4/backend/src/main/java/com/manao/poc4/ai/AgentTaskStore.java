package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.AgentTaskOccupancy;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Persistent agent task ownership (stage one, design section 3): the browser's pre-generated
 * taskId becomes a durable {@code agent_task} row whose generated {@code active_project}
 * column, backed by a unique index, lets exactly one task own a project's writes. Creation
 * locks the project row {@code FOR UPDATE} inside one transaction and re-checks the whole
 * preflight there — owner, READY, expected revision, no active run, no pending workspace
 * operation, no occupying task — so a submission can never slip past a concurrent writer or
 * deletion. Same id + same request (fixed-field-order UTF-8 SHA-256) idempotently answers the
 * original task; same id + different request is a conflict. The caller MUST hold the shared
 * {@link com.manao.poc4.project.ProjectLifecycleGate} around {@link #create} and treat
 * {@link #requireBrowserWritable} as part of its gate critical section; the store itself only
 * guarantees the durable half of that contract.
 */
public final class AgentTaskStore implements AgentTaskOccupancy {
    /** Canonical UUID form: the browser generates the id before the first submission. */
    private static final Pattern TASK_ID = Pattern.compile(
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    static final int MIN_PROMPT_CHARS = 1;
    static final int MAX_PROMPT_CHARS = 8000;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> OCCUPYING_STATES = List.of("QUEUED", "RUNNING", "NEEDS_ATTENTION");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Clock clock;

    public AgentTaskStore(JdbcTemplate jdbc, PlatformTransactionManager transactions, Clock clock) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactions);
        this.clock = clock;
    }

    @Override public void requireBrowserWritable(String projectId) {
        if (hasActiveTask(projectId)) {
            throw new ApiException("AI_TASK_ACTIVE", 409, "An AI task owns this project's writes");
        }
    }

    /** A tool call may only register against an occupying task of exactly this project. */
    public void requireTaskWritable(String taskId, String projectId) {
        List<String> states = jdbc.query(
            "SELECT state FROM agent_task WHERE id = ? AND project_id = ?",
            (rs, row) -> rs.getString(1), taskId, projectId);
        if (states.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        if (!OCCUPYING_STATES.contains(states.get(0))) {
            throw new ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
        }
    }

    /**
     * Registers the task for the authenticated owner's project and returns its snapshot. The
     * whole decision runs inside one transaction holding the project row lock.
     */
    public AgentContracts.TaskSnapshot create(String ownerId, String projectId,
                                              AgentContracts.TaskRequest request) {
        validate(request);
        String requestSha256 = requestSha256(ownerId, projectId, request);
        Timestamp now = Timestamp.from(clock.instant());
        return requireSnapshot(transaction.execute(status -> {
            List<ProjectRow> projects = jdbc.query(
                "SELECT owner_id, state, workspace_revision FROM project WHERE id = ? FOR UPDATE",
                (rs, row) -> new ProjectRow(rs.getString(1), rs.getString(2), rs.getLong(3)), projectId);
            if (projects.isEmpty()) {
                throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
            }
            // A registered id always answers first: the digest decides whether this is the
            // same request (idempotent original) or a foreign reuse of the id.
            Optional<TaskRow> existing = findTaskById(request.taskId());
            if (existing.isPresent()) {
                if (!requestSha256.equals(existing.get().requestSha256())) {
                    throw new ApiException("AI_TASK_MISMATCH", 409,
                        "This task id was already used for a different request");
                }
                return snapshot(existing.get());
            }
            ProjectRow project = projects.get(0);
            if (!ownerId.equals(project.ownerId())) {
                throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
            }
            if (!"READY".equals(project.state())) {
                throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
            }
            if (project.workspaceRevision() != request.expectedRevision()) {
                throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409,
                    "The workspace changed; reload and retry.");
            }
            if (hasActiveRun(projectId)) {
                throw new ApiException("RUN_ALREADY_ACTIVE", 409, "A run is already active");
            }
            if (hasPendingOperation(projectId)) {
                throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
            }
            if (hasActiveTask(projectId)) {
                throw new ApiException("AI_TASK_ACTIVE", 409, "The project already has an active task");
            }
            try {
                jdbc.update("""
                    INSERT INTO agent_task(id, project_id, owner_id, request_sha256, prompt,
                        state, worker_epoch, workspace_revision, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?)
                    """,
                    request.taskId(), projectId, ownerId, requestSha256, request.prompt(),
                    request.expectedRevision(), now, now);
            } catch (DuplicateKeyException ex) {
                // The unique index is the backstop behind the in-transaction pre-check.
                throw new ApiException("AI_TASK_ACTIVE", 409, "The project already has an active task");
            }
            return new AgentContracts.TaskSnapshot(request.taskId(), AgentContracts.TaskState.QUEUED,
                Long.toString(request.expectedRevision()), true, List.of(), List.of(), null, null);
        }));
    }

    /** One task by id, visible only through the owner's project. */
    public Optional<AgentContracts.TaskSnapshot> findForOwner(String ownerId, String projectId, String taskId) {
        return findTaskByOwner(ownerId, projectId, "AND t.id = ?", taskId);
    }

    /** The task that currently owns the project's writes, if any. */
    public Optional<AgentContracts.TaskSnapshot> currentForOwner(String ownerId, String projectId) {
        return findTaskByOwner(ownerId, projectId, "AND t.active_project = ?", projectId);
    }

    /** The durable owner/project identity behind one task; tool dispatch never trusts caller input. */
    public record TaskOwner(String ownerId, String projectId) { }

    /** Resolves the task's durable owner/project pair; refuses unknown ids. */
    public TaskOwner taskOwner(String taskId) {
        List<TaskOwner> owners = jdbc.query(
            "SELECT owner_id, project_id FROM agent_task WHERE id = ?",
            (rs, row) -> new TaskOwner(rs.getString(1), rs.getString(2)), taskId);
        if (owners.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        return owners.get(0);
    }

    /** One durable tool-call row: stable identity, request digest, lifecycle and linked operation. */
    public record ToolCallRow(String taskId, String toolCallId, String requestSha256, String toolName,
                              String argsJson, String state, String workspaceOperationId,
                              long expectedRevision, String resultJson) { }

    public Optional<ToolCallRow> findToolCall(String taskId, String toolCallId) {
        List<ToolCallRow> rows = jdbc.query("""
            SELECT task_id, tool_call_id, request_sha256, tool_name, args_json, state,
                   workspace_operation_id, expected_revision, result_json
            FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?
            """, (rs, row) -> new ToolCallRow(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7),
            rs.getLong(8), rs.getString(9)), taskId, toolCallId);
        return rows.stream().findFirst();
    }

    /**
     * Registers a tool call under its stable identity: the first insert wins, a lost race re-reads
     * the stored row and the caller's digest decides whether it may proceed — a foreign reuse of
     * the id never rewrites the original row. {@code operationId} pre-allocates the workspace
     * operation for file writes; side-effect-free tools pass null.
     */
    public ToolCallRow registerToolCall(String taskId, String toolCallId, String requestSha256,
                                        String toolName, String argsJson, long expectedRevision,
                                        String operationId) {
        Timestamp now = Timestamp.from(clock.instant());
        try {
            jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?)
                """, taskId, toolCallId, requestSha256, toolName, argsJson, operationId, expectedRevision, now, now);
        } catch (DuplicateKeyException ex) {
            // The stable identity is already registered: the stored row decides below.
        }
        ToolCallRow stored = findToolCall(taskId, toolCallId).orElseThrow(
            () -> new IllegalStateException("agent tool call registration vanished"));
        if (!requestSha256.equals(stored.requestSha256())) {
            throw new ApiException("AI_CALL_MISMATCH", 409,
                "This tool call id was already used for a different request");
        }
        return stored;
    }

    /** Settles the call COMPLETED with its bounded result JSON — the durable answer for replays. */
    public void completeToolCall(String taskId, String toolCallId, String resultJson) {
        jdbc.update(
            "UPDATE agent_tool_call SET state = 'COMPLETED', result_json = ?, updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ?",
            resultJson, Timestamp.from(clock.instant()), taskId, toolCallId);
    }

    /**
     * Binds the verified Kubernetes identity of a development build to its call row and marks
     * it RUNNING: the durable record of which Job/Pod belongs to this call, written while the
     * executor waits so a backend restart can still find the build by its bound identity.
     */
    public void bindToolCallIdentity(String taskId, String toolCallId, String jobName,
                                     String jobUid, String podUid) {
        jdbc.update(
            "UPDATE agent_tool_call SET state = 'RUNNING', job_name = ?, job_uid = ?, pod_uid = ?, updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state IN ('REGISTERED', 'RUNNING')",
            jobName, jobUid, podUid, Timestamp.from(clock.instant()), taskId, toolCallId);
    }

    /**
     * Atomically claims the first execution of a REGISTERED build call by transitioning it to
     * RUNNING before its executor touches the cluster: the single request whose update wins
     * this transition owns the one execution, every later replay is a recovery that may only
     * observe the recorded identity, never start the build again. Returns false for a row that
     * was already RUNNING or settled — the caller must then follow the recovery path instead.
     */
    public boolean markToolCallRunning(String taskId, String toolCallId) {
        return jdbc.update(
            "UPDATE agent_tool_call SET state = 'RUNNING', updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state = 'REGISTERED'",
            Timestamp.from(clock.instant()), taskId, toolCallId) > 0;
    }

    /**
     * The durable build identity bound to one call, if any: the recovery path observes exactly
     * this Job/Pod and never creates a replacement for evidence that has vanished.
     */
    public Optional<AgentContracts.BuildIdentity> boundBuildIdentity(String taskId, String toolCallId) {
        List<AgentContracts.BuildIdentity> rows = jdbc.query(
            "SELECT job_name, job_uid, pod_uid FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
            (rs, row) -> new AgentContracts.BuildIdentity(rs.getString(1), rs.getString(2), rs.getString(3)),
            taskId, toolCallId);
        return rows.stream().findFirst()
            .filter(identity -> identity.jobName() != null || identity.jobUid() != null
                || identity.podUid() != null);
    }

    /**
     * Marks the outcome unknown: the project keeps its occupancy and further writes stay blocked
     * until the call is reconciled or the task is closed. A settled answer is never downgraded.
     */
    public void markToolCallNeedsAttention(String taskId, String toolCallId) {
        jdbc.update(
            "UPDATE agent_tool_call SET state = 'NEEDS_ATTENTION', updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state IN ('REGISTERED', 'RUNNING')",
            Timestamp.from(clock.instant()), taskId, toolCallId);
    }

    /** True while a call other than this one is REGISTERED/RUNNING/NEEDS_ATTENTION. */
    public boolean hasUnsettledCallOtherThan(String taskId, String toolCallId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ? AND tool_call_id <> ? "
                + "AND state IN ('REGISTERED', 'RUNNING', 'NEEDS_ATTENTION')",
            Integer.class, taskId, toolCallId);
        return count != null && count > 0;
    }

    private Optional<AgentContracts.TaskSnapshot> findTaskByOwner(String ownerId, String projectId,
                                                                  String extraCondition, Object... extraArgs) {
        String sql = """
            SELECT t.id, t.request_sha256, t.state, t.workspace_revision, t.progress_json,
                   t.summary, t.failure_code, t.active_project
            FROM agent_task t INNER JOIN project p ON p.id = t.project_id
            WHERE p.owner_id = ? AND t.project_id = ? %s
            """.formatted(extraCondition);
        List<Object> parameters = new ArrayList<>();
        parameters.add(ownerId);
        parameters.add(projectId);
        parameters.addAll(List.of(extraArgs));
        List<TaskRow> rows = jdbc.query(sql, (rs, row) -> new TaskRow(
            rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
            rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8) != null),
            parameters.toArray());
        return rows.stream().findFirst().map(this::snapshot);
    }

    private Optional<TaskRow> findTaskById(String taskId) {
        List<TaskRow> rows = jdbc.query("""
            SELECT id, request_sha256, state, workspace_revision, progress_json,
                   summary, failure_code, active_project
            FROM agent_task WHERE id = ?
            """, (rs, row) -> new TaskRow(
            rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
            rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8) != null), taskId);
        return rows.stream().findFirst();
    }

    private AgentContracts.TaskSnapshot snapshot(TaskRow row) {
        boolean writesLocked = row.active() && OCCUPYING_STATES.contains(row.state());
        return new AgentContracts.TaskSnapshot(row.id(), AgentContracts.TaskState.valueOf(row.state()),
            Long.toString(row.workspaceRevision()), writesLocked,
            parseProgress(row.progressJson()), List.of(), row.summary(), row.failureCode());
    }

    /**
     * Task 1 never persists progress, so a NULL column reads as empty. The stored envelope is
     * owned by the task-service task; until then only its documented item array is interpreted.
     */
    private static List<AgentContracts.ProgressItem> parseProgress(String progressJson) {
        if (progressJson == null) {
            return List.of();
        }
        try {
            JsonNode envelope = JSON.readTree(progressJson);
            JsonNode items = envelope.path("items");
            if (!items.isArray()) {
                return List.of();
            }
            List<AgentContracts.ProgressItem> progress = new ArrayList<>();
            for (JsonNode item : items) {
                progress.add(new AgentContracts.ProgressItem(item.path("seq").asLong(),
                    item.path("kind").asText(""), item.path("text").asText(""),
                    item.path("truncated").asBoolean(false)));
            }
            return List.copyOf(progress);
        } catch (Exception ex) {
            throw new IllegalStateException("stored task progress is unreadable", ex);
        }
    }

    private boolean hasActiveTask(String projectId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM agent_task WHERE active_project = ?", Integer.class, projectId);
        return count != null && count > 0;
    }

    private boolean hasActiveRun(String projectId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM run WHERE project_id = ? AND active_run_marker = 1",
            Integer.class, projectId);
        return count != null && count > 0;
    }

    private boolean hasPendingOperation(String projectId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_operation WHERE project_id = ? AND state = 'PENDING'",
            Integer.class, projectId);
        return count != null && count > 0;
    }

    private void validate(AgentContracts.TaskRequest request) {
        if (request == null || request.taskId() == null
            || !TASK_ID.matcher(request.taskId()).matches()) {
            throw validation();
        }
        String prompt = request.prompt();
        if (prompt == null || prompt.isBlank()
            || prompt.length() < MIN_PROMPT_CHARS || prompt.length() > MAX_PROMPT_CHARS) {
            throw validation();
        }
        if (request.expectedRevision() < 0) {
            throw validation();
        }
    }

    /**
     * The request identity: SHA-256 over the fixed-field-order JSON of taskId, ownerId,
     * projectId, prompt and expectedRevision — the same bytes for the same intent, different
     * bytes for any different request.
     */
    private static String requestSha256(String ownerId, String projectId,
                                        AgentContracts.TaskRequest request) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("taskId", request.taskId());
        fields.put("ownerId", ownerId);
        fields.put("projectId", projectId);
        fields.put("prompt", request.prompt());
        fields.put("expectedRevision", request.expectedRevision());
        try {
            return sha256Hex(JSON.writeValueAsBytes(fields));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize the agent task request digest", ex);
        }
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }

    private static ApiException validation() {
        return new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    private static AgentContracts.TaskSnapshot requireSnapshot(AgentContracts.TaskSnapshot snapshot) {
        if (snapshot == null) {
            throw new IllegalStateException("agent task creation returned no snapshot");
        }
        return snapshot;
    }

    private record ProjectRow(String ownerId, String state, long workspaceRevision) { }

    /** The durable task row as the snapshot mapper sees it; {@code active} is the occupancy. */
    private record TaskRow(String id, String requestSha256, String state, long workspaceRevision,
                           String progressJson, String summary, String failureCode, boolean active) { }
}
