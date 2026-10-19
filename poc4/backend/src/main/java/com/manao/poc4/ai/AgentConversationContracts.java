package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Internal native entries and browser projections deliberately use separate records. */
public final class AgentConversationContracts {
    private AgentConversationContracts() { }
    public record CreateConversationRequest(String conversationId) { }
    public record CompactRequest(String requestId, long expectedHeadSeq) { }
    public record ContextUsage(Long tokens, long contextWindow, Double percent) { }
    public record StoredEntry(long seq, String sourceTaskId, String writerId, JsonNode entry) { }
    public record ContextPage(JsonNode header, long headSeq, List<StoredEntry> entries, Long nextAfterSeq) { }
    public record ContextAppend(long expectedHeadSeq, JsonNode header, List<JsonNode> entries, ContextUsage usage) { }
    public record ContextAck(long headSeq) { }
    public record CompactResult(long expectedHeadSeq, List<JsonNode> entries, ContextUsage usage, String failureCode) { }
    public record ConversationView(String conversationId, String title, long headSeq,
                                   String lastTaskId, String activeTaskId, ContextUsage usage,
                                   String compactRequestId, String compactState, String compactFailureCode, String nextReasoningEffort) {
        public ConversationView(String conversationId, String title, long headSeq, String lastTaskId, String activeTaskId, ContextUsage usage,
                                String compactRequestId, String compactState, String compactFailureCode) {
            this(conversationId, title, headSeq, lastTaskId, activeTaskId, usage, compactRequestId, compactState, compactFailureCode, "high");
        }
    }
    public record ConversationPage(List<ConversationView> items, String nextCursor) { }
    public record HistoryItem(long seq, String taskId, String kind, String text, String toolCallId, int textOffset,
                              int contentIndex, boolean modelTruncated) {
        public HistoryItem(long seq, String taskId, String kind, String text, String toolCallId, int textOffset) {
            this(seq, taskId, kind, text, toolCallId, textOffset, 0, false);
        }
        public HistoryItem(long seq, String taskId, String kind, String text, String toolCallId) {
            this(seq, taskId, kind, text, toolCallId, 0);
        }
    }
    public record HistoryPage(List<HistoryItem> items, Long nextBeforeSeq, Integer nextBeforeOffset) {
        public HistoryPage(List<HistoryItem> items, Long nextBeforeSeq) { this(items, nextBeforeSeq, null); }
    }
    public record CompactStart(String conversationId, String requestId, long expectedHeadSeq) { }
    public record CompactStatus(String conversationId, String requestId, String instanceId, String state) { }
}
