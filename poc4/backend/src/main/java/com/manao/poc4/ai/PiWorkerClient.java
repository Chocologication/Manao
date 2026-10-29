package com.manao.poc4.ai;

/**
 * The worker seam of the task lifecycle: start carries the persisted fencing epoch
 * and never a project owner; status serves the lost-start reconciliation path; stop
 * aborts the running session. Implementations never release the project's occupancy
 * by themselves — release happens only through the backend close flow.
 */
public interface PiWorkerClient {

    AgentContracts.WorkerStatus start(AgentContracts.WorkerStart start);

    AgentContracts.WorkerStatus status(String taskId);

    AgentContracts.WorkerStatus stop(String taskId);

    default AgentContracts.WorkerProcessStatus processStatus() {
        throw new com.manao.poc4.api.ApiException("AI_WORKER_BAD_RESPONSE", 502, "Worker protocol unavailable");
    }

    default AgentConversationContracts.CompactStatus startCompaction(AgentConversationContracts.CompactStart start) {
        throw new com.manao.poc4.api.ApiException("AI_WORKER_NOT_CONFIGURED", 503, "Worker unavailable");
    }
    default AgentConversationContracts.CompactStatus compactionStatus(String conversationId, String requestId) {
        throw new com.manao.poc4.api.ApiException("AI_WORKER_UNREACHABLE", 502, "Worker unavailable");
    }
}
