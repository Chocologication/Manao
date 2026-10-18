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

    public AgentTaskService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle, PiWorkerClient worker,
                            AgentProjectTools tools) {
        this.tasks = tasks;
        this.lifecycle = lifecycle;
        this.worker = worker;
        this.tools = tools;
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
        AgentTaskStore.TaskCreation creation;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            creation = tasks.createTask(ownerId, projectId, request);
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
            creation.epoch());
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
    private void driveStart(String taskId, String prompt, String workspaceRevision, long epoch) {
        WorkerStart start = new WorkerStart(taskId, prompt, workspaceRevision,
            tasks.requestSha256Of(taskId), epoch);
        try {
            WorkerStatus ack = worker.start(start);
            onStartAck(taskId, epoch, ack);
            return;
        } catch (ApiException ex) {
            if ("AI_WORKER_NOT_CONFIGURED".equals(ex.code())) {
                // The worker refuses before any session exists: fail the task now, release it.
                close(taskId, "AI_WORKER_NOT_CONFIGURED", "the worker has no model configuration");
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
     * One progress item from the bound worker: appended to the monotonic envelope
     * first, and a terminal item then applies its verdict by CAS. The append's
     * occupying-state check already refuses any terminal that arrives after settle.
     */
    public void applyProgress(String taskId, String instanceId, long epoch, ProgressItem item) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        TerminalReport report = "terminal".equals(item.kind()) ? parseTerminal(item.text()) : null;
        var owner = tasks.taskOwner(taskId);
        boolean failed = false;
        try (var lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            synchronized (tasks) {
                AgentTaskStore.ProgressAppend append = tasks.appendProgress(taskId, item);
                if (append.appended() && report != null) {
                    if (report.state() == TaskState.FAILED) {
                        tasks.beginClose(taskId);
                        failed = true;
                    } else if (tasks.hasLiveToolClaims(taskId) || !tools.applicationCanRelease(taskId, true)) {
                        tasks.deferTerminal(taskId, report.summary());
                    } else {
                        tasks.applyTerminal(taskId, report.state(), report.summary(), report.failureCode());
                    }
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
            entry = tasks.beginClose(taskId);
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
                TerminalReport original = tasks.terminalProgress(taskId).map(item -> parseTerminal(item.text()))
                    .filter(report -> report.state() == TaskState.FAILED).orElse(null);
                tasks.failClosedTask(taskId, original == null ? failureCode : original.failureCode(),
                    original == null ? summary : original.summary());
            }
        }
    }

    private record TerminalReport(TaskState state, String summary, String failureCode) { }

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
