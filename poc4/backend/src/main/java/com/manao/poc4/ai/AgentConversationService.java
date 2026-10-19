package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentConversationContracts.*;

/** Owner-scoped conversation access; native entries stay on the internal boundary. */
public final class AgentConversationService {
    private final AgentConversationStore store;
    public AgentConversationService(AgentConversationStore store) { this.store = store; }
    public ConversationView create(String ownerId, String projectId, CreateConversationRequest request) {
        return store.create(ownerId, projectId, request);
    }
    public ConversationView detail(String ownerId, String projectId, String conversationId) {
        return store.detail(ownerId, projectId, conversationId);
    }
    public ConversationPage list(String ownerId, String projectId, String before, int limit) {
        return store.list(ownerId, projectId, before, limit);
    }
    public HistoryPage history(String ownerId, String projectId, String conversationId, Long beforeSeq, int limit) {
        return store.history(ownerId, projectId, conversationId, beforeSeq, limit);
    }
    public HistoryPage history(String ownerId, String projectId, String conversationId, Long beforeSeq, Integer beforeOffset, int limit) {
        return store.history(ownerId, projectId, conversationId, beforeSeq, beforeOffset, limit);
    }
}
