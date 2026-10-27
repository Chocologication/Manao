package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/**
 * The stage-one cross-task contracts between the browser-facing task service, the project
 * tools, the development build executor and the Pi worker. Pure data: no behavior, no
 * persistence. Nested types are the single spelling every later task consumes — none of them
 * may be redefined locally. Browser DTOs never carry internal namespace/Pod/Secret identifiers
 * or absolute mount paths; {@code BuildResult.identity} stays backend-side only.
 */
public final class AgentContracts {
    private AgentContracts() { }

    /** Task lifecycle: QUEUED/RUNNING/NEEDS_ATTENTION occupy the project, COMPLETED/FAILED release it. */
    public enum TaskState { QUEUED, RUNNING, COMPLETED, FAILED, NEEDS_ATTENTION }

    /** Tool-call lifecycle inside one task; a recorded call never restarts under a new identity. */
    public enum CallState { REGISTERED, RUNNING, COMPLETED, NEEDS_ATTENTION }

    /** The only build goals; no arbitrary argv, environment or shell strings. */
    public enum BuildGoal { COMPILE, TEST, PACKAGE }

    /** The browser's task submission: a pre-generated UUID, the goal text and the saved revision. */
    public record TaskRequest(String taskId, String prompt, long expectedRevision, String reasoningEffort) {
        public TaskRequest(String taskId, String prompt, long expectedRevision) { this(taskId, prompt, expectedRevision, null); }
    }

    /** What the browser polls: state, revision, persisted progress and the settled evidence. */
    public record TaskSnapshot(String taskId, TaskState state, String workspaceRevision,
                               boolean writesLocked, List<ProgressItem> progress,
                               List<String> changedPaths, String summary, String failureCode,
                               String conversationId, String reasoningEffort, String closeReasonCode) {
        public TaskSnapshot(String taskId, TaskState state, String workspaceRevision, boolean writesLocked,
                            List<ProgressItem> progress, List<String> changedPaths, String summary, String failureCode,
                            String conversationId, String reasoningEffort) {
            this(taskId, state, workspaceRevision, writesLocked, progress, changedPaths, summary, failureCode, conversationId, reasoningEffort, null);
        }
        public TaskSnapshot(String taskId, TaskState state, String workspaceRevision, boolean writesLocked,
                            List<ProgressItem> progress, List<String> changedPaths, String summary, String failureCode, String conversationId) {
            this(taskId, state, workspaceRevision, writesLocked, progress, changedPaths, summary, failureCode, conversationId, null);
        }
        public TaskSnapshot(String taskId, TaskState state, String workspaceRevision, boolean writesLocked,
                            List<ProgressItem> progress, List<String> changedPaths, String summary, String failureCode) {
            this(taskId, state, workspaceRevision, writesLocked, progress, changedPaths, summary, failureCode, null);
        }
    }

    /** One persisted progress entry (full message, tool start/end or terminal state). */
    public record ProgressItem(long seq, String kind, String text, boolean truncated) { }

    /** A project tool invocation; owner/project identity is injected, never model-supplied. */
    public record ToolRequest(String toolCallId, String name, long expectedRevision, JsonNode args) { }

    /** The durable tool answer: the workspace revision it ran against plus bounded result data. */
    public record ToolResult(String toolCallId, String workspaceRevision, JsonNode data, boolean truncated) { }

    public record AppHttpGetData(String kind, String runId, String path, Integer statusCode,
                                String contentType, String body, boolean truncated, ToolError error) { }

    public record ToolError(String code, String message) { }

    /**
     * The owner browser's view of one settled tool call (review fix I9): the stable
     * call identity, the tool name and the bounded result data — real exit facts,
     * truncated output and the cleanup proof. It never carries the build identity,
     * a namespace, a Pod or any mount path: those stay backend-side, and a call that
     * has not settled reads as 404 instead of partial data.
     */
    public record AgentToolCallView(String toolCallId, String toolName, JsonNode data) { }

    /**
     * The internal reconciliation answer for one tool call (review fix I3): the three
     * states the worker must tell apart — an unknown id (the controller answers 404),
     * a registered-but-unsettled call ({@code state} RUNNING or NEEDS_ATTENTION, no
     * result yet), and a settled call ({@code state} COMPLETED with its durable result).
     * An executing build can therefore never be misread as an unregistered submission.
     */
    public record ToolCallStatus(String state, ToolResult result) { }

    /** One development build execution request; {@code commandId} is the stable display identity. */
    public record BuildRequest(String taskId, String toolCallId, String projectId,
                               String commandId, long sourceRevision, BuildGoal goal) { }

    /** The verified Kubernetes identity behind one build; never leaves the backend. */
    public record BuildIdentity(String jobName, String jobUid, String podUid) { }

    /** One test class summary parsed from the bounded Surefire XML attached to the build log. */
    public record TestReport(String testClass, int tests, int failures, int errors, int skipped,
                             String sha256) { }

    /** The real build outcome: exit result, bounded output, parsed reports and cleanup proof. */
    public record BuildResult(BuildIdentity identity, Integer exitCode, String terminationReason,
                              String output, boolean truncated, List<TestReport> testReports,
                              boolean cleanupConfirmed) { }

    /** Backend-to-worker start command; carries no project owner. */
    public record WorkerStart(String taskId, String prompt, String workspaceRevision,
                              String requestSha256, long workerEpoch, String conversationId, String reasoningEffort) {
        public WorkerStart(String taskId, String prompt, String workspaceRevision, String requestSha256, long workerEpoch, String conversationId) {
            this(taskId, prompt, workspaceRevision, requestSha256, workerEpoch, conversationId, "high");
        }
        public WorkerStart(String taskId, String prompt, String workspaceRevision, String requestSha256, long workerEpoch) {
            this(taskId, prompt, workspaceRevision, requestSha256, workerEpoch, null);
        }
    }

    /** Worker answer to start/status/stop; {@code instanceId} binds the running session. */
    public record WorkerStatus(String taskId, String instanceId, String state, Integer protocolVersion,
                               Long workerEpoch, String requestSha256, String executionState,
                               WorkerTerminalDelivery terminalDelivery) {
        public WorkerStatus(String taskId, String instanceId, String state) {
            this(taskId, instanceId, state, null, null, null, null, null);
        }
    }

    public record WorkerTerminalDelivery(String state, String reportId, String reportSha256, TerminalReport report) { }

    public record WorkerProcessStatus(String bootId, String instanceId, String activeTaskId,
                                      String activeExecutionState, String activeKind, boolean modelConfigured) { }

    /**
     * The worker's terminal execution report (repair design section 4). The backend
     * recomputes {@code reportId} from the durable execution identity and refuses a
     * mismatch; only COMPLETED or FAILED are terminal states.
     */
    public record TerminalReport(int protocolVersion, String reportId, TaskState state,
                                 String summary, String failureCode) { }

    /** The committed backend decision for one terminal report. */
    public enum TerminalDisposition { RECORDED, SETTLED, CLOSING }

    /**
     * The durable terminal answer: the report identity, the backend-computed canonical
     * content digest and the committed disposition. A 200 response means this decision
     * has been persisted — it is never a proxy for "the task settled".
     */
    public record TerminalAck(String reportId, String reportSha256, TerminalDisposition disposition) { }
}
