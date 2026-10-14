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
import com.manao.poc4.config.AiConfig.AiProperties;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * The stage-one task lifecycle over the durable store (design section 6). A browser
 * submission creates the task and persists its fencing epoch inside the shared
 * project gate before the worker is called; the first correct (instance, epoch)
 * callback or start ACK binds the running session atomically; progress is a
 * monotonic, idempotent sequence whose terminal item applies the worker-reported
 * verdict by CAS; and the close flow persists its marker inside the gate first, then
 * stops the worker, then releases the project by CAS from its own marker alone. A
 * lost start response is reconciled by re-reading (and, on a re-submit, re-driving)
 * the ORIGINAL task under a bumped epoch — never by a second task id.
 */
public final class AgentTaskService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> OCCUPYING = Set.of("QUEUED", "RUNNING", "NEEDS_ATTENTION");

    private final AgentTaskStore tasks;
    private final ProjectLifecycleGate lifecycle;
    private final PiWorkerClient worker;
    private final AgentProjectTools tools;
    private final AiProperties properties;

    public AgentTaskService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle, PiWorkerClient worker,
                            AgentProjectTools tools, AiProperties properties) {
        this.tasks = tasks;
        this.lifecycle = lifecycle;
        this.worker = worker;
        this.tools = tools;
        this.properties = properties;
    }

    /**
     * The browser's task submission. The gate covers the durable creation and the
     * epoch persistence; the worker call runs outside the gate so no browser request
     * holds the project lock across a network hop. A settled task is only reported,
     * never re-driven; an occupying task is re-driven under a new fencing epoch.
     */
    public TaskSnapshot submit(String ownerId, String projectId, TaskRequest request) {
        requireProjectEnabled(projectId);
        TaskSnapshot snapshot;
        long epoch;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            snapshot = tasks.create(ownerId, projectId, request);
            if (!OCCUPYING.contains(snapshot.state().name())) {
                return snapshot;
            }
            epoch = tasks.persistEpoch(request.taskId());
        }
        driveStart(request.taskId(), request.prompt(), snapshot.workspaceRevision(), epoch);
        return snapshot;
    }

    /** One task by id, visible only through the owner's project. */
    public Optional<TaskSnapshot> findForOwner(String ownerId, String projectId, String taskId) {
        return tasks.findForOwner(ownerId, projectId, taskId);
    }

    /** The task that currently owns the project's writes, if any. */
    public Optional<TaskSnapshot> currentForOwner(String ownerId, String projectId) {
        return tasks.currentForOwner(ownerId, projectId);
    }

    /** Re-drives the start under the persisted epoch; the ACK binds QUEUED to RUNNING. */
    private void driveStart(String taskId, String prompt, String workspaceRevision, long epoch) {
        WorkerStart start = new WorkerStart(taskId, prompt, workspaceRevision,
            tasks.requestSha256Of(taskId), epoch);
        try {
            WorkerStatus ack = worker.start(start);
            onStartAck(taskId, epoch, ack);
        } catch (ApiException ex) {
            if ("AI_WORKER_NOT_CONFIGURED".equals(ex.code())) {
                // The worker refuses before any session exists: fail the task now, release it.
                tasks.applyTerminal(taskId, TaskState.FAILED,
                    "the worker has no model configuration", "AI_WORKER_NOT_CONFIGURED");
                return;
            }
            // Unreachable or transient: the task stays QUEUED with its persisted epoch,
            // retained for the next re-drive of the same request.
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

    /** The durable answer of a settled call; unknown or unsettled calls read as 404. */
    public Optional<ToolResult> getToolCall(String taskId, String toolCallId, String instanceId, long epoch) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        return tools.getCall(taskId, toolCallId);
    }

    /**
     * One progress item from the bound worker: appended to the monotonic envelope
     * first, and a terminal item then applies its verdict by CAS. The append's
     * occupying-state check already refuses any terminal that arrives after settle.
     */
    public void applyProgress(String taskId, String instanceId, long epoch, ProgressItem item) {
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        AgentTaskStore.ProgressAppend append = tasks.appendProgress(taskId, item);
        if (append.appended() && "terminal".equals(item.kind())) {
            TerminalReport report = parseTerminal(item.text());
            tasks.applyTerminal(taskId, report.state(), report.summary(), report.failureCode());
        }
    }

    /**
     * The close flow: inside the gate the task is marked NEEDS_ATTENTION with the
     * AI_CLOSING marker (which refuses every new tool registration from this moment),
     * then the worker is stopped and the build evidence is finished, and finally the
     * task is CASed to FAILED from its own marker — a late terminal can never release
     * the project first. Idempotent: an already settled or already closing task is a
     * no-op.
     */
    public void close(String taskId, String failureCode, String summary) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            if (!tasks.markClosing(taskId)) {
                return;
            }
        }
        try {
            worker.stop(taskId);
        } catch (RuntimeException ex) {
            // The worker may already be gone; the marker already blocks new calls.
        }
        tools.closeUnsettledBuilds(taskId);
        tasks.failClosedTask(taskId, failureCode, summary);
    }

    private void requireProjectEnabled(String projectId) {
        if (!properties.projectId().isBlank() && !properties.projectId().equals(projectId)) {
            throw new ApiException("AI_PROJECT_NOT_ENABLED", 404, "Project not found");
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
