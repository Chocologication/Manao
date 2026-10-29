package com.manao.poc4.ai;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.manao.poc4.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Browser-facing AI task endpoints (stage one): submit a pre-generated task id, read
 * the current owning task, read one task. Responses are the same bounded snapshots
 * the store produces; nothing about the worker, its instance or the model ever
 * reaches this boundary. The AI beans only exist while the stage is enabled.
 */
@RestController
@org.springframework.context.annotation.Conditional({
    com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,
    com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/api/v1/projects/{projectId}/agent-tasks")
public final class AgentTaskController {
    private final AgentTaskService tasks;

    public AgentTaskController(AgentTaskService tasks) {
        this.tasks = tasks;
    }

    @PostMapping
    public AgentContracts.TaskSnapshot submit(Authentication authentication,
                                              @PathVariable String projectId,
                                              @Valid @RequestBody SubmitTaskRequest request) {
        long expectedRevision = parseRevision(request.expectedWorkspaceRevision());
        return tasks.submit(authentication.getName(), projectId,
            new AgentContracts.TaskRequest(request.taskId(), request.prompt(), expectedRevision, request.reasoningEffort()));
    }

    @GetMapping("/current")
    public AgentContracts.TaskSnapshot current(Authentication authentication, @PathVariable String projectId) {
        return tasks.currentForOwner(authentication.getName(), projectId).orElseThrow(
            () -> new ApiException("ENTRY_NOT_FOUND", 404, "Task not found"));
    }

    @GetMapping("/{taskId}")
    public AgentContracts.TaskSnapshot get(Authentication authentication, @PathVariable String projectId,
                                           @PathVariable String taskId) {
        return requireOwnedTask(authentication.getName(), projectId, taskId);
    }

    /**
     * One settled tool call of the owner's task (review fix I9): the browser's only
     * data path to the real build evidence — exit code, bounded output excerpt and
     * the cleanup proof. Owner/project scoped (a foreign id reads as 404), settled
     * calls only, and never any internal execution identity.
     */
    @GetMapping("/{taskId}/tools/{toolCallId}")
    public AgentContracts.AgentToolCallView toolCall(Authentication authentication,
                                                     @PathVariable String projectId,
                                                     @PathVariable String taskId,
                                                     @PathVariable String toolCallId) {
        requireOwnedTask(authentication.getName(), projectId, taskId);
        return tasks.browserToolCall(authentication.getName(), projectId, taskId, toolCallId);
    }

    /**
     * The owner's explicit abandon (repair design section 6): the close intent is
     * persisted first and the answer returns the CURRENT snapshot fast — a snapshot
     * still showing NEEDS_ATTENTION means the close was accepted but not yet confirmed
     * finished, and the settlement continues in the background until the project is
     * provably released. A repeated close keeps the original reason; a close of an
     * already settled task is a no-op.
     */
    @PostMapping("/{taskId}/close")
    public AgentContracts.TaskSnapshot close(Authentication authentication, @PathVariable String projectId,
                                             @PathVariable String taskId) {
        requireOwnedTask(authentication.getName(), projectId, taskId);
        tasks.close(taskId, "AI_CLOSED", "closed by the owner");
        return requireOwnedTask(authentication.getName(), projectId, taskId);
    }

    @PostMapping("/{taskId}/pause")
    public AgentContracts.TaskSnapshot pause(Authentication authentication, @PathVariable String projectId,
                                             @PathVariable String taskId) {
        requireOwnedTask(authentication.getName(), projectId, taskId);
        tasks.pause(taskId);
        return requireOwnedTask(authentication.getName(), projectId, taskId);
    }

    /** The task snapshot only through this owner's project; a foreign id reads as 404. */
    private AgentContracts.TaskSnapshot requireOwnedTask(String ownerId, String projectId, String taskId) {
        return tasks.findForOwner(ownerId, projectId, taskId).orElseThrow(
            () -> new ApiException("ENTRY_NOT_FOUND", 404, "Task not found"));
    }

    private static long parseRevision(String revision) {
        try {
            long parsed = Long.parseLong(revision);
            if (parsed < 0) {
                throw new NumberFormatException();
            }
            return parsed;
        } catch (NumberFormatException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record SubmitTaskRequest(@NotBlank String taskId, @NotBlank String prompt,
                                    @NotBlank String expectedWorkspaceRevision, String reasoningEffort) {
        public SubmitTaskRequest(String taskId, String prompt, String expectedWorkspaceRevision) { this(taskId, prompt, expectedWorkspaceRevision, null); }
    }
}
