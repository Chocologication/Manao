package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.ai.AgentContracts.ProgressItem;
import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.ai.AgentContracts.TaskSnapshot;
import com.manao.poc4.ai.AgentContracts.TaskState;
import com.manao.poc4.ai.AgentContracts.ToolRequest;
import com.manao.poc4.ai.AgentContracts.ToolResult;
import com.manao.poc4.ai.AgentContracts.WorkerStart;
import com.manao.poc4.ai.AgentContracts.WorkerStatus;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * The stage-one task lifecycle over the durable store (design section 6). A browser
 * submission creates the task and its fencing epoch — persisted exactly once, at
 * creation — inside the shared project gate before the worker is called; the first
 * correct (instance, epoch) callback or start ACK binds the running session atomically;
 * progress is a monotonic, idempotent sequence whose terminal item applies the
 * worker-reported verdict ONLY after every tool side effect has settled (the store's
 * unified terminal arbitration keeps the project occupied otherwise, and the unified
 * settlement driver is the only path that resolves such a pending verdict). A
 * re-submission of the same request answers the ORIGINAL task without re-driving,
 * re-fencing or re-prompting it; a lost start response is reconciled by a status read
 * of the same task inside that one submission — never by a second task id or a second
 * session. The close flow persists its intent first and finishes in bounded re-entrant
 * settlement steps (repair design section 6) — it never waits on a run.
 */
