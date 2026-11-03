package com.manao.poc4.workspaceagent;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/agent/v1/attachments/{id}")
public final class WorkspaceAttachmentController {
    private final WorkspaceAttachmentService attachments;
    public WorkspaceAttachmentController(WorkspaceAttachmentService attachments) { this.attachments = attachments; }
    @PutMapping public WorkspaceAttachmentService.Meta put(@PathVariable String id, @RequestParam String sha256,
        @RequestParam long expiresAt, @RequestBody byte[] bytes) { return attachments.put(id, sha256, expiresAt, bytes); }
    @GetMapping public WorkspaceAttachmentService.Meta confirm(@PathVariable String id) { return attachments.confirm(id); }
    @GetMapping("/content") public ResponseEntity<byte[]> open(@PathVariable String id, @RequestParam String sha256,
        @RequestParam long expiresAt) { return ResponseEntity.ok().header("Cache-Control", "private, no-store")
            .header("Content-Type", "application/octet-stream").body(attachments.open(id, sha256, expiresAt)); }
    @DeleteMapping public Map<String, Boolean> delete(@PathVariable String id) { attachments.delete(id); return Map.of("deleted", true); }
    @ExceptionHandler(WorkspaceAttachmentService.Failure.class) public ResponseEntity<?> error(WorkspaceAttachmentService.Failure ex) {
        return ResponseEntity.status(ex.status).body(Map.of("code", ex.code, "message", ex.code));
    }
}
