package com.manao.poc4.ai;

import java.util.List;

public final class AgentAttachmentContracts {
    private AgentAttachmentContracts() { }
    public record Scope(String ownerId, String projectId, String conversationId) { }
    public record AttachmentRef(String kind, int version, String attachmentId, String fileName, String mimeType,
        long sizeBytes, String sha256, String uploadedAt, String expiresAt, String taskId, String availability) { }
    public record AttachmentPage(String kind, List<AttachmentRef> items, String nextCursor) { }
    public record Opened(AttachmentRef metadata, byte[] bytes) { }
    public record ReapResult(int deleted, int failed) { }
}
