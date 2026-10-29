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
import java.util.Set;
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
 * preflight there — owner, READY, expected revision, no pending workspace
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
    /** The deduped changed-path ledger of one task is bounded like the progress envelope. */
    private static final int MAX_CHANGED_PATHS = 200;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Clock clock;
    /**
     * The build executions currently live in THIS process, keyed by taskId/toolCallId.
     * A key is added inside the synchronized claim transition and removed only after the
     * call row has settled, so a close that runs under this monitor can tell an active
     * claim (never release) from a restart-leftover RUNNING row (close by identity).
     */
    private final java.util.Set<String> liveBuildClaims = new java.util.HashSet<>();

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
        return createTask(ownerId, projectId, request).snapshot();
    }

    /** What {@link #create} decided: the snapshot, whether this call created the row, and its epoch. */
    public record TaskCreation(AgentContracts.TaskSnapshot snapshot, boolean created, long epoch) { }

    /**
     * The durable decision behind {@link #create}, plus whether this call created the task.
     * A re-submission of the same request answers the original row with
     * {@code created = false} — the caller never re-drives, re-fences or re-prompts it.
     */
    public TaskCreation createTask(String ownerId, String projectId,
                                   AgentContracts.TaskRequest request) {
        return createTask(ownerId, projectId, request, null);
    }

    public TaskCreation createTask(String ownerId, String projectId,
                                   AgentContracts.TaskRequest request, String conversationId) {
        validate(request);
        if (conversationId != null) AgentConversationStore.requireUuid(conversationId);
        String effort = request.reasoningEffort() == null ? "high" : request.reasoningEffort();
        Timestamp now = Timestamp.from(clock.instant());
        return java.util.Objects.requireNonNull(transaction.execute(status -> {
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
                boolean legacy = existing.get().reasoningEffort() == null;
                String digest = requestSha256(ownerId, projectId, request, conversationId, legacy);
                if (legacy && request.reasoningEffort() != null || !digest.equals(existing.get().requestSha256())) {
                    throw new ApiException("AI_TASK_MISMATCH", 409,
                        "This task id was already used for a different request");
                }
                return new TaskCreation(snapshot(existing.get()), false, existing.get().workerEpoch());
            }
            String requestSha256 = requestSha256(ownerId, projectId, request, conversationId, false);
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
            if (hasPendingOperation(projectId)) {
                throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
            }
            if (hasActiveTask(projectId)) {
                throw new ApiException("AI_TASK_ACTIVE", 409, "The project already has an active task");
            }
            AgentConversationStore.requireNoCompaction(jdbc, projectId);
            if (conversationId != null) {
                AgentConversationStore.bindTaskGoal(jdbc, clock, projectId, conversationId, request);
            }
            try {
                // The fencing epoch is persisted exactly once, at creation: a re-submission
                // of the same request never moves it, so a start response loss is reconciled
                // by the same-epoch status read instead of a second, overlapping session.
                // The budget deadline is bound from the SAME clock in the same write
                // (design section 4): created_at + 1800s; legacy rows keep NULL and never
                // enter the automatic budget close.
                Timestamp deadline = new Timestamp(now.getTime() + TERMINAL_DEADLINE_SECONDS * 1000L);
                jdbc.update("""
                    INSERT INTO agent_task(id, project_id, owner_id, request_sha256, prompt,
                        state, worker_epoch, workspace_revision, created_at, updated_at,
                        conversation_id, reasoning_effort, deadline_at, next_reconcile_at)
                    VALUES (?, ?, ?, ?, ?, 'QUEUED', 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    request.taskId(), projectId, ownerId, requestSha256, request.prompt(),
                    request.expectedRevision(), now, now, conversationId, effort, deadline, now);
            } catch (DuplicateKeyException ex) {
                // The unique index is the backstop behind the in-transaction pre-check.
                throw new ApiException("AI_TASK_ACTIVE", 409, "The project already has an active task");
            }
            return new TaskCreation(new AgentContracts.TaskSnapshot(request.taskId(),
                AgentContracts.TaskState.QUEUED, Long.toString(request.expectedRevision()),
                true, List.of(), List.of(), null, null, conversationId, effort), true, 1L);
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

    /** Read-only display eligibility: one current task and the most recently settled task. */
    public record LiveTask(String taskId, String conversationId, java.time.Instant terminalAt) { }

    public List<LiveTask> liveOutputTasks() {
        return jdbc.query("""
            (SELECT t.id, t.conversation_id, NULL AS terminal_at FROM agent_task t
             JOIN agent_conversation c ON c.id=t.conversation_id AND c.project_id=t.project_id
             WHERE t.active_project IS NOT NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 1)
            UNION ALL
            (SELECT t.id, t.conversation_id, t.updated_at AS terminal_at FROM agent_task t
             JOIN agent_conversation c ON c.id=t.conversation_id AND c.project_id=t.project_id
             WHERE t.state IN ('COMPLETED','FAILED') ORDER BY t.updated_at DESC,t.id DESC LIMIT 1)
            """, (rs, row) -> new LiveTask(rs.getString(1), rs.getString(2),
                rs.getTimestamp(3) == null ? null : rs.getTimestamp(3).toInstant()));
    }

    public String liveOutputConversation(String taskId) {
        var rows = jdbc.query("""
            SELECT t.conversation_id FROM agent_task t JOIN agent_conversation c
              ON c.id=t.conversation_id AND c.project_id=t.project_id
            WHERE t.id=?
            """, (rs, row) -> rs.getString(1), taskId);
        if (rows.isEmpty()) throw new ApiException("AI_LIVE_UNSUPPORTED", 409, "Live output requires a conversation");
        return rows.get(0);
    }

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
     * Registers a tool call under its stable identity. The whole decision runs under this
     * store monitor — the same monitor the terminal application (C1) and the build claim
     * take — and the task-state condition lives INSIDE the registration statement itself
     * (fix round 3): the pre-check below is advisory, and a terminal verdict that commits
     * from ANY other connection between it and the INSERT makes the INSERT a no-op, so a
     * late REGISTERED row can never land on a settled task. The refused registration takes
     * the deterministic settled-task rejection path; everything else behaves as before:
     *
     * <ul>
     *   <li>the first insert wins and re-validates, inside the monitor, that the task is
     *       still QUEUED/RUNNING and (for a side-effect tool) that no earlier call is
     *       unsettled — a terminal or close that raced the registration is already
     *       durable here and refuses the new row;</li>
     *   <li>a lost race re-reads the stored row and the caller's digest decides whether it
     *       may proceed — a foreign reuse of the id never rewrites the original row.</li>
     * </ul>
     *
     * <p>{@code operationId} pre-allocates the workspace operation for file writes and the
     * stable command id for builds. Application/start uses it as Run identity, never as a
     * workspace receipt. Side-effect-free tools pass null, which is also the
     * marker that skips the unsettled-others check.</p>
     */
    public synchronized ToolCallRow registerToolCall(String taskId, String toolCallId,
                                                     String requestSha256, String toolName,
                                                     String argsJson, long expectedRevision,
                                                     String operationId) {
        Optional<ToolCallRow> existing = findToolCall(taskId, toolCallId);
        if (existing.isEmpty()) {
            requireTaskAcceptsNewCalls(taskId);
            if ("application".equals(toolName) && isApplicationStart(argsJson)) {
                long starts = applicationCalls(taskId).stream().filter(call -> isApplicationStart(call.argsJson())).count();
                if (starts >= 4) {
                    throw new ApiException("AI_APPLICATION_START_LIMIT", 409, "The application start limit was reached");
                }
                if (operationId == null || !TASK_ID.matcher(operationId).matches()) throw unauthorizedRunCall();
            }
            if (operationId != null && hasUnsettledCall(taskId)) {
                throw new ApiException("AI_CALL_UNSETTLED", 409,
                    "An earlier tool call has not settled; resolve it before writing");
            }
        }
        Timestamp now = Timestamp.from(clock.instant());
        try {
            int registered = jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?
                FROM agent_task t
                WHERE t.id = ? AND t.state IN ('QUEUED', 'RUNNING')
                """, taskId, toolCallId, requestSha256, toolName, argsJson,
                operationId, expectedRevision, now, now, taskId);
            if (registered == 0) {
                return registerSettledTaskRejection(taskId, toolCallId, requestSha256, toolName,
                    argsJson, expectedRevision, now);
            }
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

    /**
     * The deterministic refusal when a registration raced a terminal verdict (fix round 3,
     * C1): the pre-check read the task active, the terminal committed from another
     * connection, and the atomic registration INSERT was refused. Nothing was ever
     * pre-executed for the refused call (no workspace operation row, no Job), so the
     * refusal is side-effect-free and persists as the call's settled COMPLETED answer
     * carrying {@code data.error} — the established deterministic-rejection semantics the
     * worker feeds back to Pi. The row can never block a later terminal, a close or a
     * release: it is born settled.
     */
    private ToolCallRow registerSettledTaskRejection(String taskId, String toolCallId,
                                                     String requestSha256, String toolName,
                                                     String argsJson, long expectedRevision,
                                                     Timestamp now) {
        Long revision = jdbc.query("""
            SELECT p.workspace_revision FROM agent_task t JOIN project p ON p.id = t.project_id
            WHERE t.id = ?
            """, (rs, row) -> rs.getLong(1), taskId).stream().findFirst().orElse(0L);
        com.fasterxml.jackson.databind.node.ObjectNode error = JSON.createObjectNode()
            .put("code", "AI_TASK_NOT_ACTIVE")
            .put("message", "The task already settled; the call was refused");
        com.fasterxml.jackson.databind.node.ObjectNode data = JSON.createObjectNode();
        data.set("error", error);
        String resultJson;
        try {
            resultJson = JSON.writeValueAsString(new AgentContracts.ToolResult(toolCallId,
                Long.toString(revision), data, false));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the settled-task rejection", ex);
        }
        try {
            jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, result_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'COMPLETED', NULL, ?, ?, ?, ?)
                """, taskId, toolCallId, requestSha256, toolName, argsJson, expectedRevision,
                resultJson, now, now);
        } catch (DuplicateKeyException ex) {
            // A concurrent registration won the identity: the stored row decides below.
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
     * observe the recorded identity, never start the build again. The claim is also recorded
     * as live in this process under the same monitor, so the close flow can tell an active
     * execution thread from a restart-leftover RUNNING row. Returns false for a row that
     * was already RUNNING or settled — the caller must then follow the recovery path instead.
     */
    public synchronized boolean markToolCallRunning(String taskId, String toolCallId) {
        boolean claimed = jdbc.update(
            "UPDATE agent_tool_call SET state = 'RUNNING', updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state = 'REGISTERED' "
                + "AND EXISTS (SELECT 1 FROM agent_task t WHERE t.id = task_id AND t.state IN ('QUEUED', 'RUNNING'))",
            Timestamp.from(clock.instant()), taskId, toolCallId) > 0;
        if (claimed) {
            liveBuildClaims.add(taskId + "/" + toolCallId);
        }
        return claimed;
    }

    /** True while this process still holds the live execution claim of one build call. */
    public synchronized boolean isBuildClaimLive(String taskId, String toolCallId) {
        return liveBuildClaims.contains(taskId + "/" + toolCallId);
    }

    /** Application recovery observes an existing invocation; it never reissues its command. */
    public synchronized boolean reclaimApplicationObservation(String taskId, String toolCallId) {
        ToolCallRow call = findToolCall(taskId, toolCallId).orElse(null);
        if (call == null || !Set.of("application", "app_http_get").contains(call.toolName())
            || !"RUNNING".equals(call.state()) || isBuildClaimLive(taskId, toolCallId)) return false;
        requireTaskAcceptsNewCalls(taskId);
        return liveBuildClaims.add(taskId + "/" + toolCallId);
    }

    /** The same claims also fence bounded cleanup against concurrent close requests. */
    public synchronized boolean claimApplicationCleanup(String taskId, String toolCallId) {
        return claimToolCleanup(taskId, toolCallId, "application");
    }

    public synchronized boolean claimBuildCleanup(String taskId, String toolCallId) {
        return claimToolCleanup(taskId, toolCallId, "build");
    }

    private boolean claimToolCleanup(String taskId, String toolCallId, String toolName) {
        ToolCallRow call = findToolCall(taskId, toolCallId).orElse(null);
        if (call == null || !toolName.equals(call.toolName()) || hasLiveToolClaims(taskId)
            || ("build".equals(toolName) && "COMPLETED".equals(call.state()))) return false;
        Integer closing = jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=? "
            + "AND state='NEEDS_ATTENTION' AND failure_code='AI_CLOSING'", Integer.class, taskId);
        return closing != null && closing == 1 && liveBuildClaims.add(taskId + "/" + toolCallId);
    }

    public synchronized boolean hasLiveToolClaims(String taskId) {
        return liveBuildClaims.stream().anyMatch(key -> key.startsWith(taskId + "/"));
    }

    /** A closed call has an unknown result, never a fabricated successful tool snapshot. */
    public synchronized void retireApplicationCall(String taskId, String toolCallId) {
        jdbc.update("UPDATE agent_tool_call SET state='NEEDS_ATTENTION', updated_at=? "
            + "WHERE task_id=? AND tool_call_id=? AND tool_name IN ('application','app_http_get') "
            + "AND state IN ('REGISTERED','RUNNING')", Timestamp.from(clock.instant()), taskId, toolCallId);
    }

    /**
     * Retires the live claim of one build call. Called by the executing thread AFTER its call
     * row has settled (COMPLETED or NEEDS_ATTENTION), so a close that reads the row as RUNNING
     * can never also read the claim as already gone.
     */
    public synchronized void releaseBuildClaim(String taskId, String toolCallId) {
        liveBuildClaims.remove(taskId + "/" + toolCallId);
    }

    /**
     * Settles a claimed build row whose execution the close flow has just finished by its
     * stable identity (a restart leftover): the collected close evidence becomes the row's
     * durable answer. The caller holds the cleanup claim through this settlement.
     */
    public synchronized void settleClosedBuildCall(String taskId, String toolCallId, String resultJson) {
        jdbc.update(
            "UPDATE agent_tool_call SET state = 'COMPLETED', result_json = ?, updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state = 'RUNNING'",
            resultJson, Timestamp.from(clock.instant()), taskId, toolCallId);
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

    /** Close may retire an unclaimed call, never settle another thread's execution. */
    public void markRegisteredCallForClose(String taskId, String toolCallId) {
        jdbc.update("UPDATE agent_tool_call SET state = 'NEEDS_ATTENTION', updated_at = ? "
                + "WHERE task_id = ? AND tool_call_id = ? AND state = 'REGISTERED'",
            Timestamp.from(clock.instant()), taskId, toolCallId);
    }

    /** True while any call of the task is REGISTERED/RUNNING/NEEDS_ATTENTION. */
    public boolean hasUnsettledCall(String taskId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM agent_tool_call WHERE task_id = ? "
                + "AND state IN ('REGISTERED', 'RUNNING', 'NEEDS_ATTENTION')",
            Integer.class, taskId);
        return count != null && count > 0;
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

    /**
     * The durable request digest of one task, carried back to the worker in WorkerStart.
     * The fencing epoch itself is persisted exactly once, at creation.
     */
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

    /** Display callbacks may validate a binding, but never create one or start a task. */
    public void requireBoundWorkerIdentity(String taskId, long epoch, String instanceId) {
        if (instanceId == null || instanceId.isBlank()) throw validation();
        List<WorkerRow> rows = jdbc.query(
            "SELECT state, worker_epoch, worker_instance_id FROM agent_task WHERE id = ?",
            (rs, row) -> new WorkerRow(rs.getString(1), rs.getLong(2), rs.getString(3)), taskId);
        if (rows.isEmpty()) throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        WorkerRow row = rows.get(0);
        if (row.workerEpoch() != epoch)
            throw new ApiException("AI_EPOCH_MISMATCH", 409, "The worker epoch does not match the task");
        if (row.instanceId() == null || !row.instanceId().equals(instanceId))
            throw new ApiException("AI_INSTANCE_MISMATCH", 409, "The task has no matching worker binding");
    }

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

    /** The monitor-side form of {@link #requireTaskAcceptsNewCall}: the task row alone. */
    private void requireTaskAcceptsNewCalls(String taskId) {
        List<String> states = jdbc.query(
            "SELECT state FROM agent_task WHERE id = ?",
            (rs, row) -> rs.getString(1), taskId);
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
    public synchronized ProgressAppend appendProgress(String taskId, AgentContracts.ProgressItem item) {
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
            if (!Set.of("QUEUED", "RUNNING").contains(states.get(0))) {
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
     * Applies a worker-reported terminal state to a task that still accepts new calls.
     * The decision is ONE atomic SQL statement (fix round 2, C1): the side-effect check
     * and the state transition are the same conditional UPDATE, so a concurrent tool-call
     * registration or receipt from ANY database connection — not merely another thread of
     * this JVM — is either durably visible before the verdict (the verdict cannot apply)
     * or lands after it (the row is already terminal and refuses it). The unsettled set
     * covers both halves of a side effect: any tool call still REGISTERED/RUNNING/
     * NEEDS_ATTENTION (an executing build, an unknown outcome) and any task-linked
     * workspace_operation still PENDING (a file receipt that was never verified through
     * the shared reconcile path).
     *
     * <p>The verdict completes ONLY from QUEUED or RUNNING (repair plan task 3): a task
     * parked under the pending-terminal marker is settled exclusively by
     * {@link #completeFromReceipt}, the CAS that matches the stored receipt's identity
     * and canonical content digest. Zero affected rows from a QUEUED/RUNNING task mean
     * an unsettled side effect; one atomic fallback statement then records the verdict
     * as a to-be-verified event — its progress item stays in the envelope and the
     * {@link #TERMINAL_PENDING_MARKER} keeps the project occupied — and only the
     * settlement flow resolves it. A verdict may never settle the task COMPLETED/FAILED
     * while any side effect is undecided.</p>
     */
    public synchronized boolean applyTerminal(String taskId, AgentContracts.TaskState state,
                                              String summary, String failureCode) {
        if (state != AgentContracts.TaskState.COMPLETED && state != AgentContracts.TaskState.FAILED) {
            throw new IllegalArgumentException("only COMPLETED or FAILED may be applied as a terminal state");
        }
        Timestamp now = Timestamp.from(clock.instant());
        int applied = jdbc.update("""
                UPDATE agent_task
                SET state = ?, summary = ?, failure_code = ?, updated_at = ?
                WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                  AND NOT EXISTS (SELECT 1 FROM agent_tool_call c
                      WHERE c.task_id = agent_task.id
                        AND c.state IN ('REGISTERED', 'RUNNING', 'NEEDS_ATTENTION'))
                  AND NOT EXISTS (SELECT 1 FROM agent_tool_call c2
                      JOIN workspace_operation w ON w.id = c2.workspace_operation_id
                      WHERE c2.task_id = agent_task.id AND w.state = 'PENDING')
                """,
            state.name(), summary, failureCode, now, taskId);
        if (applied > 0) {
            return true;
        }
        return jdbc.update("""
                UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = ?, summary = ?, updated_at = ?
                WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                """,
            TERMINAL_PENDING_MARKER, summary, now, taskId) > 0;
    }

    /** The close flow's marker failure code; a close may only release from its own marker. */
    public static final String CLOSING_MARKER = "AI_CLOSING";

    /**
     * The task marker for a worker terminal verdict that could not be applied because a tool
     * side effect was still unsettled: the report stays recorded (its progress item remains
     * in the envelope) while the project keeps its occupancy until the close flow resolves it.
     */
    public static final String TERMINAL_PENDING_MARKER = "AI_TERMINAL_PENDING";

    /**
     * The budget deadline of a NEW task, bound from the same clock as its creation
     * (design section 4): created_at + 1800s. Legacy rows keep NULL and never enter the
     * automatic budget close.
     */
    static final int TERMINAL_DEADLINE_SECONDS = 1800;

    /** The durable close reason a deadline-reached receipt records (design section 6). */
    public static final String BUDGET_CLOSE_REASON = "AI_TASK_BUDGET_EXCEEDED";

    // ------------------------------------------------------------------
    // Durable terminal receipts (repair design section 4). The receipt —
    // report id, normalized report JSON, canonical content digest, receive
    // time — is the single durable terminal evidence of one execution. The
    // recordTerminal transaction locks the project row then the task row,
    // re-verifies the execution identity, and either acknowledges the same
    // receipt, refuses a conflict explicitly, answers a stored close
    // intent CLOSING, records the budget close at the deadline, or stores
    // the report and parks the task — all before the ACK, with zero
    // Kubernetes/Worker IO and no project memory gate.
    // ------------------------------------------------------------------

    /** The lowercase sha-256 hex form of the report identity and content digest. */
    private static final java.util.regex.Pattern REPORT_ID = Pattern.compile("[0-9a-f]{64}");

    /**
     * The stable terminal report identity of one execution (design protocol supplement):
     * lowercase SHA-256 over the UTF-8 compact JSON array
     * {@code [1, taskId, epoch, requestSha256, "terminal"]} — compact, raw Unicode,
     * unescaped slashes, preserved nulls. The TS worker computes the same bytes.
     */
    public static String terminalReportId(String taskId, long epoch, String requestSha256) {
        return sha256Hex(identityJsonBytes(java.util.Arrays.asList(
            1, taskId, epoch, requestSha256, "terminal")));
    }

    /**
     * The canonical content digest of one terminal report (design protocol supplement):
     * lowercase SHA-256 over the UTF-8 compact JSON array
     * {@code [1, reportId, state, summary, failureCode]} — server time is never part of
     * the content, so an idempotent re-delivery compares equal.
     */
    public static String terminalContentSha256(String reportId, AgentContracts.TaskState state,
                                               String summary, String failureCode) {
        if (!REPORT_ID.matcher(reportId).matches()) {
            throw new IllegalArgumentException("the report id must be a lowercase sha-256 hex string");
        }
        return sha256Hex(identityJsonBytes(java.util.Arrays.asList(
            1, reportId, state.name(), summary, failureCode)));
    }

    /**
     * The canonical identity-array bytes: exactly the ECMAScript {@code JSON.stringify}
     * semantics for an array of integers, strings and nulls — compact, raw Unicode
     * characters (supplementary pairs included), unescaped slashes, preserved nulls.
     * Jackson's default generator escapes non-BMP characters as surrogate escapes, which
     * would silently diverge from the TS worker; the identity arrays therefore never pass
     * through the shared mapper.
     */
    private static byte[] identityJsonBytes(List<Object> array) {
        StringBuilder builder = new StringBuilder("[");
        for (int i = 0; i < array.size(); i++) {
            if (i > 0) {
                builder.append(',');
            }
            appendIdentityValue(builder, array.get(i));
        }
        return builder.append(']').toString().getBytes(StandardCharsets.UTF_8);
    }

    private static void appendIdentityValue(StringBuilder builder, Object value) {
        if (value == null) {
            builder.append("null");
            return;
        }
        if (value instanceof Integer || value instanceof Long) {
            builder.append(value);
            return;
        }
        builder.append('"');
        String text = value.toString();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> builder.append("\\\"");
                case '\\' -> builder.append("\\\\");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                case '\b' -> builder.append("\\b");
                case '\f' -> builder.append("\\f");
                default -> {
                    if (c < 0x20) {
                        builder.append(String.format("\\u%04x", (int) c));
                    } else {
                        builder.append(c);
                    }
                }
            }
        }
        builder.append('"');
    }

    /** What one recordTerminal call decided: whether it created the receipt, the disposition, and the content digest. */
    public record TerminalReceipt(boolean firstReceipt, AgentContracts.TerminalDisposition disposition,
                                  String contentSha256) { }

    /** The locked task row behind one receipt decision. */
    private record ReceiptRow(String state, String failureCode, String closeReasonCode,
                              Timestamp deadlineAt, String terminalReportId, String terminalReportSha256,
                              long workerEpoch, String workerInstanceId) { }

    private static final String RECEIPT_ROW_COLUMNS = """
        state, failure_code, close_reason_code, deadline_at, terminal_report_id,
        terminal_report_sha256, worker_epoch, worker_instance_id
        """;

    private static final org.springframework.jdbc.core.RowMapper<ReceiptRow> RECEIPT_ROW_MAPPER =
        (rs, row) -> new ReceiptRow(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getTimestamp(4), rs.getString(5), rs.getString(6), rs.getLong(7), rs.getString(8));

    /**
     * Records one terminal report for the verified execution. One short transaction locks
     * the project row, then the task row, re-verifies (epoch, instance) on the locked row
     * and commits the decision BEFORE the caller acknowledges. The monitor is shared with
     * claim registration and the create reservation, so a side-effect permission can never
     * be read before the receipt and used after it.
     *
     * <ul>
     *   <li>same report id + same canonical content: idempotent ACK of the stored receipt
     *       (the disposition follows the current task decision);</li>
     *   <li>same id with different content, or a foreign report id: explicit 409;</li>
     *   <li>a stored close intent (AI_CLOSING, or a settled FAILED row): CLOSING with the
     *       late identity stored as the refused one — never a reversal, never a reason
     *       overwrite;</li>
     *   <li>the deadline reached without an earlier receipt: the budget close intent
     *       (AI_CLOSING + AI_TASK_BUDGET_EXCEEDED) is recorded from the backend clock and
     *       CLOSING is answered — no retroactive waiver from worker-supplied times;</li>
     *   <li>otherwise the report is stored and the task parked
     *       NEEDS_ATTENTION / AI_TERMINAL_PENDING, refusing every new tool registration
     *       and new side-effect creation from that commit on.</li>
     * </ul>
     */
    public synchronized TerminalReceipt recordTerminal(String taskId, long epoch, String instanceId,
                                                       String reportId, String reportJson,
                                                       AgentContracts.TaskState state,
                                                       String summary, String failureCode) {
        if (state != AgentContracts.TaskState.COMPLETED && state != AgentContracts.TaskState.FAILED) {
            throw new IllegalArgumentException("only COMPLETED or FAILED may be recorded as a terminal report");
        }
        if (!REPORT_ID.matcher(reportId).matches()) {
            throw new ApiException("AI_TERMINAL_IDENTITY", 409, "The terminal report id is malformed");
        }
        TaskOwner owner = taskOwner(taskId);
        Timestamp now = Timestamp.from(clock.instant());
        String contentSha256 = terminalContentSha256(reportId, state, summary, failureCode);
        return java.util.Objects.requireNonNull(transaction.execute(status -> {
            // Unified lock order: the project row first, then the task row.
            jdbc.query("SELECT id FROM project WHERE id = ? FOR UPDATE",
                (rs, row) -> rs.getString(1), owner.projectId());
            List<ReceiptRow> rows = jdbc.query("""
                SELECT %s FROM agent_task WHERE id = ? FOR UPDATE
                """.formatted(RECEIPT_ROW_COLUMNS), RECEIPT_ROW_MAPPER, taskId);
            if (rows.isEmpty()) {
                throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
            }
            ReceiptRow task = rows.get(0);
            // Recheck the execution identity on the locked row: a stale epoch or a foreign
            // instance never receipts anything.
            if (task.workerEpoch() != epoch) {
                throw new ApiException("AI_EPOCH_MISMATCH", 409, "The worker epoch does not match the task");
            }
            if (instanceId == null || instanceId.isBlank() || task.workerInstanceId() == null
                || !task.workerInstanceId().equals(instanceId)) {
                throw new ApiException("AI_INSTANCE_MISMATCH", 409, "The task has no matching worker binding");
            }
            if (task.terminalReportId() != null) {
                if (!reportId.equals(task.terminalReportId())
                    || !contentSha256.equals(task.terminalReportSha256())) {
                    throw new ApiException("AI_TERMINAL_MISMATCH", 409,
                        "This terminal report was already recorded with different content or identity");
                }
                return new TerminalReceipt(false, dispositionOf(task.state(), task.failureCode()),
                    contentSha256);
            }
            if ("COMPLETED".equals(task.state()) || isCloseIntent(task)) {
                // A late report to a closed/closing execution: record its identity as the
                // refused one (immutable), change nothing else, answer by the close decision.
                storeLateReceiptIdentity(taskId, reportId, reportJson, contentSha256, now);
                return new TerminalReceipt(false, dispositionOf(task.state(), task.failureCode()),
                    contentSha256);
            }
            if (task.deadlineAt() != null && !now.before(task.deadlineAt())) {
                // Close-first at the deadline: the budget close intent is persisted from
                // the backend clock in the same transaction that answers CLOSING.
                jdbc.update("""
                    UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = ?,
                        close_reason_code = ?, next_reconcile_at = ?, terminal_report_id = ?,
                        terminal_report_json = ?, terminal_report_sha256 = ?, terminal_received_at = ?,
                        updated_at = ?, reconcile_attempt = 0
                    WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                    """, CLOSING_MARKER, BUDGET_CLOSE_REASON, now, reportId, reportJson,
                    contentSha256, now, now, taskId);
                return new TerminalReceipt(false, AgentContracts.TerminalDisposition.CLOSING,
                    contentSha256);
            }
            // A pre-receipt legacy row parked by the previous backend (AI_TERMINAL_PENDING,
            // no receipt yet) accepts its first receipt here: the new terminal callback
            // attaches the durable receipt to the already-parked task (design section 4).
            int parked = jdbc.update("""
                UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = ?, summary = ?,
                    terminal_report_id = ?, terminal_report_json = ?, terminal_report_sha256 = ?,
                    terminal_received_at = ?, updated_at = ?, next_reconcile_at = ?, reconcile_attempt = 0
                WHERE id = ? AND (state IN ('QUEUED', 'RUNNING')
                    OR (state = 'NEEDS_ATTENTION' AND failure_code = ? AND terminal_report_id IS NULL))
                """, TERMINAL_PENDING_MARKER, summary, reportId, reportJson, contentSha256, now, now, now,
                taskId, TERMINAL_PENDING_MARKER);
            if (parked == 0) {
                // Fail closed: an unexpected state never claims a receipt it did not store.
                throw new ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
            }
            return new TerminalReceipt(true, AgentContracts.TerminalDisposition.RECORDED, contentSha256);
        }));
    }

    /** A NEEDS_ATTENTION close marker, a settled FAILED row, or any persisted close reason. */
    private static boolean isCloseIntent(ReceiptRow task) {
        return "FAILED".equals(task.state())
            || (task.closeReasonCode() != null && !task.closeReasonCode().isBlank())
            || ("NEEDS_ATTENTION".equals(task.state()) && CLOSING_MARKER.equals(task.failureCode()));
    }

    /** The committed disposition for a re-delivered receipt, read from the current task decision. */
    private static AgentContracts.TerminalDisposition dispositionOf(String state, String failureCode) {
        if ("COMPLETED".equals(state)) {
            return AgentContracts.TerminalDisposition.SETTLED;
        }
        if ("FAILED".equals(state)
            || ("NEEDS_ATTENTION".equals(state) && CLOSING_MARKER.equals(failureCode))) {
            return AgentContracts.TerminalDisposition.CLOSING;
        }
        return AgentContracts.TerminalDisposition.RECORDED;
    }

    /** Late reports never overwrite a stored receipt: the identity is written exactly once. */
    private void storeLateReceiptIdentity(String taskId, String reportId, String reportJson,
                                          String contentSha256, Timestamp now) {
        jdbc.update("""
            UPDATE agent_task SET terminal_report_id = ?, terminal_report_json = ?,
                terminal_report_sha256 = ?, terminal_received_at = ?, updated_at = ?
            WHERE id = ? AND terminal_report_id IS NULL
            """, reportId, reportJson, contentSha256, now, now, taskId);
    }

    /**
     * The read-only reconciliation answer for one task's stored receipt (design protocol
     * supplement): the execution identity is verified exactly as for a delivery, and the
     * answer is empty when no receipt exists (the controller maps that to 404). This
     * never starts a side effect.
     */
    public Optional<AgentContracts.TerminalAck> storedTerminalAck(String taskId, long epoch,
                                                                  String instanceId) {
        requireWorkerIdentity(taskId, epoch, instanceId);
        return storedAckRow(taskId)
            .filter(row -> row.terminalReportId() != null)
            .map(row -> new AgentContracts.TerminalAck(
                row.terminalReportId(), row.terminalReportSha256(),
                dispositionOf(row.state(), row.failureCode())));
    }

    /** The current disposition of THIS stored receipt, or empty when it is absent or different. */
    public Optional<AgentContracts.TerminalDisposition> storedTerminalDisposition(
            String taskId, String reportId, String contentSha256) {
        return storedAckRow(taskId)
            .filter(row -> reportId.equals(row.terminalReportId())
                && contentSha256.equals(row.terminalReportSha256()))
            .map(row -> dispositionOf(row.state(), row.failureCode()));
    }

    /** True while THIS receipt is the recorded one and the task still waits under the pending marker. */
    public boolean terminalReceiptParked(String taskId, String reportId, String contentSha256) {
        return storedAckRow(taskId)
            .filter(row -> reportId.equals(row.terminalReportId())
                && contentSha256.equals(row.terminalReportSha256()))
            .map(row -> "NEEDS_ATTENTION".equals(row.state())
                && TERMINAL_PENDING_MARKER.equals(row.failureCode()))
            .orElse(false);
    }

    private Optional<ReceiptRow> storedAckRow(String taskId) {
        return jdbc.query("SELECT %s FROM agent_task WHERE id = ?"
                .formatted(RECEIPT_ROW_COLUMNS), RECEIPT_ROW_MAPPER, taskId).stream().findFirst();
    }

    /** The stored receipt's normalized report — the close flow's original-failure source. */
    public Optional<StoredTerminal> storedTerminalReport(String taskId) {
        String json = jdbc.queryForObject(
            "SELECT terminal_report_json FROM agent_task WHERE id = ?", String.class, taskId);
        if (json == null || json.isBlank()) {
            return Optional.empty();
        }
        try {
            JsonNode node = JSON.readTree(json);
            String stateName = node.path("state").asText("");
            if (!"COMPLETED".equals(stateName) && !"FAILED".equals(stateName)) {
                return Optional.empty();
            }
            JsonNode failureCodeNode = node.path("failureCode");
            return Optional.of(new StoredTerminal(AgentContracts.TaskState.valueOf(stateName),
                node.path("summary").asText(null),
                failureCodeNode.isNull() || failureCodeNode.isMissingNode()
                    ? null : failureCodeNode.asText(null)));
        } catch (IOException ex) {
            throw new IllegalStateException("stored terminal report is unreadable", ex);
        }
    }

    /** The normalized report behind one stored receipt. */
    public record StoredTerminal(AgentContracts.TaskState state, String summary, String failureCode) { }

    /** The durable display-progress head seq (0 before the first item). */
    public long progressHeadSeq(String taskId) {
        return readEnvelope(taskId).lastSeq();
    }

    /** The close-flow entry state: START armed the marker now, RETRY re-enters an already armed close, SETTLED means nothing to release. */
    public enum CloseEntry { START, RETRY, SETTLED }

    /**
     * The close flow's gate-protected entry. A QUEUED/RUNNING task is marked
     * NEEDS_ATTENTION with the AI_CLOSING marker (START), which refuses every new
     * tool-call registration while the evidence is finished. A task already marked
     * AI_CLOSING by an earlier close whose evidence could not be finished answers
     * RETRY — the close may be re-driven until it provably succeeds. A task parked
     * under the pending-terminal marker (a worker verdict blocked by an unsettled
     * side effect) is armed the same way: the close is the only path that resolves
     * it. Anything else is SETTLED: an already released task never re-enters the flow.
     */
    public synchronized CloseEntry beginClose(String taskId) {
        return beginClose(taskId, null);
    }

    /**
     * The close entry with a durable reason (design section 6): the reason is persisted
     * with the FIRST close intent and never overwritten — a repeated close, a late report
     * or a restart keeps the original one. A null reason leaves the column NULL.
     */
    public synchronized CloseEntry beginClose(String taskId, String reasonCode) {
        jdbc.update("UPDATE agent_task SET next_reconcile_at = ?, reconcile_attempt = 0 WHERE id = ? AND state IN ('QUEUED','RUNNING','NEEDS_ATTENTION') AND close_reason_code IS NULL AND (failure_code IS NULL OR failure_code <> ?)",
            Timestamp.from(clock.instant()), taskId,CLOSING_MARKER);
        if (markClosing(taskId)) {
            persistCloseReason(taskId, reasonCode);
            return CloseEntry.START;
        }
        List<Row> rows = jdbc.query(
            "SELECT state, failure_code FROM agent_task WHERE id = ?",
            (rs, row) -> new Row(rs.getString(1), rs.getString(2)), taskId);
        if (rows.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        Row row = rows.get(0);
        if ("NEEDS_ATTENTION".equals(row.state()) && CLOSING_MARKER.equals(row.failureCode())) {
            persistCloseReason(taskId, reasonCode);
            return CloseEntry.RETRY;
        }
        if ("NEEDS_ATTENTION".equals(row.state())) {
            boolean armed = jdbc.update(
                "UPDATE agent_task SET failure_code = ?, updated_at = ? "
                    + "WHERE id = ? AND state = 'NEEDS_ATTENTION'",
                CLOSING_MARKER, Timestamp.from(clock.instant()), taskId) > 0;
            if (armed) {
                persistCloseReason(taskId, reasonCode);
            }
            return armed ? CloseEntry.START : CloseEntry.SETTLED;
        }
        return CloseEntry.SETTLED;
    }

    public synchronized CloseEntry beginPause(String taskId) {
        armExpiredBudget(taskId);
        var view = settlementView(taskId);
        if ("COMPLETED".equals(view.state()) || "FAILED".equals(view.state())) return CloseEntry.SETTLED;
        if (view.terminalReportId() != null && !hasCloseIntent(view)) return CloseEntry.RETRY;
        if (!hasCloseIntent(view) && reconcileCandidate(taskId).instanceId() == null) {
            throw new ApiException("AI_TASK_STARTING", 409, "Task is starting; try pausing shortly");
        }
        return beginClose(taskId, "AI_PAUSED_BY_OWNER");
    }

    /** The close reason is written exactly once: a repeat close can never overwrite it. */
    private void persistCloseReason(String taskId, String reasonCode) {
        if (reasonCode == null || reasonCode.isBlank()) {
            return;
        }
        jdbc.update("UPDATE agent_task SET close_reason_code = ?, updated_at = ? "
                + "WHERE id = ? AND close_reason_code IS NULL",
            reasonCode, Timestamp.from(clock.instant()), taskId);
    }

    private record Row(String state, String failureCode) { }

    /** Advisory only: absence, unknown states and terminal states all deny creation. */
    public boolean hasClosingIntent(String taskId) {
        List<String> states = jdbc.query("SELECT state FROM agent_task WHERE id = ?",
            (rs, row) -> rs.getString(1), taskId);
        return states.isEmpty() || !("QUEUED".equals(states.get(0)) || "RUNNING".equals(states.get(0)));
    }

    /**
     * Single-instance creation linearization point. This monitor is also held by claims,
     * markClosing and the final close proof/release. Persist a one-shot name reservation
     * before the API call; on restart even an uncertain create is observe-only. The
     * monitor covers the actual create, not merely an earlier permission read. No DB
     * transaction or ProjectLifecycleGate is held while waiting for the build.
     */
    public synchronized <T> T createBuildIfAllowed(AgentContracts.BuildRequest request,
                                                  java.util.function.Supplier<T> create) {
        int reserved = jdbc.update("""
            UPDATE agent_tool_call c INNER JOIN agent_task t ON t.id = c.task_id
            SET c.job_name = ?, c.updated_at = ?
            WHERE c.task_id = ? AND c.tool_call_id = ? AND c.workspace_operation_id = ?
              AND c.tool_name = 'build' AND c.state = 'RUNNING' AND c.job_name IS NULL
              AND t.project_id = ? AND t.state IN ('QUEUED', 'RUNNING')
            """, com.manao.poc4.kubernetes.JobResourceFactory.developmentJobName(request.commandId()),
            Timestamp.from(clock.instant()), request.taskId(), request.toolCallId(), request.commandId(),
            request.projectId());
        return reserved == 1 ? create.get() : null;
    }

    /**
     * The close flow's first, gate-protected step: a QUEUED/RUNNING task becomes
     * NEEDS_ATTENTION with the AI_CLOSING marker, which refuses every new tool-call
     * registration while the worker is stopped and the evidence is finished. False
     * when the task was already settled or already closing.
     */
    public synchronized boolean markClosing(String taskId) {
        return jdbc.update("""
                UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = ?, updated_at = ?
                WHERE id = ? AND state IN ('QUEUED', 'RUNNING')
                """,
            CLOSING_MARKER, Timestamp.from(clock.instant()), taskId) > 0;
    }

    /** The close flow's final step: only its own AI_CLOSING marker releases the project. */
    public synchronized boolean failClosedTask(String taskId, String failureCode, String summary) {
        if (hasLiveToolClaims(taskId)) return false;
        return jdbc.update("""
                UPDATE agent_task SET state = 'FAILED', failure_code = ?, summary = ?, updated_at = ?
                WHERE id = ? AND state = 'NEEDS_ATTENTION' AND failure_code = 'AI_CLOSING'
                  AND NOT EXISTS (SELECT 1 FROM agent_tool_call c
                      WHERE c.task_id = agent_task.id AND c.state = 'RUNNING')
                """,
            failureCode, summary, Timestamp.from(clock.instant()), taskId) > 0;
    }

    /** The durable worker intent remains in the frozen progress envelope through cleanup retries. */
    public Optional<AgentContracts.ProgressItem> terminalProgress(String taskId) {
        return readEnvelope(taskId).items().stream().filter(item -> "terminal".equals(item.kind()))
            .reduce((first, last) -> last);
    }

    // ------------------------------------------------------------------
    // Durable settlement (repair design section 6). reconcile(taskId) in
    // AgentTaskSettlementService drives every stored receipt, user close
    // and budget close through the existing business verification. These
    // primitives give that driver a consistent read of the durable row,
    // the receipt-identity completion CAS, and the deferral marker for
    // the next round. Same lock discipline as recordTerminal: the store
    // monitor covers the whole decision; a CAS UPDATE touches the task
    // row and its subqueries only — never a project row after a task row.
    // ------------------------------------------------------------------

    /** The durable row behind one settlement decision: state, close intent and receipt identity. */
    public record SettlementView(String state, String failureCode, String closeReasonCode,
                                 String terminalReportId, String terminalReportSha256) { }

    public record ReconcileCandidate(String taskId, long epoch, String instanceId, String requestSha256,
                                      java.time.Instant nextReconcileAt) { }

    /** NULL scheduling rows are legacy active tasks, never historical released rows. */
    public List<ReconcileCandidate> dueReconciliations(int limit) {
        return jdbc.query("""
            SELECT id,worker_epoch,worker_instance_id,request_sha256,next_reconcile_at FROM agent_task
            WHERE state IN ('QUEUED','RUNNING','NEEDS_ATTENTION')
              AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
            ORDER BY next_reconcile_at,id LIMIT ?
            """, (rs,row) -> new ReconcileCandidate(rs.getString(1),rs.getLong(2),rs.getString(3),rs.getString(4),
                rs.getTimestamp(5)==null ? null : rs.getTimestamp(5).toInstant()),
            Timestamp.from(clock.instant()), Math.min(10,Math.max(1,limit)));
    }

    public ReconcileCandidate reconcileCandidate(String taskId) {
        return jdbc.queryForObject("SELECT id,worker_epoch,worker_instance_id,request_sha256,next_reconcile_at FROM agent_task WHERE id=?",
            (rs,row) -> new ReconcileCandidate(rs.getString(1),rs.getLong(2),rs.getString(3),rs.getString(4),
                rs.getTimestamp(5)==null ? null : rs.getTimestamp(5).toInstant()),taskId);
    }

    /** Receipt/close races resolve in this single CAS; only no-receipt tasks can be budget closed. */
    public synchronized boolean armExpiredBudget(String taskId) {
        Timestamp now=Timestamp.from(clock.instant());
        return jdbc.update("""
            UPDATE agent_task SET state='NEEDS_ATTENTION',failure_code=?,close_reason_code=?,
                next_reconcile_at=?,updated_at=?,reconcile_attempt=0 WHERE id=?
              AND state IN ('QUEUED','RUNNING','NEEDS_ATTENTION')
              AND terminal_report_id IS NULL AND close_reason_code IS NULL
              AND (failure_code IS NULL OR failure_code<>?)
              AND deadline_at IS NOT NULL AND deadline_at<=?
            """,CLOSING_MARKER,BUDGET_CLOSE_REASON,now,now,taskId,CLOSING_MARKER,now)>0;
    }

    /** The authenticated replacement observation only arms the original close flow. */
    public synchronized boolean beginWorkerRestartClose(String taskId, long epoch, String expectedInstanceId) {
        Timestamp now = Timestamp.from(clock.instant());
        return jdbc.update("""
            UPDATE agent_task SET state='NEEDS_ATTENTION', failure_code='AI_CLOSING',
                close_reason_code='AI_WORKER_RESTARTED', next_reconcile_at=?, updated_at=?, reconcile_attempt=0
            WHERE id=? AND worker_epoch=? AND worker_instance_id=?
              AND deadline_at IS NOT NULL AND deadline_at>?
              AND state IN ('QUEUED','RUNNING','NEEDS_ATTENTION')
              AND terminal_report_id IS NULL AND close_reason_code IS NULL
              AND (failure_code IS NULL OR failure_code<>'AI_CLOSING')
            """, now, now, taskId, epoch, expectedInstanceId, now) == 1;
    }

    /** Attempt accounting is independent of progress timestamps and survives backend restart. */
    public void deferReconcile(String taskId) {
        Timestamp now=Timestamp.from(clock.instant());
        jdbc.update("""
            UPDATE agent_task SET next_reconcile_at=TIMESTAMPADD(SECOND,
                LEAST(30,5*POW(2,LEAST(reconcile_attempt,3))),?),updated_at=?,
                reconcile_attempt=LEAST(reconcile_attempt+1,4)
            WHERE id=? AND state IN ('QUEUED','RUNNING','NEEDS_ATTENTION')
            """,now,now,taskId);
    }

    /** The consistent settlement read of one task; unknown ids are a 404. */
    public SettlementView settlementView(String taskId) {
        List<SettlementView> rows = jdbc.query("""
            SELECT state, failure_code, close_reason_code, terminal_report_id, terminal_report_sha256
            FROM agent_task WHERE id = ?
            """, (rs, row) -> new SettlementView(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), rs.getString(5)), taskId);
        if (rows.isEmpty()) {
            throw new ApiException("AI_TASK_NOT_FOUND", 404, "Task not found");
        }
        return rows.get(0);
    }

    /** True while the row carries any persisted close intent: reason, close marker or settled FAILED. */
    public static boolean hasCloseIntent(SettlementView view) {
        return "FAILED".equals(view.state())
            || (view.closeReasonCode() != null && !view.closeReasonCode().isBlank())
            || ("NEEDS_ATTENTION".equals(view.state()) && CLOSING_MARKER.equals(view.failureCode()));
    }

    /** True while any task-linked workspace receipt is still PENDING (an unverified file write). */
    public boolean hasPendingReceipts(String taskId) {
        Integer count = jdbc.queryForObject("""
            SELECT COUNT(*) FROM agent_tool_call c
            JOIN workspace_operation w ON w.id = c.workspace_operation_id
            WHERE c.task_id = ? AND w.state = 'PENDING'
            """, Integer.class, taskId);
        return count != null && count > 0;
    }

    /**
     * The deferral of one settlement round (design section 6): the still-occupying task
     * is marked for the next reconcile pass. The interval is this round's engineering
     * default on the scheduler's 5s cadence; the scheduler (later task) owns the backoff
     * policy on top of it.
     */
    public static final long RECONCILE_DEFER_MILLIS = 5000;

    public void scheduleReconcile(String taskId) {
        jdbc.update("""
            UPDATE agent_task SET next_reconcile_at = ?, updated_at = ?
            WHERE id = ? AND state IN ('QUEUED', 'RUNNING', 'NEEDS_ATTENTION')
            """,
            Timestamp.from(clock.instant().plusMillis(RECONCILE_DEFER_MILLIS)),
            Timestamp.from(clock.instant()), taskId);
    }

    /**
     * The parked receipt's completion CAS (repair plan task 3): the ONE atomic statement
     * that settles a task parked under the pending-terminal marker from ITS OWN stored
     * receipt. The WHERE matches the receipt identity AND the canonical content digest
     * (a foreign report never completes), requires the parked marker itself (an armed
     * close intent — reason, close marker or settled FAILED — can never be overridden),
     * and re-verifies every durable side effect in the same statement: no unsettled tool
     * call and no task-linked PENDING workspace receipt. Zero affected rows mean a close
     * won the race, an effect is still undecided, or the task already settled — the
     * caller defers and re-reads instead of assuming.
     */
    public synchronized boolean completeFromReceipt(String taskId, String reportId, String contentSha256,
                                                    String summary, String failureCode) {
        Timestamp now = Timestamp.from(clock.instant());
        return jdbc.update("""
            UPDATE agent_task
            SET state = 'COMPLETED', summary = ?, failure_code = ?, updated_at = ?
            WHERE id = ? AND state = 'NEEDS_ATTENTION' AND failure_code = ?
              AND terminal_report_id = ? AND terminal_report_sha256 = ?
              AND close_reason_code IS NULL
              AND NOT EXISTS (SELECT 1 FROM agent_tool_call c
                  WHERE c.task_id = agent_task.id
                    AND c.state IN ('REGISTERED', 'RUNNING', 'NEEDS_ATTENTION'))
              AND NOT EXISTS (SELECT 1 FROM agent_tool_call c2
                  JOIN workspace_operation w ON w.id = c2.workspace_operation_id
                  WHERE c2.task_id = agent_task.id AND w.state = 'PENDING')
            """, summary, failureCode, now, taskId, TERMINAL_PENDING_MARKER, reportId,
            contentSha256) > 0;
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
            SELECT t.id, t.request_sha256, t.state, t.worker_epoch, t.workspace_revision,
                   t.settled_revision, t.changed_paths_json, t.progress_json, t.summary,
                   t.failure_code, t.active_project, t.conversation_id, t.reasoning_effort, t.close_reason_code
            FROM agent_task t INNER JOIN project p ON p.id = t.project_id
            WHERE p.owner_id = ? AND t.project_id = ? %s
            """.formatted(extraCondition);
        List<Object> parameters = new ArrayList<>();
        parameters.add(ownerId);
        parameters.add(projectId);
        parameters.addAll(List.of(extraArgs));
        List<TaskRow> rows = jdbc.query(sql, (rs, row) -> new TaskRow(
            rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
            rs.getLong(5), (Long) rs.getObject(6), rs.getString(7),
            rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11) != null, rs.getString(12), rs.getString(13), rs.getString(14)),
            parameters.toArray());
        return rows.stream().findFirst().map(this::snapshot);
    }

    private Optional<TaskRow> findTaskById(String taskId) {
        List<TaskRow> rows = jdbc.query("""
            SELECT id, request_sha256, state, worker_epoch, workspace_revision, settled_revision,
                   changed_paths_json, progress_json, summary, failure_code, active_project, conversation_id, reasoning_effort, close_reason_code
            FROM agent_task WHERE id = ?
            """, (rs, row) -> new TaskRow(
            rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
            rs.getLong(5), (Long) rs.getObject(6), rs.getString(7),
            rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11) != null, rs.getString(12), rs.getString(13), rs.getString(14)), taskId);
        return rows.stream().findFirst();
    }

    /**
     * Records one verified write settlement on the task row (review fix I1): the latest
     * verified revision becomes the snapshot's workspace revision and the changed path
     * accumulates deduplicated. The creation-time {@code workspace_revision} column is
     * never touched — it stays the initial version the submission was made against. A
     * stale settlement (an older revision, e.g. a receipt replay) never regresses the
     * snapshot. Unknown task ids are ignored: the write settled, and recording must not
     * turn a settled write into an undecided call.
     */
    public void recordVerifiedWrite(String taskId, String path, long revision) {
        transaction.executeWithoutResult(status -> {
            List<Long> settled = jdbc.query(
                "SELECT settled_revision FROM agent_task WHERE id = ? FOR UPDATE",
                (rs, row) -> rs.getObject(1) == null ? null : rs.getLong(1), taskId);
            if (settled.isEmpty()) {
                return;
            }
            Long current = settled.get(0);
            if (current != null && revision <= current) {
                return;
            }
            List<String> paths = new ArrayList<>(changedPaths(jdbc.queryForObject(
                "SELECT changed_paths_json FROM agent_task WHERE id = ?", String.class, taskId)));
            if (!paths.contains(path)) {
                paths.add(path);
                while (paths.size() > MAX_CHANGED_PATHS) {
                    paths.remove(0);
                }
            }
            jdbc.update(
                "UPDATE agent_task SET settled_revision = ?, changed_paths_json = ?, updated_at = ? WHERE id = ?",
                revision, changedPathsJson(paths), Timestamp.from(clock.instant()), taskId);
        });
    }

    private static List<String> changedPaths(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            JsonNode array = JSON.readTree(json);
            List<String> paths = new ArrayList<>();
            if (array.isArray()) {
                for (JsonNode node : array) {
                    paths.add(node.asText());
                }
            }
            return paths;
        } catch (IOException ex) {
            throw new IllegalStateException("stored changed paths are unreadable", ex);
        }
    }

    private static String changedPathsJson(List<String> paths) {
        try {
            return JSON.writeValueAsString(paths);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the changed paths", ex);
        }
    }

    private AgentContracts.TaskSnapshot snapshot(TaskRow row) {
        boolean writesLocked = row.active() && OCCUPYING_STATES.contains(row.state());
        // The snapshot revision is the latest VERIFIED write revision; before the first
        // settled write it is the creation revision the submission was made against.
        String revision = row.settledRevision() != null
            ? Long.toString(row.settledRevision()) : Long.toString(row.workspaceRevision());
        return new AgentContracts.TaskSnapshot(row.id(), AgentContracts.TaskState.valueOf(row.state()),
            revision, writesLocked, parseProgress(row.progressJson()),
            changedPaths(row.changedPathsJson()), row.summary(), row.failureCode(), row.conversationId(), row.reasoningEffort(), row.closeReasonCode());
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

    /** Refuses AI writes/builds while any durable application Run is active. */
    public void requireNoActiveRun(String projectId) {
        if (hasActiveRun(projectId)) {
            throw new ApiException("AI_RUN_ACTIVE", 409, "Stop the application before editing or building");
        }
    }

    private static boolean isApplicationStart(String argsJson) {
        try {
            return "start".equals(JSON.readTree(argsJson == null ? "{}" : argsJson).path("action").asText());
        } catch (IOException ex) {
            return false;
        }
    }

    /** Calls include completed starts: close must still find every Run this task created. */
    public List<ToolCallRow> applicationCalls(String taskId) {
        return jdbc.query("SELECT " + TOOL_CALL_COLUMNS
            + " FROM agent_tool_call WHERE task_id = ? AND tool_name = 'application'",
            toolCallRowMapper(), taskId);
    }

    /**
     * Checks durable task/project ownership and the original application action/target.
     * The caller holds the project gate and this monitor until the Run insert completes.
     * Application dispatch keeps its live execution claim through the subsequent slow IO.
     */
    @Override public synchronized void requireAgentRunCall(String taskId, String projectId,
                                                           String toolCallId, String action, String runId) {
        List<Row> tasks = jdbc.query("""
            SELECT t.state, t.failure_code FROM agent_task t JOIN project p ON p.id = t.project_id
            WHERE t.id = ? AND t.project_id = ? AND t.owner_id = p.owner_id
            """, (rs, i) -> new Row(rs.getString(1), rs.getString(2)), taskId, projectId);
        ToolCallRow call = findToolCall(taskId, toolCallId).orElse(null);
        if (tasks.isEmpty() || call == null || !"application".equals(call.toolName()) || runId == null) {
            throw unauthorizedRunCall();
        }
        Row task = tasks.get(0);
        boolean accepting = "QUEUED".equals(task.state()) || "RUNNING".equals(task.state());
        boolean closing = "NEEDS_ATTENTION".equals(task.state()) && CLOSING_MARKER.equals(task.failureCode());
        if ((!accepting && !closing)
            || !List.of("REGISTERED", "RUNNING", "COMPLETED", "NEEDS_ATTENTION").contains(call.state())
            || (!closing && "NEEDS_ATTENTION".equals(call.state()))) {
            throw unauthorizedRunCall();
        }
        try {
            JsonNode args = JSON.readTree(call.argsJson() == null ? "{}" : call.argsJson());
            boolean registeredStart = "start".equals(args.path("action").asText())
                && runId.equals(call.workspaceOperationId()) && TASK_ID.matcher(runId).matches();
            boolean registeredStop = "stop".equals(args.path("action").asText())
                && runId.equals(args.path("runId").asText());
            if ("start".equals(action)) {
                if (!accepting || !registeredStart
                    || !("REGISTERED".equals(call.state()) || "RUNNING".equals(call.state()))) {
                    throw unauthorizedRunCall();
                }
                if (hasUnsettledCallOtherThan(taskId, toolCallId)) {
                    throw new ApiException("AI_CALL_UNSETTLED", 409, "An earlier tool call has not settled");
                }
                // Fence close before the first Run insert, including callers that have not
                // yet claimed the application dispatch. This never creates a second identity.
                jdbc.update("UPDATE agent_tool_call SET state = 'RUNNING', updated_at = ? "
                    + "WHERE task_id = ? AND tool_call_id = ? AND state = 'REGISTERED'",
                    Timestamp.from(clock.instant()), taskId, toolCallId);
            } else if (!"stop".equals(action) || !(registeredStop || (closing && registeredStart))) {
                throw unauthorizedRunCall();
            }
        } catch (IOException ex) {
            throw unauthorizedRunCall();
        }
    }

    private static ApiException unauthorizedRunCall() {
        return new ApiException("AI_TASK_NOT_ACTIVE", 409, "Task call is not authorized");
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
        if (request.reasoningEffort() != null && !java.util.Set.of("off", "low", "high", "max").contains(request.reasoningEffort())) throw validation();
    }

    /**
     * The request identity: SHA-256 over the fixed-field-order JSON of taskId, ownerId,
     * projectId, prompt and expectedRevision — the same bytes for the same intent, different
     * bytes for any different request.
     */
    private static String requestSha256(String ownerId, String projectId,
                                        AgentContracts.TaskRequest request, String conversationId, boolean legacy) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("taskId", request.taskId());
        fields.put("ownerId", ownerId);
        fields.put("projectId", projectId);
        fields.put("prompt", request.prompt());
        fields.put("expectedRevision", request.expectedRevision());
        if (conversationId != null) fields.put("conversationId", conversationId);
        if (!legacy) fields.put("reasoningEffort", request.reasoningEffort() == null ? "high" : request.reasoningEffort());
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

    private record ProjectRow(String ownerId, String state, long workspaceRevision) { }

    /**
     * The durable task row as the snapshot mapper sees it: {@code active} is the occupancy,
     * {@code settledRevision}/{@code changedPathsJson} carry the verified write ledger
     * (both null until the first verified write settles), and {@code workerEpoch} is the
     * exactly-once fencing epoch persisted at creation.
     */
    private record TaskRow(String id, String requestSha256, String state, long workerEpoch,
                           long workspaceRevision, Long settledRevision, String changedPathsJson,
                           String progressJson, String summary, String failureCode, boolean active, String conversationId, String reasoningEffort, String closeReasonCode) { }
}
