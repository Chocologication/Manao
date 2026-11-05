package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.workspace.PythonDependencyService;
import java.util.List;
import java.util.Set;

public final class AgentPythonDependencyTools {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AgentTaskStore tasks;
    private final PythonDependencyService dependencies;

    public AgentPythonDependencyTools(AgentTaskStore tasks, PythonDependencyService dependencies) {
        this.tasks = tasks;
        this.dependencies = dependencies;
    }

    public AgentContracts.ToolResult invoke(String taskId, AgentTaskStore.ToolCallRow row, AgentContracts.ToolRequest request) {
        boolean fresh = "REGISTERED".equals(row.state());
        boolean claimed = fresh ? tasks.markToolCallRunning(taskId, row.toolCallId())
            : tasks.claimDependencyObservation(taskId, row.toolCallId());
        if (!claimed) throw new ApiException("AI_CALL_RUNNING", 409, "The tool call is still running");
        try {
            PythonDependencyService.Status status = fresh ? dependencies.changeForAgent(taskId, row.toolCallId())
                : dependencies.reconcileForAgent(taskId, row.toolCallId());
            if (!"COMMITTED".equals(status.state())) throw new ApiException("AI_CALL_NEEDS_ATTENTION", 409, "The call outcome is unknown");
            return complete(taskId, row.toolCallId(), status);
        } catch (ApiException ex) {
            if (Set.of("VALIDATION_ERROR", "PYTHON_DEPENDENCY_UNSUPPORTED", "PYTHON_DEPENDENCY_NO_WHEEL",
                    "PYTHON_DEPENDENCY_PROTOCOL_UNSUPPORTED", "PYTHON_DEPENDENCY_RESOLUTION_FAILED", "PYTHON_DEPENDENCY_TIMEOUT",
                    "AI_TASK_NOT_ACTIVE", "WORKSPACE_REVISION_CONFLICT", "PROJECT_LOCKED").contains(ex.code())) {
                var data = JSON.createObjectNode();
                data.putObject("error").put("code", ex.code()).put("message", "Dependency change was refused");
                var result = new AgentContracts.ToolResult(row.toolCallId(), Long.toString(row.expectedRevision()), data, false);
                tasks.completeToolCall(taskId, row.toolCallId(), serialize(result));
                return result;
            }
            tasks.markToolCallNeedsAttention(taskId, row.toolCallId());
            throw ex;
        } catch (RuntimeException ex) {
            tasks.markToolCallNeedsAttention(taskId, row.toolCallId());
            throw ex;
        } finally {
            tasks.releaseBuildClaim(taskId, row.toolCallId());
        }
    }

    public boolean finishForClose(String taskId, AgentTaskStore.ToolCallRow row) {
        if (!tasks.claimDependencyCleanup(taskId, row.toolCallId())) return false;
        try {
            var status = dependencies.reconcileForAgent(taskId, row.toolCallId());
            if ("COMMITTED".equals(status.state())) complete(taskId, row.toolCallId(), status);
            else if ("UNCONFIRMED".equals(status.state())) tasks.markToolCallNeedsAttention(taskId, row.toolCallId());
            else return false;
            return true;
        } catch (RuntimeException ex) {
            return false;
        } finally {
            tasks.releaseBuildClaim(taskId, row.toolCallId());
        }
    }

    private AgentContracts.ToolResult complete(String taskId, String toolCallId, PythonDependencyService.Status status) {
        var paths = List.of("pyproject.toml", "uv.lock");
        var call = tasks.findToolCall(taskId, toolCallId).orElseThrow(() -> new IllegalStateException("Dependency call is missing"));
        com.fasterxml.jackson.databind.JsonNode args;
        try { args = JSON.readTree(call.argsJson()); }
        catch (java.io.IOException ex) { throw new IllegalStateException("Cannot read dependency call", ex); }
        var data = JSON.createObjectNode().put("kind", "python_dependencies")
            .put("operationId", status.operationId()).put("action", args.path("action").asText())
            .put("packageName", args.path("packageName").asText()).put("group", args.path("group").asText())
            .put("state", status.state());
        data.set("changedPaths", JSON.valueToTree(paths));
        var result = new AgentContracts.ToolResult(toolCallId, Long.toString(status.resultWorkspaceRevision()), data, false);
        tasks.completeDependencyCall(taskId, toolCallId, paths, status.resultWorkspaceRevision(), serialize(result));
        return result;
    }

    private static String serialize(AgentContracts.ToolResult result) {
        try { return JSON.writeValueAsString(result); }
        catch (java.io.IOException ex) { throw new IllegalStateException("Cannot serialize dependency result", ex); }
    }
}
