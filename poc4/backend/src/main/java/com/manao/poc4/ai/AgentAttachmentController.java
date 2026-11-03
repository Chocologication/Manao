package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentAttachmentContracts.*;
import java.security.Principal;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@org.springframework.context.annotation.Conditional({com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/api/v1/projects/{projectId}/conversations/{conversationId}/attachments/{attachmentId}")
public final class AgentAttachmentController {
    private final AgentAttachmentService attachments;
    public AgentAttachmentController(AgentAttachmentService attachments){this.attachments=attachments;}
    @PutMapping(consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<AttachmentRef> upload(Principal principal,@PathVariable String projectId,@PathVariable String conversationId,
        @PathVariable String attachmentId,@RequestPart("file") MultipartFile file) throws java.io.IOException {
        if(file.getSize()>AgentAttachmentService.MAX_BYTES)throw new com.manao.poc4.api.ApiException("AI_ATTACHMENT_TOO_LARGE",413,"Image exceeds 10000000 bytes");
        byte[] bytes;try(var stream=file.getInputStream()){bytes=stream.readNBytes(AgentAttachmentService.MAX_BYTES+1);}
        return timed(attachments.registerOrConfirm(new Scope(principal.getName(),projectId,conversationId),attachmentId,file.getOriginalFilename(),file.getContentType()==null?"application/octet-stream":file.getContentType(),bytes));
    }
    @GetMapping public ResponseEntity<AttachmentRef> confirm(Principal principal,@PathVariable String projectId,@PathVariable String conversationId,@PathVariable String attachmentId){return timed(attachments.confirm(new Scope(principal.getName(),projectId,conversationId),attachmentId));}
    private ResponseEntity<AttachmentRef> timed(AttachmentRef ref){return ResponseEntity.ok().header("Cache-Control","private, no-store").header("X-Manao-Now",Long.toString(attachments.serverNow())).body(ref);}
    @GetMapping("/content") public ResponseEntity<byte[]> content(Principal principal,@PathVariable String projectId,@PathVariable String conversationId,@PathVariable String attachmentId){
        Opened opened=attachments.open(new Scope(principal.getName(),projectId,conversationId),attachmentId);
        return ResponseEntity.ok().header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff")
            .contentType(MediaType.parseMediaType(opened.metadata().mimeType())).body(opened.bytes());
    }
}
