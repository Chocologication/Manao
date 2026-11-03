package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentAttachmentContracts.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@org.springframework.context.annotation.Conditional({com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/internal/ai/tasks/{taskId}/attachments")
public final class AgentAttachmentInternalController {
    private final AgentAttachmentService attachments;
    private final AgentTaskStore tasks;
    public AgentAttachmentInternalController(AgentAttachmentService attachments,AgentTaskStore tasks){this.attachments=attachments;this.tasks=tasks;}
    private void identity(String taskId,long epoch,String instance){tasks.requireBoundWorkerIdentity(taskId,epoch,instance);}
    @GetMapping public AttachmentPage catalog(@PathVariable String taskId,@RequestHeader("X-Manao-Worker-Epoch") long epoch,
        @RequestHeader("X-Manao-Worker-Instance") String instance,@RequestParam(required=false) String cursor){
        identity(taskId,epoch,instance);return attachments.catalog(taskId,cursor);
    }
    @GetMapping("/{attachmentId}") public AttachmentRef metadata(@PathVariable String taskId,@PathVariable String attachmentId,
        @RequestHeader("X-Manao-Worker-Epoch") long epoch,@RequestHeader("X-Manao-Worker-Instance") String instance){
        identity(taskId,epoch,instance);return attachments.referenceForTask(taskId,attachmentId);
    }
    @GetMapping("/{attachmentId}/content") public ResponseEntity<byte[]> content(@PathVariable String taskId,@PathVariable String attachmentId,
        @RequestHeader("X-Manao-Worker-Epoch") long epoch,@RequestHeader("X-Manao-Worker-Instance") String instance){
        identity(taskId,epoch,instance);var opened=attachments.openForTask(taskId,attachmentId);
        return ResponseEntity.ok().header("Cache-Control","private, no-store").header("Content-Type",opened.metadata().mimeType()).body(opened.bytes());
    }
}
