package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.AgentTaskOccupancy;
import java.io.IOException;
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

    /** One durable tool-call row: stable identity, request digest, lifecycle, linked operation and build identity. */
    public record ToolCallRow(String taskId, String toolCallId, String requestSha256, String toolName,
                              String argsJson, String state, String workspaceOperationId,
                              long expectedRevision, String resultJson,
                              String jobName, String jobUid, String podUid) { }

    private static final String TOOL_CALL_COLUMNS = """
        task_id, tool_call_id, request_sha256, tool_name, args_json, state,
        workspace_operation_id, expected_revision, result_json, job_name, job_uid, pod_uid
        """;

    private org.springframework.jdbc.core.RowMapper<ToolCallRow> toolCallRowMapper() {
        return (rs, row) -> new ToolCallRow(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7),
            rs.getLong(8), rs.getString(9), rs.getString(10), rs.getString(11), rs.getString(12));
    }

    public Optional<ToolCallRow> findToolCall(String taskId, String toolCallId) {
        List<ToolCallRow> rows = jdbc.query("""
            SELECT %s FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?
            """.formatted(TOOL_CALL_COLUMNS), toolCallRowMapper(), taskId, toolCallId);
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

    // ------------------------------------------------------------------
    // Stage-one task lifecycle: fencing epoch, worker binding, progress
    // sequence, terminal application and the close flow. The caller holds
    // the shared ProjectLifecycleGate around create/persistEpoch/close;
    // every method here is a durable CAS or a locked transaction.
    // ------------------------------------------------------------------

    /** The durable request digest of one task, carried back to the worker in WorkerStart. */
    public String requestSha256Of(String taskId) {
        List<String> digests = jdbc.query(
            "SELECT request_sha256 FROM agent_task WHERE id = ?",
            (rs, row) -> rs.getString(1), taskId);
        if (digests.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        return digests.get(0);
    }

    /**
     * Bumps and returns the task's fencing epoch. Each start attempt moves the epoch
     * forward, so a late ACK or callback of a superseded attempt can never bind, run
     * or settle anything. The caller holds the shared gate.
     */
    public long persistEpoch(String taskId) {
        jdbc.update("UPDATE agent_task SET worker_epoch = worker_epoch + 1, updated_at = ? WHERE id = ?",
            Timestamp.from(clock.instant()), taskId);
        Long epoch = jdbc.queryForObject("SELECT worker_epoch FROM agent_task WHERE id = ?", Long.class, taskId);
        if (epoch == null) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        return epoch;
    }

    /**
     * Atomically binds the first correct (epoch, instance) pair and moves QUEUED to
     * RUNNING. A stale epoch or a settled row changes nothing, so a late ACK can
     * never regress the task. Returns false when nothing was bound.
     */
    public boolean bindWorkerInstance(String taskId, long epoch, String instanceId) {
        return jdbc.update("""
                UPDATE agent_task SET state = 'RUNNING', worker_instance_id = ?, updated_at = ?
                WHERE id = ? AND worker_epoch = ? AND state = 'QUEUED'
                """,
            instanceId, Timestamp.from(clock.instant()), taskId, epoch) > 0;
    }

    private record WorkerRow(String state, long workerEpoch, String instanceId) { }

    /**
     * Validates a worker callback against the durable fencing state: unknown task is
     * a 404, a stale epoch is refused before anything else happens, and after the
     * first binding every later callback must come from the same instance. The first
     * correct callback (which may precede the start ACK) atomically binds the
     * instance and starts the task.
     */
    public void requireWorkerIdentity(String taskId, long epoch, String instanceId) {
        List<WorkerRow> rows = jdbc.query(
            "SELECT state, worker_epoch, worker_instance_id FROM agent_task WHERE id = ?",
            (rs, row) -> new WorkerRow(rs.getString(1), rs.getLong(2), rs.getString(3)), taskId);
        if (rows.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        WorkerRow row = rows.get(0);
        if (row.workerEpoch() != epoch) {
            throw new ApiException("AI_EPOCH_MISMATCH", 409, "The worker epoch does not match the task");
        }
        if (row.instanceId() != null && !row.instanceId().equals(instanceId)) {
            throw new ApiException("AI_INSTANCE_MISMATCH", 409, "The task is bound to another worker instance");
        }
        if ("QUEUED".equals(row.state())) {
            bindWorkerInstance(taskId, epoch, instanceId);
        }
        // Re-read the authoritative binding: a concurrent callback may have won the CAS.
        String bound = jdbc.queryForObject(
            "SELECT worker_instance_id FROM agent_task WHERE id = ?", String.class, taskId);
        if (bound != null && !bound.equals(instanceId)) {
            throw new ApiException("AI_INSTANCE_MISMATCH", 409, "The task is bound to another worker instance");
        }
    }

    /** A brand-new tool call may only register on a QUEUED or RUNNING task. */
    public void requireTaskAcceptsNewCall(String taskId, String projectId) {
        List<String> states = jdbc.query(
            "SELECT state FROM agent_task WHERE id = ? AND project_id = ?",
            (rs, row) -> rs.getString(1), taskId, projectId);
        if (states.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        if (!"QUEUED".equals(states.get(0)) && !"RUNNING".equals(states.get(0))) {
            throw new ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
        }
    }

    /** The settled progress answer: the new durable sequence head and whether the item landed. */
    public record ProgressAppend(long lastSeq, boolean appended) { }

    /**
     * Appends one progress item to the task's bounded envelope under a row lock:
     * monotonic seq, same-seq same-payload replays are idempotent no-ops, a same-seq
     * different-payload replay is a 409, a gap is answered with the expected seq, and
     * the envelope keeps at most the most recent 100 items of 8 KiB each.
     */
    public ProgressAppend appendProgress(String taskId, AgentContracts.ProgressItem item) {
        validateProgressItem(item);
        String payloadSha = progressPayloadSha(item);
        Timestamp now = Timestamp.from(clock.instant());
        return requireAppend(transaction.execute(status -> {
            List<String> states = jdbc.query(
                "SELECT state FROM agent_task WHERE id = ? FOR UPDATE",
                (rs, row) -> rs.getString(1), taskId);
            if (states.isEmpty()) {
                throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
            }
            if (!OCCUPYING_STATES.contains(states.get(0))) {
                throw new ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
            }
            Envelope envelope = readEnvelope(taskId);
            if (item.seq() < envelope.lastSeq) {
                // A replay of an older item: inside the retained window the stored
                // payload decides — identical bytes are an idempotent replay, different
                // bytes are a forgery. Outside the window the durable copy won and the
                // item can no longer be verified either way.
                AgentContracts.ProgressItem retained = envelope.items.stream()
                    .filter(stored -> stored.seq() == item.seq())
                    .findFirst()
                    .orElse(null);
                if (retained != null && !progressPayloadSha(retained).equals(payloadSha)) {
                    throw new ApiException("AI_PROGRESS_MISMATCH", 409,
                        "This progress seq was already used for a different payload");
                }
                return new ProgressAppend(envelope.lastSeq, false);
            }
            if (item.seq() == envelope.lastSeq) {
                if (payloadSha.equals(envelope.lastPayloadSha)) {
                    return new ProgressAppend(envelope.lastSeq, false);
                }
                throw new ApiException("AI_PROGRESS_MISMATCH", 409,
                    "This progress seq was already used for a different payload");
            }
            if (item.seq() > envelope.lastSeq + 1) {
                throw new ProgressGapException(envelope.lastSeq + 1);
            }
            List<AgentContracts.ProgressItem> items = new ArrayList<>(envelope.items);
            items.add(item);
            while (items.size() > MAX_PROGRESS_ITEMS) {
                items.remove(0);
            }
            jdbc.update("UPDATE agent_task SET progress_json = ?, updated_at = ? WHERE id = ?",
                envelopeJson(items, item.seq(), payloadSha), now, taskId);
            return new ProgressAppend(item.seq(), true);
        }));
    }

    /**
     * Applies a worker-reported terminal state by CAS from an occupying state only:
     * a late terminal can never overwrite a settled task, and a task marked for
     * close (NEEDS_ATTENTION) is released by the close flow alone.
     */
    public boolean applyTerminal(String taskId, AgentContracts.TaskState state, String summary, String failureCode) {
        if (state != AgentContracts.TaskState.COMPLETED && state != AgentContracts.TaskState.FAILED) {
            throw new IllegalArgumentException("only COMPLETED or FAILED may be applied as a terminal state");
        }
        return jdbc.update("""
                UPDATE agent_task SET state = ?, summary = ?, failure_code = ?, updated_at = ?
                WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                """,
            state.name(), summary, failureCode, Timestamp.from(clock.instant()), taskId) > 0;
    }

    /** The close flow's marker failure code; a close may only release from its own marker. */
    public static final String CLOSING_MARKER = "AI_CLOSING";

    /** The close-flow entry state: START armed the marker now, RETRY re-enters an already armed close, SETTLED means nothing to release. */
    public enum CloseEntry { START, RETRY, SETTLED }

    /**
     * The close flow's gate-protected entry. A QUEUED/RUNNING task is marked
     * NEEDS_ATTENTION with the AI_CLOSING marker (START), which refuses every new
     * tool-call registration while the evidence is finished. A task already marked
     * AI_CLOSING by an earlier close whose evidence could not be finished answers
     * RETRY — the close may be re-driven until it provably succeeds. Anything else is
     * SETTLED: an already released task never re-enters the flow.
     */
    public CloseEntry beginClose(String taskId) {
        if (markClosing(taskId)) {
            return CloseEntry.START;
        }
        List<Row> rows = jdbc.query(
            "SELECT state, failure_code FROM agent_task WHERE id = ?",
            (rs, row) -> new Row(rs.getString(1), rs.getString(2)), taskId);
        if (rows.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        if ("NEEDS_ATTENTION".equals(rows.get(0).state())
            && CLOSING_MARKER.equals(rows.get(0).failureCode())) {
            return CloseEntry.RETRY;
        }
        return CloseEntry.SETTLED;
    }

    private record Row(String state, String failureCode) { }

    /**
     * The closing fence the build execution path consults immediately before Job
     * creation: true once the task carries the AI_CLOSING marker, so an execution
     * thread claimed before the close can never create a Job afterwards.
     */
    public boolean hasClosingIntent(String taskId) {
        List<Row> rows = jdbc.query(
            "SELECT state, failure_code FROM agent_task WHERE id = ?",
            (rs, row) -> new Row(rs.getString(1), rs.getString(2)), taskId);
        return !rows.isEmpty()
            && "NEEDS_ATTENTION".equals(rows.get(0).state())
            && CLOSING_MARKER.equals(rows.get(0).failureCode());
    }

    /**
     * The close flow's first, gate-protected step: a QUEUED/RUNNING task becomes
     * NEEDS_ATTENTION with the AI_CLOSING marker, which refuses every new tool-call
     * registration while the worker is stopped and the evidence is finished. False
     * when the task was already settled or already closing.
     */
    public boolean markClosing(String taskId) {
        return jdbc.update("""
                UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = ?, updated_at = ?
                WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                """,
            CLOSING_MARKER, Timestamp.from(clock.instant()), taskId) > 0;
    }

    /** The close flow's final step: only its own AI_CLOSING marker releases the project. */
    public boolean failClosedTask(String taskId, String failureCode, String summary) {
        return jdbc.update("""
                UPDATE agent_task SET state = 'FAILED', failure_code = ?, summary = ?, updated_at = ?
                WHERE id = ? AND state = 'NEEDS_ATTENTION' AND failure_code = 'AI_CLOSING'
                """,
            failureCode, summary, Timestamp.from(clock.instant()), taskId) > 0;
    }

    /** Every still-unsettled call of one task; the close flow finishes what it can of these. */
    public List<ToolCallRow> unsettledCalls(String taskId) {
        return jdbc.query("SELECT " + TOOL_CALL_COLUMNS
                + " FROM agent_tool_call WHERE task_id = ? AND state IN ('REGISTERED', 'RUNNING', 'NEEDS_ATTENTION')",
            toolCallRowMapper(), taskId);
    }

    private static final int MAX_PROGRESS_ITEMS = 100;
    static final int MAX_PROGRESS_TEXT_BYTES = 8 * 1024;
    private static final int MAX_PROGRESS_KIND_CHARS = 32;

    private void validateProgressItem(AgentContracts.ProgressItem item) {
        if (item == null || item.seq() < 1 || item.kind() == null || item.kind().isBlank()
            || item.kind().length() > MAX_PROGRESS_KIND_CHARS || item.text() == null) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        if (item.text().getBytes(StandardCharsets.UTF_8).length > MAX_PROGRESS_TEXT_BYTES) {
            throw new ApiException("AI_PROGRESS_TOO_LARGE", 422, "Progress item exceeds the 8 KiB bound");
        }
    }

    /** The payload identity: SHA-256 over the fixed-field-order JSON of one progress item. */
    static String progressPayloadSha(AgentContracts.ProgressItem item) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("seq", item.seq());
        fields.put("kind", item.kind());
        fields.put("text", item.text());
        fields.put("truncated", item.truncated());
        try {
            return sha256Hex(JSON.writeValueAsBytes(fields));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the progress payload digest", ex);
        }
    }

    private record Envelope(List<AgentContracts.ProgressItem> items, long lastSeq, String lastPayloadSha) { }

    private Envelope readEnvelope(String taskId) {
        String json = jdbc.queryForObject(
            "SELECT progress_json FROM agent_task WHERE id = ?", String.class, taskId);
        if (json == null || json.isBlank()) {
            return new Envelope(List.of(), 0, null);
        }
        try {
            com.fasterxml.jackson.databind.JsonNode envelope = JSON.readTree(json);
            List<AgentContracts.ProgressItem> items = new ArrayList<>();
            for (com.fasterxml.jackson.databind.JsonNode node : envelope.path("items")) {
                items.add(new AgentContracts.ProgressItem(node.path("seq").asLong(),
                    node.path("kind").asText(""), node.path("text").asText(""),
                    node.path("truncated").asBoolean(false)));
            }
            return new Envelope(items, envelope.path("lastSeq").asLong(0),
                envelope.path("lastPayloadSha").isNull() ? null : envelope.path("lastPayloadSha").asText(null));
        } catch (IOException ex) {
            throw new IllegalStateException("stored task progress is unreadable", ex);
        }
    }

    private static String envelopeJson(List<AgentContracts.ProgressItem> items, long lastSeq, String lastPayloadSha) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("items", items);
        envelope.put("lastSeq", lastSeq);
        envelope.put("lastPayloadSha", lastPayloadSha);
        try {
            return JSON.writeValueAsString(envelope);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the progress envelope", ex);
        }
    }

    private static ProgressAppend requireAppend(ProgressAppend append) {
        if (append == null) {
            throw new IllegalStateException("progress append returned no result");
        }
        return append;
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
