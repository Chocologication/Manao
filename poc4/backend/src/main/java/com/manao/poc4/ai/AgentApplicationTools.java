package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.run.RunService;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.run.RunSummary;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Set;

/** Application tool semantics over the existing Run authority and persisted log window. */
public final class AgentApplicationTools {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> TERMINAL = Set.of("SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT");
    private static final int LOG_BYTES = 64 * 1024;
    private final AgentTaskStore tasks;
    private final RunService runs;
    private final RunStore store;
    private final RunLogService logs;
    private final ProjectApplicationProbe probe;
    private final ProjectLifecycleGate lifecycle;

    public AgentApplicationTools(AgentTaskStore tasks, RunService runs, RunStore store, RunLogService logs,
                                 ProjectApplicationProbe probe, ProjectLifecycleGate lifecycle) {
        this.tasks = tasks;
        this.runs = runs;
        this.store = store;
        this.logs = logs;
        this.probe = probe;
        this.lifecycle = lifecycle;
    }

    public AgentApplicationTools(AgentTaskStore tasks, RunService runs, RunStore store, RunLogService logs) {
        this(tasks, runs, store, logs, null, null);
    }

    /** The caller holds the ledger claim until this answer has been durably settled. */
    public AgentContracts.ToolResult invoke(String taskId, AgentTaskStore.ToolCallRow row,
                                             AgentContracts.ToolRequest request) {
        if ("app_http_get".equals(request.name())) return http(taskId, row, request.args());
        validate(request.args());
        var owner = tasks.taskOwner(taskId);
        String action = request.args().path("action").asText();
        String runId = request.args().path("runId").asText(null);
        int waitSeconds = request.args().path("waitSeconds").asInt("stop".equals(action) ? 10 : 0);
        long deadline = System.nanoTime() + Duration.ofSeconds(waitSeconds).toNanos();
        RunSummary run;
        if ("start".equals(action)) {
            runId = row.workspaceOperationId();
            // Restart recovery observes the original identity. Only the fresh claim may control.
            if ("RUNNING".equals(row.state())) {
                run = requiredRun(owner, runId);
            } else {
                var existing = store.findRun(runId);
                if (existing.isPresent()) {
                    if (!owner.projectId().equals(existing.get().projectId())) throw missingRun();
                    run = requiredRun(owner, runId);
                } else {
                    run = runs.startForAgent(owner.ownerId(), owner.projectId(), taskId,
                        row.toolCallId(), runId, Long.toString(row.expectedRevision()));
                }
            }
            if (!Long.toString(row.expectedRevision()).equals(run.requestedWorkspaceRevision())) {
                throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "The workspace revision does not match");
            }
        } else {
            run = runId == null ? runs.active(owner.ownerId(), owner.projectId()).orElse(null)
                : requiredRun(owner, runId);
            if ("stop".equals(action) && "REGISTERED".equals(row.state()) && !terminal(run)) {
                // Deadline begins BEFORE bounded withdrawal/delete IO, not after it.
                run = runs.stopForAgent(owner.ownerId(), owner.projectId(), taskId, row.toolCallId(), runId);
            }
            if ("status".equals(action) || "stop".equals(action)) {
                run = observe(owner, run, deadline, "stop".equals(action));
            }
        }
        ObjectNode data = applicationData(action, run, owner);
        if ("logs".equals(action)) {
            RunLogWindow window = logs.windowFor(run.id());
            List<RunLogWindow.Chunk> chunks;
            RunLogWindow.WindowMeta meta;
            long lastKnown;
            synchronized (window) {
                chunks = window.chunksAfter(0);
                meta = window.meta();
                lastKnown = window.lastSeq();
            }
            int budget = LOG_BYTES;
            // Observation persists terminal state only after history backfill settles. An execution
            // identity and terminal timestamp keep legacy/unknown terminal rows conservative.
            boolean historySettled = terminal(run) && store.findRunForOwner(owner.ownerId(), owner.projectId(), run.id())
                .filter(record -> TERMINAL.contains(record.state().name()) && record.finishedAt() != null
                    && record.executionPodUid() != null && !record.executionPodUid().isBlank()).isPresent();
            // JSON escaping can multiply bytes by six. Reduce the text, retaining its shape.
            while (true) {
                ObjectNode tail = logTail(chunks, meta, lastKnown, historySettled, budget);
                data.set("logs", tail);
                var result = new AgentContracts.ToolResult(row.toolCallId(), Long.toString(row.expectedRevision()),
                    data, tail.path("truncated").asBoolean());
                if (jsonBytes(result) <= AgentProjectTools.MAX_RESULT_BYTES) return result;
                budget /= 2;
            }
        }
        return new AgentContracts.ToolResult(row.toolCallId(), Long.toString(row.expectedRevision()), data, false);
    }

    private AgentContracts.ToolResult http(String taskId, AgentTaskStore.ToolCallRow row, JsonNode args) {
        var owner = tasks.taskOwner(taskId);
        String runId = args.path("runId").asText("");
        String path = args.path("path").asText("");
        AgentContracts.AppHttpGetData data;
        try {
            if (args.size() != 2 || !args.path("runId").isTextual() || runId.isBlank() || runId.length() > 64
                || !args.path("path").isTextual()) throw new IllegalArgumentException();
            ProjectApplicationProbe.relativePath(path);
        } catch (IllegalArgumentException ex) { return httpResult(row, httpError(runId, "", "VALIDATION_ERROR")); }
        // RUNNING with no live claim is a restart leftover: the remote GET may have happened.
        if ("RUNNING".equals(row.state()) || probe == null) return httpResult(row, httpError(runId, path, "AI_APP_HTTP_UNAVAILABLE"));
        RunRecord run;
        try (var lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            run = store.findRunForOwner(owner.ownerId(), owner.projectId(), runId).orElse(null);
            if (run == null || !owner.projectId().equals(run.projectId())) return httpResult(row, httpError(runId, path, "AI_RUN_NOT_FOUND"));
            if (!sameActive(owner, run)) return httpResult(row, httpError(runId, path, "AI_RUN_NOT_READY"));
        }
        try { data = probe.get(run, path); }
        catch (RuntimeException ex) { data = httpError(runId, path, "AI_APP_HTTP_UNAVAILABLE"); }
        // The IO holds the existing ledger claim, but never a project gate or store monitor.
        try (var lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            var current = store.findRunForOwner(owner.ownerId(), owner.projectId(), runId).orElse(null);
            if (current == null || !sameActive(owner, current)
                || !java.util.Objects.equals(run.executionPodUid(), current.executionPodUid())) {
                data = httpError(runId, path, "AI_APP_RUN_CHANGED");
            }
        } catch (RuntimeException ex) { data = httpError(runId, path, "AI_APP_RUN_CHANGED"); }
        return httpResult(row, data);
    }

    private boolean sameActive(AgentTaskStore.TaskOwner owner, RunRecord run) {
        if (!owner.projectId().equals(run.projectId()) || !"RUNNING".equals(run.state().name())
            || run.firstReadyAt() == null || run.executionPodUid() == null || run.executionPodUid().isBlank()) return false;
        return store.findActiveRun(owner.projectId()).filter(active -> active.id().equals(run.id())
            && active.projectId().equals(run.projectId()) && active.state() == run.state()
            && active.firstReadyAt() != null && java.util.Objects.equals(active.executionPodUid(), run.executionPodUid())).isPresent();
    }

    private static AgentContracts.AppHttpGetData httpError(String runId, String path, String code) {
        return new AgentContracts.AppHttpGetData("app_http_get", runId.length() <= 64 ? runId : "", path, null, null, "", false,
            ProjectApplicationProbe.safeError(code));
    }

    private static AgentContracts.ToolResult httpResult(AgentTaskStore.ToolCallRow row, AgentContracts.AppHttpGetData data) {
        ObjectNode node = JSON.valueToTree(data);
        var result = new AgentContracts.ToolResult(row.toolCallId(), Long.toString(row.expectedRevision()), node, data.truncated());
        while (jsonBytes(result) > AgentProjectTools.MAX_RESULT_BYTES) {
            String field = node.path("body").asText().isEmpty() ? "contentType" : "body";
            String text = node.path(field).asText();
            int end = text.offsetByCodePoints(0, text.codePointCount(0, text.length()) / 2);
            node.put(field, text.substring(0, end)).put("truncated", true);
            result = new AgentContracts.ToolResult(row.toolCallId(), Long.toString(row.expectedRevision()), node, true);
        }
        return result;
    }

    static void validate(JsonNode args) {
        String action = args.path("action").asText("");
        Set<String> allowed = switch (action) {
            case "start" -> Set.of("action");
            case "status", "stop" -> Set.of("action", "runId", "waitSeconds");
            case "logs" -> Set.of("action", "runId");
            default -> throw invalid();
        };
        args.fieldNames().forEachRemaining(field -> { if (!allowed.contains(field)) throw invalid(); });
        if (args.has("runId") && (!args.path("runId").isTextual() || args.path("runId").asText().isBlank()
            || args.path("runId").asText().length() > 64)) throw invalid();
        if (("stop".equals(action) || "logs".equals(action)) && !args.has("runId")) throw invalid();
        if (args.has("waitSeconds") && (!args.path("waitSeconds").isIntegralNumber()
            || !args.path("waitSeconds").canConvertToInt()
            || args.path("waitSeconds").asInt() < 0 || args.path("waitSeconds").asInt() > 10)) throw invalid();
    }

    private RunSummary observe(AgentTaskStore.TaskOwner owner, RunSummary run, long deadline, boolean stopping) {
        while (run != null && !terminal(run) && (stopping || !ready(run))) {
            long left = deadline - System.nanoTime();
            if (left <= 0) break;
            pause(Math.min(left, Duration.ofSeconds(2).toNanos()));
            run = requiredRun(owner, run.id());
        }
        return run;
    }

    private ObjectNode applicationData(String action, RunSummary run, AgentTaskStore.TaskOwner owner) {
        var active = runs.active(owner.ownerId(), owner.projectId());
        ObjectNode data = JSON.createObjectNode().put("kind", "application").put("action", action);
        data.set("run", run == null ? JSON.nullNode() : runView(run));
        data.put("activeRunId", active.map(RunSummary::id).orElse(null));
        data.put("stoppedConfirmed", terminal(run) && active.isEmpty());
        data.putNull("logs");
        return data;
    }

    private static ObjectNode runView(RunSummary run) {
        ObjectNode view = JSON.createObjectNode().put("id", run.id()).put("state", run.state())
            .put("requestedWorkspaceRevision", run.requestedWorkspaceRevision())
            .put("firstReadyAt", run.firstReadyAt()).put("expiresAt", run.expiresAt())
            .put("finishedAt", run.finishedAt()).put("terminationReason", run.terminationReason());
        if (run.exitCode() == null) view.putNull("exitCode"); else view.put("exitCode", run.exitCode());
        return view;
    }

    private static ObjectNode logTail(List<RunLogWindow.Chunk> chunks, RunLogWindow.WindowMeta meta,
                                      long lastKnown, boolean terminal, int budget) {
        boolean gap = !chunks.isEmpty() && chunks.get(0).seq() != 1;
        for (int i = 1; i < chunks.size(); i++) gap |= chunks.get(i).seq() != chunks.get(i - 1).seq() + 1;
        gap |= !chunks.isEmpty() && chunks.get(chunks.size() - 1).seq() != lastKnown;
        boolean sourceLost = chunks.stream().anyMatch(chunk -> chunk.text().contains("[manao] log source lost"));
        StringBuilder text = new StringBuilder();
        Long first = null;
        Long last = null;
        boolean truncated = meta.truncated() || gap || (chunks.isEmpty() && lastKnown > 0);
        int remaining = budget;
        for (int i = chunks.size() - 1; i >= 0; i--) {
            var chunk = chunks.get(i);
            byte[] bytes = chunk.text().getBytes(StandardCharsets.UTF_8);
            int offset = Math.max(0, bytes.length - remaining);
            while (offset < bytes.length && (bytes[offset] & 0xC0) == 0x80) offset++;
            if (offset < bytes.length) {
                text.insert(0, new String(bytes, offset, bytes.length - offset, StandardCharsets.UTF_8));
                remaining -= bytes.length - offset;
                first = chunk.seq();
                if (last == null) last = chunk.seq();
            }
            if (offset > 0) { truncated = true; break; }
            if (remaining == 0 && i > 0) { truncated = true; break; }
        }
        ObjectNode result = JSON.createObjectNode().put("text", text.toString()).put("truncated", truncated)
            .put("complete", terminal && !chunks.isEmpty() && !gap && !sourceLost);
        if (first == null) result.putNull("firstSeq"); else result.put("firstSeq", first);
        if (last == null) result.putNull("lastSeq"); else result.put("lastSeq", last);
        return result;
    }

    /**
     * One re-entrant close-finishing step over the task's application calls (repair
     * design section 6): each registered original start/stop target gets at most ONE
     * stop request and ONE bounded re-read — an unconfirmed run returns false
     * immediately for the next reconcile round instead of waiting out an observation
     * budget inside the close. Only registered original targets are stopped; an
     * untouched old app survives. Control is never replayed from the original call
     * after close; completed answers are preserved.
     */
    public boolean finish(String taskId) {
        if (tasks.hasLiveToolClaims(taskId)) return false;
        var owner = tasks.taskOwner(taskId);
        for (var row : tasks.applicationCalls(taskId)) {
            ReconcileWorkBudget.check();
            if (!tasks.claimApplicationCleanup(taskId, row.toolCallId())) return false;
            try {
                String target = cleanupTarget(row);
                if (target != null) {
                    RunSummary run = cleanupRun(owner, row, target);
                    if (run != null && !terminal(run)) {
                        ReconcileWorkBudget.boundary(() -> runs.stopForAgent(owner.ownerId(), owner.projectId(), taskId, row.toolCallId(), target));
                        // One bounded re-read: an unconfirmed run defers this step; the
                        // next reconcile round re-drives it from the durable facts.
                        if (!terminal(requiredRun(owner, target))) return false;
                    }
                }
                tasks.retireApplicationCall(taskId, row.toolCallId());
            } catch (RuntimeException ex) {
                return false;
            } finally {
                tasks.releaseBuildClaim(taskId, row.toolCallId());
            }
        }
        return true;
    }

    /** Short DB-only recheck under the final project gate; no waits or control requests. */
    boolean canRelease(String taskId, boolean completed) {
        if (tasks.hasLiveToolClaims(taskId)) return false;
        var owner = tasks.taskOwner(taskId);
        try {
            for (var row : tasks.applicationCalls(taskId)) {
                String target = cleanupTarget(row);
                if (target == null) continue;
                RunSummary run = cleanupRun(owner, row, target);
                if (run != null && !terminal(run)) {
                    if (!completed || !target.equals(row.workspaceOperationId()) || !ready(run)
                        || !runs.active(owner.ownerId(), owner.projectId())
                        .map(active -> active.id().equals(run.id())).orElse(false)) return false;
                }
            }
            return true;
        } catch (RuntimeException ex) { return false; }
    }

    private String cleanupTarget(AgentTaskStore.ToolCallRow row) {
        try {
            JsonNode args = JSON.readTree(row.argsJson());
            if ("COMPLETED".equals(row.state())) {
                // Validation always precedes control. A settled invalid request never touched a Run;
                // do not turn its rejected arguments into a new control request during close.
                try { validate(args); }
                catch (ApiException ex) {
                    if ("VALIDATION_ERROR".equals(ex.code())) return null;
                    throw ex;
                }
            }
            if ("start".equals(args.path("action").asText())) return row.workspaceOperationId();
            if ("stop".equals(args.path("action").asText())) {
                if (row.resultJson() != null && "AI_RUN_NOT_FOUND".equals(
                    JSON.readTree(row.resultJson()).path("data").path("error").path("code").asText())) return null;
                return args.path("runId").asText(null);
            }
            return null;
        } catch (java.io.IOException ex) { throw new IllegalStateException("Invalid persisted application call", ex); }
    }

    private RunSummary cleanupRun(AgentTaskStore.TaskOwner owner, AgentTaskStore.ToolCallRow row, String target) {
        RunSummary run;
        try { run = requiredRun(owner, target); }
        catch (ApiException ex) {
            if ("AI_RUN_NOT_FOUND".equals(ex.code()) && store.findRun(target).isEmpty()) return null;
            throw ex;
        }
        if (target.equals(row.workspaceOperationId())
            && !Long.toString(row.expectedRevision()).equals(run.requestedWorkspaceRevision())) throw missingRun();
        return run;
    }

    private RunSummary requiredRun(AgentTaskStore.TaskOwner owner, String runId) {
        try { return runs.get(owner.ownerId(), owner.projectId(), runId); }
        catch (ApiException ex) {
            if ("RUN_NOT_FOUND".equals(ex.code()) || "AI_RUN_NOT_FOUND".equals(ex.code())) throw missingRun();
            throw ex;
        }
    }

    private static boolean terminal(RunSummary run) { return run != null && TERMINAL.contains(run.state()); }
    private static boolean ready(RunSummary run) { return "RUNNING".equals(run.state()) && run.firstReadyAt() != null; }
    private static ApiException invalid() { return new ApiException("VALIDATION_ERROR", 422, "Invalid application arguments"); }
    private static ApiException missingRun() { return new ApiException("AI_RUN_NOT_FOUND", 404, "Run not found"); }
    private static int jsonBytes(Object value) {
        try { return JSON.writeValueAsBytes(value).length; }
        catch (java.io.IOException ex) { throw new IllegalStateException("Cannot serialize application result", ex); }
    }
    private static void pause(long nanos) {
        try { java.util.concurrent.TimeUnit.NANOSECONDS.sleep(nanos); }
        catch (InterruptedException ex) { Thread.currentThread().interrupt(); throw new IllegalStateException("Observation interrupted"); }
    }
}