public final class AgentTaskService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> OCCUPYING = Set.of("QUEUED", "RUNNING", "NEEDS_ATTENTION");

    private final AgentTaskStore tasks;
    private final ProjectLifecycleGate lifecycle;
    private final PiWorkerClient worker;
    private final AgentProjectTools tools;
    private final AgentConversationService conversations;
    /** The unified settlement driver: receipts, user closes and budget closes all settle here. */
    private final AgentTaskSettlementService settlement;

    public AgentTaskService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle, PiWorkerClient worker,
                            AgentProjectTools tools) {
        this(tasks, lifecycle, worker, tools, null);
    }
    public AgentTaskService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle, PiWorkerClient worker,
                            AgentProjectTools tools, AgentConversationService conversations) {
        this.tasks = tasks;
        this.lifecycle = lifecycle;
        this.worker = worker;
        this.tools = tools;
        this.conversations = conversations;
        this.settlement = new AgentTaskSettlementService(tasks, lifecycle, worker, tools);
    }

    /**
     * The browser's task submission. The gate covers the durable creation (with its
     * exactly-once fencing epoch) and nothing else; the worker call runs outside the gate
     * so no browser request holds the project lock across a network hop. A re-submission
     * of the same request returns the original task untouched — no epoch bump, no start,
     * no second model session; a lost start response is reconciled inside the FIRST
     * submission's own drive by a status read of the same task.
     */
    public TaskSnapshot submit(String ownerId, String projectId, TaskRequest request) {
        return submit(ownerId, projectId, request, null);
    }

    public TaskSnapshot submit(String ownerId, String projectId, TaskRequest request, String conversationId) {
        if (conversations != null) conversations.reconcileProject(ownerId, projectId);
        AgentTaskStore.TaskCreation creation;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            creation = tasks.createTask(ownerId, projectId, request, conversationId);
        }
        if (!creation.created()) {
            // The original task is the whole answer: its start was driven (or reconciled)
            // by the submission that created it, and its verdict belongs to that attempt.
            return creation.snapshot();
        }
        if (!OCCUPYING.contains(creation.snapshot().state().name())) {
            return creation.snapshot();
        }
        driveStart(request.taskId(), request.prompt(), creation.snapshot().workspaceRevision(),
            creation.epoch(), conversationId, creation.snapshot().reasoningEffort());
        return creation.snapshot();
    }

    /** One task by id, visible only through the owner's project. */
    public Optional<TaskSnapshot> findForOwner(String ownerId, String projectId, String taskId) {
        return tasks.findForOwner(ownerId, projectId, taskId);
    }

    /** The task that currently owns the project's writes, if any. */
    public Optional<TaskSnapshot> currentForOwner(String ownerId, String projectId) {
        return tasks.currentForOwner(ownerId, projectId);
    }

    /**
     * Re-drives the start under the persisted epoch; the ACK binds QUEUED to RUNNING.
     * A start whose outcome is unknown (transport failure) is reconciled against the
     * worker with a status read of the SAME task before the task is left undecided —
     * the worker may already be running a session nobody bound.
     */
    private void driveStart(String taskId, String prompt, String workspaceRevision, long epoch, String conversationId, String reasoningEffort) {
        WorkerStart start = new WorkerStart(taskId, prompt, workspaceRevision,
            tasks.requestSha256Of(taskId), epoch, conversationId, reasoningEffort);
        try {
            WorkerStatus ack = worker.start(start);
            onStartAck(taskId, epoch, ack);
            return;
        } catch (ApiException ex) {
            if ("AI_WORKER_NOT_CONFIGURED".equals(ex.code()) || "AI_REASONING_UNSUPPORTED".equals(ex.code())) {
                // The worker refuses before any session exists: fail the task now, release it.
                close(taskId, ex.code(), "the worker refused the configured model before starting");
                return;
            }
            // Unreachable or transient: fall through to the explicit reconciliation below.
        }
        try {
            // The start response was lost: ask the worker about the ORIGINAL task and
            // branch on the reported state — never blindly bind RUNNING over a worker
            // that already settled.
            WorkerStatus status = worker.status(taskId);
            if ("RUNNING".equals(status.state())) {
                // A running session is bound under the current epoch, so its callbacks
                // are accepted instead of silently refused.
                tasks.bindWorkerInstance(taskId, epoch, status.instanceId());
            } else if ("COMPLETED".equals(status.state()) || "FAILED".equals(status.state())) {
                // A state alone cannot decide the outcome or authorize a close. The
                // unified path settles a parked receipt or imports the authenticated
                // same-execution report, preserving successful READY applications.
                settlement.reconcile(taskId);
            }
            // An unclear state leaves the task QUEUED with its persisted epoch, an
            // explicit undecided state for scheduled reconciliation or owner close.
        } catch (RuntimeException reconcileFailure) {
            // Unresolved evidence retains the persisted identity and occupancy for
            // scheduled reconciliation or owner close, never a second start.
        }
    }

    /** A start ACK under the current epoch binds the instance; a late ACK cannot regress. */
    public void onStartAck(String taskId, long epoch, WorkerStatus ack) {
        tasks.bindWorkerInstance(taskId, epoch, ack.instanceId());
    }

    /** One project-tool invocation from the worker, after the fencing identity check. */
    public ToolResult invokeTool(String taskId, String toolCallId, String instanceId, long epoch,
                                 ToolRequest request) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        if (request == null || !toolCallId.equals(request.toolCallId())) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        return tools.invoke(taskId, request);
    }

    /**
     * The internal reconciliation answer for one call: absent (unknown id), executing
     * or undecided (RUNNING / NEEDS_ATTENTION, no result), or settled (COMPLETED with
     * the durable result). An executing build is never misread as an unregistered
     * submission (review fix I3).
     */
    public Optional<AgentContracts.ToolCallStatus> toolCallStatus(String taskId, String toolCallId,
                                                                  String instanceId, long epoch) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        return tools.callStatus(taskId, toolCallId);
    }

    /**
     * One progress item from the bound worker. A terminal item never enters the gate or
     * the seq check: it is diverted to the receipt entry (design section 4), receipted
     * without the project gate, and settled by the delivery rules below. Ordinary items
     * keep the monotonic, idempotent envelope under the gate.
     */
    public void applyProgress(String taskId, String instanceId, long epoch, ProgressItem item) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        if ("terminal".equals(item.kind())) {
            applyLegacyTerminal(taskId, instanceId, epoch, item);
            return;
        }
        var owner = tasks.taskOwner(taskId);
        try (var lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            synchronized (tasks) {
                tasks.appendProgress(taskId, item);
            }
        }
    }

    /**
     * The legacy progress terminal (design section 4 compatibility): diverted to the
     * receipt entry BEFORE the project gate and the seq check, so an authenticated
     * terminal is receipted even while the gate is contended or a display message was
     * lost — and the missing message is never fabricated. The report identity is the
     * stable legacy id the receipt entry derives for this execution. The settlement
     * follows the delivery: a first receipt that arrived in-order through an available
     * gate settles exactly as before, and a re-delivery of the recorded receipt (the
     * repaired worker's retry) carries the settlement.
     */
    private void applyLegacyTerminal(String taskId, String instanceId, long epoch, ProgressItem item) {
        if (item.seq() < 1) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        if (item.text() == null
            || item.text().getBytes(java.nio.charset.StandardCharsets.UTF_8).length
                > AgentTaskStore.MAX_PROGRESS_TEXT_BYTES) {
            throw new ApiException("AI_PROGRESS_TOO_LARGE", 422, "Progress item exceeds the 8 KiB bound");
        }
        AgentTaskSettlementService.TerminalReport report = AgentTaskSettlementService.parseTerminal(item.text());
        String reportId = AgentTaskStore.terminalReportId(taskId, epoch, tasks.requestSha256Of(taskId));
        var receipt = tasks.recordTerminal(taskId, epoch, instanceId, reportId,
            receiptJson(report.state(), report.summary(), report.failureCode()),
            report.state(), report.summary(), report.failureCode());
        boolean inOrder = item.seq() == tasks.progressHeadSeq(taskId) + 1;
        if ((receipt.firstReceipt() && inOrder)
            || (!receipt.firstReceipt() && receipt.disposition() == AgentContracts.TerminalDisposition.RECORDED)) {
            settlement.settleParkedTerminal(taskId, reportId, receipt.contentSha256(),
                report.state(), report.summary(), report.failureCode());
        }
    }

    /**
     * The durable terminal receipt entry (repair design section 4): no project memory
     * gate, no Kubernetes/Worker IO. One short transaction locks the project row then the
     * task row, re-verifies the execution identity, and commits the decision before the
     * ACK: the same report id with the same canonical content always acknowledges (even
     * after the task settled), different content or a foreign identity is an explicit
     * 409, a stored close intent answers CLOSING, a deadline reached without an earlier
     * receipt records the budget close, and otherwise the report parks the task under
     * NEEDS_ATTENTION / AI_TERMINAL_PENDING. A re-delivery of a parked receipt carries
     * the settlement. The 200 answer means the durable decision is committed — never
     * that the task itself has settled.
     */
    public AgentContracts.TerminalAck recordTerminal(String taskId, String instanceId, long epoch,
                                                     AgentContracts.TerminalReport report) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        if (report == null || report.protocolVersion() != 1 || report.reportId() == null
            || (report.state() != TaskState.COMPLETED && report.state() != TaskState.FAILED)
            || report.summary() == null) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        // The complete terminal JSON is bounded at 8 KiB INCLUDING escaping overhead —
        // the same serialized form the worker's fitSummary guarantees (design contract 4).
        if (terminalContentBytes(report.state(), report.summary(), report.failureCode())
            > AgentTaskStore.MAX_PROGRESS_TEXT_BYTES) {
            throw new ApiException("AI_TERMINAL_TOO_LARGE", 422,
                "Terminal report exceeds the 8 KiB bound");
        }
        String reportId = AgentTaskStore.terminalReportId(taskId, epoch, tasks.requestSha256Of(taskId));
        if (!reportId.equals(report.reportId())) {
            throw new ApiException("AI_TERMINAL_IDENTITY", 409,
                "The terminal report id does not match this execution");
        }
        var receipt = tasks.recordTerminal(taskId, epoch, instanceId, reportId,
            receiptJson(report.state(), report.summary(), report.failureCode()),
            report.state(), report.summary(), report.failureCode());
        if (!receipt.firstReceipt() && receipt.disposition() == AgentContracts.TerminalDisposition.RECORDED) {
            settlement.settleParkedTerminal(taskId, reportId, receipt.contentSha256(),
                report.state(), report.summary(), report.failureCode());
        }
        AgentContracts.TerminalDisposition disposition = tasks
            .storedTerminalDisposition(taskId, reportId, receipt.contentSha256())
            .orElse(receipt.disposition());
        return new AgentContracts.TerminalAck(reportId, receipt.contentSha256(), disposition);
    }

    /** The read-only reconciliation ACK of the stored receipt; empty when none exists. */
    public Optional<AgentContracts.TerminalAck> storedTerminalAck(String taskId, String instanceId,
                                                                  long epoch) {
        return tasks.storedTerminalAck(taskId, epoch, instanceId);
    }

    /**
     * The owner browser's read of one settled tool call (review fix I9): the
     * owner/project scoping is the boundary — a foreign task id reads as 404 — and
     * only a settled call answers, with bounded data and no internal identity.
     */
    public AgentContracts.AgentToolCallView browserToolCall(String ownerId, String projectId,
                                                            String taskId, String toolCallId) {
        tasks.findForOwner(ownerId, projectId, taskId).orElseThrow(
            () -> new ApiException("ENTRY_NOT_FOUND", 404, "Task not found"));
        return tools.browserToolCall(taskId, toolCallId)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Call not found"));
    }

    /**
     * The fast close (repair design section 6): inside the gate the close intent is
     * persisted first — the task is marked NEEDS_ATTENTION with the AI_CLOSING marker
     * (which refuses every new tool registration from this moment) and the durable
     * close reason is written exactly once — then ONE bounded, re-entrant settlement
     * step finishes the evidence and answers immediately. The caller's snapshot after
     * this call may still be NEEDS_ATTENTION: that means accepted, not yet confirmed
     * finished — the settlement continues (the next close, the reconcile scan) until
     * every piece of evidence is provably finished and the project is released. No step
     * here waits on a run or holds the gate across external IO; a repeated close keeps
     * the original reason and a settled task is a final no-op.
     */
    public void close(String taskId, String failureCode, String summary) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        AgentTaskStore.CloseEntry entry;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            entry = tasks.beginClose(taskId, failureCode);
        }
        if (entry == AgentTaskStore.CloseEntry.SETTLED) {
            return;
        }
        // START (marker armed now) or RETRY (an earlier close left the evidence
        // unknown): re-drive the finishing idempotently — the worker stop and every
        // evidence check may repeat until they provably succeed.
        settlement.settleCloseIntent(taskId, failureCode, summary);
    }

    /** Persist the fixed owner pause intent; the existing reconciler drives all external work. */
    public void pause(String taskId) {
        var owner = tasks.taskOwner(taskId);
        try (var lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            tasks.beginPause(taskId);
        }
    }

    /** The normalized durable receipt JSON: protocol version plus the report fields. */
    private static String receiptJson(TaskState state, String summary, String failureCode) {
        var node = JSON.createObjectNode()
            .put("protocolVersion", 1)
            .put("state", state.name())
            .put("summary", summary);
        if (failureCode == null) {
            node.putNull("failureCode");
        } else {
            node.put("failureCode", failureCode);
        }
        return node.toString();
    }

    /** The UTF-8 byte length of the complete serialized report — the form fitSummary bounds. */
    private static int terminalContentBytes(TaskState state, String summary, String failureCode) {
        var node = JSON.createObjectNode().put("state", state.name()).put("summary", summary);
        if (failureCode == null) {
            node.putNull("failureCode");
        } else {
            node.put("failureCode", failureCode);
        }
        return node.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }
}
