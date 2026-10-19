package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentConversationContracts.*;

/** Owner-scoped conversation access; native entries stay on the internal boundary. */
public final class AgentConversationService {
    private final AgentConversationStore store;
    private final com.manao.poc4.project.ProjectLifecycleGate gate;
    private final PiWorkerClient worker;
    public AgentConversationService(AgentConversationStore store) { this(store, new com.manao.poc4.project.ProjectLifecycleGate(), null); }
    public AgentConversationService(AgentConversationStore store, com.manao.poc4.project.ProjectLifecycleGate gate, PiWorkerClient worker) {
        this.store = store; this.gate = gate; this.worker = worker;
    }
    public ConversationView create(String ownerId, String projectId, CreateConversationRequest request) {
        return store.create(ownerId, projectId, request);
    }
    public ConversationView detail(String ownerId, String projectId, String conversationId) {
        store.detail(ownerId, projectId, conversationId);
        reconcileProject(ownerId, projectId);
        return store.detail(ownerId, projectId, conversationId);
    }

    public ConversationView compact(String ownerId, String projectId, String conversationId, CompactRequest request) {
        store.detail(ownerId, projectId, conversationId);
        reconcileProject(ownerId, projectId);
        AgentConversationStore.CompactionAdmission admission;
        try (var lease = gate.tryAcquire(projectId).orElseThrow(AgentConversationStore::busy)) {
            admission = store.beginCompaction(ownerId, projectId, conversationId, request);
        }
        if (!admission.created()) return admission.view();
        var pending = new AgentConversationStore.PendingCompaction(conversationId, request.requestId(), request.expectedHeadSeq(), null);
        if (worker == null) { store.failCompaction(pending); return store.detail(ownerId, projectId, conversationId); }
        try {
            applyStatus(pending, worker.startCompaction(new CompactStart(conversationId, request.requestId(), request.expectedHeadSeq())));
        } catch (com.manao.poc4.api.ApiException ex) {
            if (java.util.Set.of("AI_WORKER_CONFLICT", "AI_WORKER_NOT_CONFIGURED").contains(ex.code())) store.failCompaction(pending);
            else reconcileProject(ownerId, projectId);
        } catch (RuntimeException ex) {
            reconcileProject(ownerId, projectId);
        }
        return store.detail(ownerId, projectId, conversationId);
    }

    /** Read-only worker IO is outside both the local gate and every JDBC transaction. */
    public void reconcileProject(String ownerId, String projectId) {
        var pending = store.pendingCompactions(ownerId, projectId);
        if (worker == null) return;
        for (var item : pending) {
            try { applyStatus(item, worker.compactionStatus(item.conversationId(), item.requestId())); }
            catch (RuntimeException unknown) { /* A timeout is not evidence of worker exit. */ }
        }
    }
    private void applyStatus(AgentConversationStore.PendingCompaction pending, CompactStatus status) {
        if (status == null || !pending.conversationId().equals(status.conversationId()) || !pending.requestId().equals(status.requestId())
            || status.instanceId() == null || status.instanceId().isBlank() || status.instanceId().length() > 64) return;
        if ((pending.instanceId() != null && !pending.instanceId().equals(status.instanceId()))
            || java.util.Set.of("FAILED", "NOT_FOUND", "REJECTED").contains(status.state())) {
            store.failCompaction(pending); return;
        }
        if (java.util.Set.of("RUNNING", "COMPLETED").contains(status.state())) {
            // A completed callback may already have committed; late ACK must not regress it.
            try { store.bindCompaction(pending.conversationId(), pending.requestId(), pending.baseSeq(), status.instanceId()); }
            catch (com.manao.poc4.api.ApiException terminalOrReplaced) { }
        }
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
