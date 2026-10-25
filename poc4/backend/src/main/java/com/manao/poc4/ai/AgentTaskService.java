package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
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
import java.io.IOException;
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
 * unified terminal arbitration keeps the project occupied otherwise, and the close
 * flow is the only path that resolves such a pending verdict). A re-submission of the
 * same request answers the ORIGINAL task without re-driving, re-fencing or re-prompting
 * it; a lost start response is reconciled by a status read of the same task inside that
 * one submission — never by a second task id or a second session.
 */
public final class AgentTaskService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> OCCUPYING = Set.of("QUEUED", "RUNNING", "NEEDS_ATTENTION");

    private final AgentTaskStore tasks;
    private final ProjectLifecycleGate lifecycle;
    private final PiWorkerClient worker;
    private final AgentProjectTools tools;
    private final AgentConversationService conversations;

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
                // The worker settled but no terminal ever reached the ledger durably:
                // no outcome is fabricated and RUNNING is never bound over the settled
                // worker — the explicit undecided state (occupied, new calls refused)
                // only the re-entrant close flow can resolve.
                tasks.beginClose(taskId);
            }
            // An unclear state leaves the task QUEUED with its persisted epoch, an
            // explicit undecided state that only a re-drive of the same request or the
            // close flow can resolve.
        } catch (RuntimeException reconcileFailure) {
            // Both calls failed: the task keeps its persisted epoch and stays QUEUED —
            // an explicit undecided state that only a re-drive of the same request or
            // the close flow can resolve.
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
        TerminalReport report = parseTerminal(item.text());
        String reportId = AgentTaskStore.terminalReportId(taskId, epoch, tasks.requestSha256Of(taskId));
        var receipt = tasks.recordTerminal(taskId, epoch, instanceId, reportId,
            receiptJson(report.state(), report.summary(), report.failureCode()),
            report.state(), report.summary(), report.failureCode());
        boolean inOrder = item.seq() == tasks.progressHeadSeq(taskId) + 1;
        if ((receipt.firstReceipt() && inOrder)
            || (!receipt.firstReceipt() && receipt.disposition() == AgentContracts.TerminalDisposition.RECORDED)) {
            settleParkedTerminal(taskId, reportId, receipt.contentSha256(), report);
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
            settleParkedTerminal(taskId, reportId, receipt.contentSha256(),
                new TerminalReport(report.state(), report.summary(), report.failureCode()));
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
     * The settlement decision for a receipt that is parked under the pending marker:
     * FAILED reports re-enter the close flow, reports over unsettled side effects stay
     * parked, and a clear report settles by the store's atomic CAS. The decision needs
     * the project gate; a busy gate leaves the receipt parked for the next re-delivery
     * or the reconcile scan — the refusal is never projected onto the worker.
     */
    private void settleParkedTerminal(String taskId, String reportId, String contentSha256,
                                      TerminalReport report) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        var lease = lifecycle.tryAcquire(owner.projectId());
        if (lease.isEmpty()) {
            return;
        }
        boolean failed = false;
        try (ProjectLifecycleGate.Lease gateLease = lease.get()) {
            synchronized (tasks) {
                if (!tasks.terminalReceiptParked(taskId, reportId, contentSha256)) {
                    return;
                }
                if (report.state() == TaskState.FAILED) {
                    tasks.beginClose(taskId, report.failureCode());
                    failed = true;
                } else if (tasks.hasLiveToolClaims(taskId) || !tools.applicationCanRelease(taskId, true)) {
                    // Side effects still unsettled: the receipt stays parked for the close
                    // flow or the reconcile scan; the project keeps its occupancy.
                } else {
                    tasks.applyTerminal(taskId, report.state(), report.summary(), report.failureCode());
                }
            }
        }
        if (failed) close(taskId, report.failureCode(), report.summary());
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
     * The close flow: inside the gate the task is marked NEEDS_ATTENTION with the
     * AI_CLOSING marker (which refuses every new tool registration from this moment),
     * then the worker is stopped and the evidence is finished. The project is
     * released ONLY when every applicable piece of evidence is provably finished —
     * every workspace file receipt verified through the shared reconcile path and
     * every build proven either closed with confirmed cleanup or never created. Any
     * unknown state keeps the task NEEDS_ATTENTION with the project occupied, and the
     * close may be re-driven: a task already marked AI_CLOSING by an earlier close
     * re-enters the finishing steps until they provably succeed. A late terminal can
     * never release the project first because the release CAS matches only the
     * close's own marker. An already settled task is a no-op.
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
        try {
            worker.stop(taskId);
        } catch (RuntimeException ex) {
            // The worker may already be gone; the marker already blocks new calls.
        }
        // No project gate or task-store monitor across external IO or observation waits.
        if (tasks.hasLiveToolClaims(taskId) || !tools.finishForClose(taskId) || !tools.finishApplication(taskId)) return;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            // Closing forbids new claims. Re-read all durable application identities and live IO.
            synchronized (tasks) {
                if (tasks.hasLiveToolClaims(taskId) || !tools.applicationCanRelease(taskId, false)) return;
                // The original failure comes from the stored receipt first; the frozen
                // progress envelope stays the source for pre-receipt legacy rows.
                TerminalReport original = tasks.storedTerminalReport(taskId)
                    .map(stored -> new TerminalReport(stored.state(), stored.summary(), stored.failureCode()))
                    .filter(report -> report.state() == TaskState.FAILED)
                    .orElseGet(() -> tasks.terminalProgress(taskId)
                        .map(item -> parseTerminal(item.text()))
                        .filter(report -> report.state() == TaskState.FAILED)
                        .orElse(null));
                tasks.failClosedTask(taskId, original == null ? failureCode : original.failureCode(),
                    original == null ? summary : original.summary());
            }
        }
    }

    private record TerminalReport(TaskState state, String summary, String failureCode) { }

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

    private TerminalReport parseTerminal(String text) {
        try {
            JsonNode node = JSON.readTree(text);
            String stateName = node.path("state").asText("");
            if (!"COMPLETED".equals(stateName) && !"FAILED".equals(stateName)) {
                throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            }
            String summary = node.path("summary").asText(null);
            JsonNode failureCodeNode = node.path("failureCode");
            String failureCode = failureCodeNode.isNull() || failureCodeNode.isMissingNode()
                ? null : failureCodeNode.asText(null);
            return new TerminalReport(TaskState.valueOf(stateName), summary, failureCode);
        } catch (IOException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }
}
