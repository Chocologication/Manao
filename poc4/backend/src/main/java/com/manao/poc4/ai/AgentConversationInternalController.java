package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentConversationContracts.*;
import org.springframework.web.bind.annotation.*;

/** Native context is available only through the worker-token chain and its task fence. */
@RestController
@org.springframework.context.annotation.Conditional({
    com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,
    com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/internal/ai/tasks/{taskId}/context")
public final class AgentConversationInternalController {
    private final AgentConversationStore store;
    public AgentConversationInternalController(AgentConversationStore store) { this.store = store; }
    @GetMapping
    public ContextPage read(@PathVariable String taskId,
                            @RequestHeader(value="X-Manao-Worker-Instance",required=false) String instance,
                            @RequestHeader(value="X-Manao-Worker-Epoch",required=false) String epoch,
                            @RequestParam(defaultValue="0") long afterSeq, @RequestParam(required=false) Long throughSeq) {
        return store.readForTask(taskId, instance, epoch(epoch), afterSeq, throughSeq);
    }
    @PostMapping
    public ContextAck append(@PathVariable String taskId,
                             @RequestHeader(value="X-Manao-Worker-Instance",required=false) String instance,
                             @RequestHeader(value="X-Manao-Worker-Epoch",required=false) String epoch,
                             @RequestBody ContextAppend append) {
        return store.appendForTask(taskId, instance, epoch(epoch), append);
    }
    private static long epoch(String value) {
        try { long parsed = Long.parseLong(value); if (parsed < 0) throw AgentConversationStore.invalid(); return parsed; }
        catch (NumberFormatException ex) { throw AgentConversationStore.invalid(); }
    }
}
