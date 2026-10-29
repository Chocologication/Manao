package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentConversationContracts.*;
import java.security.Principal;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

/** Browser routes return only metadata and an allowlisted history projection. */
@RestController
@org.springframework.context.annotation.Conditional({
    com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,
    com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/api/v1/projects/{projectId}/conversations")
public final class AgentConversationController {
    private final AgentConversationService conversations;
    private final AgentTaskService tasks;
    public AgentConversationController(AgentConversationService conversations, AgentTaskService tasks) {
        this.conversations = conversations;
        this.tasks = tasks;
    }
    @PostMapping
    public ConversationView create(Principal principal, @PathVariable String projectId,
                                   @RequestBody CreateConversationRequest request) {
        return conversations.create(principal.getName(), projectId, request);
    }
    @GetMapping
    public ConversationPage list(Principal principal, @PathVariable String projectId,
                                 @RequestParam(required=false) String before, @RequestParam(defaultValue="20") int limit) {
        return conversations.list(principal.getName(), projectId, before, limit);
    }
    @GetMapping("/{conversationId}")
    public ConversationView detail(Principal principal, @PathVariable String projectId, @PathVariable String conversationId) {
        return conversations.detail(principal.getName(), projectId, conversationId);
    }
    @GetMapping("/{conversationId}/entries")
    public HistoryPage history(Principal principal, @PathVariable String projectId, @PathVariable String conversationId,
                               @RequestParam(required=false) Long beforeSeq, @RequestParam(required=false) Integer beforeOffset,
                               @RequestParam(defaultValue="50") int limit) {
        return conversations.history(principal.getName(), projectId, conversationId, beforeSeq, beforeOffset, limit);
    }
    @PostMapping("/{conversationId}/compact")
    public ConversationView compact(Principal principal, @PathVariable String projectId, @PathVariable String conversationId,
                                     @RequestBody CompactRequest request) {
        return conversations.compact(principal.getName(), projectId, conversationId, request);
    }
    @PostMapping("/{conversationId}/tasks")
    public AgentContracts.TaskSnapshot submit(Principal principal, @PathVariable String projectId, @PathVariable String conversationId,
                                               @Valid @RequestBody AgentTaskController.SubmitTaskRequest request) {
        conversations.detail(principal.getName(), projectId, conversationId);
        long revision;
        try { revision = Long.parseLong(request.expectedWorkspaceRevision()); } catch (NumberFormatException ex) { throw AgentConversationStore.invalid(); }
        return tasks.submit(principal.getName(), projectId,
            new AgentContracts.TaskRequest(request.taskId(), request.prompt(), revision, request.reasoningEffort()), conversationId);
    }
}
