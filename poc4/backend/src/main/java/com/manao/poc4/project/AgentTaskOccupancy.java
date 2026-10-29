package com.manao.poc4.project;

/**
 * The durable side of the project write ownership, checked beside the in-memory
 * {@link ProjectLifecycleGate}: while an AI agent task occupies a project, every browser
 * write entry refuses inside its own gate critical section. The check is a plain durable
 * read — serialization comes from the shared gate and from the task store's project row
 * lock, not from this query.
 */
@FunctionalInterface
public interface AgentTaskOccupancy {
    /** Refuses with a conflict code while an agent task owns the project's writes. */
    void requireBrowserWritable(String projectId);

    /** Disabled AI and existing lambda implementations refuse every agent Run operation. */
    default void requireAgentRunCall(String taskId, String projectId, String toolCallId,
                                     String action, String runId) {
        throw new com.manao.poc4.api.ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
    }
}
