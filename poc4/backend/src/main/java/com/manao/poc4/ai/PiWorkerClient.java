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
}
