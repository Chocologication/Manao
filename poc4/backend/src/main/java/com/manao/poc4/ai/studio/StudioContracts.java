package com.manao.poc4.ai.studio;

import java.util.List;

public final class StudioContracts {
    private StudioContracts() { }
    public record ModelInput(String id, String label, String baseUrl, String model, String apiKey,
                             boolean vision, boolean tools) {
        @Override public String toString() { return "ModelInput[id=" + id + "]"; }
    }
    public record ModelView(String id, String label, String baseUrl, String model,
                            boolean vision, boolean tools, boolean keyConfigured) { }
    public record ModelSecret(String id, String baseUrl, String model, String apiKey, boolean vision, boolean tools) {
        @Override public String toString() { return "ModelSecret[id=" + id + "]"; }
    }
    public record Conversation(String id, String title, String updatedAt) { }
    public record Reference(String kind, String path, String text) { }
    public record TurnInput(String id, String prompt, String mode, String applyPolicy, String modelId,
                            String expectedRevision, List<String> attachmentIds, List<Reference> references) { }
    public record Attachment(String id, String name, String mediaType, long size, boolean truncated) { }
    public record Upload(String name, String mediaType, String base64) { }
    public record ApplyInput(String requestId, List<String> hunkIds, String expectedRevision) { }
    public record Hunk(String id, int start, List<String> before, List<String> after) { }
    public record FileChange(String path, String before, String after, String beforeSha256,
                             List<Hunk> hunks) { }
}
