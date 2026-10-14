import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { closeAgentTask, getCurrentAgentTask } from '../../api/agentTaskApi';
import type { AgentTaskSnapshot } from '../../contracts/agentTask';

/**
 * Query scope for the browser agent task. The shell polls GET current every
 * two seconds while the AI stage is enabled; a 404 means the project is free,
 * every other failure stays an error so the UI never pretends the workspace is
 * free while it cannot know.
 */

export const agentTaskKeys = {
  all: (projectId: string) => ['agent-task', projectId] as const,
  current: (projectId: string) => ['agent-task', projectId, 'current'] as const,
  task: (projectId: string, taskId: string) =>
    ['agent-task', projectId, 'task', taskId] as const,
};

const AGENT_TASK_POLL_INTERVAL_MS = 2_000;

export async function fetchCurrentAgentTask(projectId: string): Promise<AgentTaskSnapshot | null> {
  try {
    return await getCurrentAgentTask(projectId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export function useCurrentAgentTaskQuery(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: agentTaskKeys.current(projectId),
    queryFn: () => fetchCurrentAgentTask(projectId),
    refetchInterval: AGENT_TASK_POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });
}

export function useCloseAgentTaskMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => closeAgentTask(projectId, taskId),
    onSuccess: (snapshot) => {
      // The closed task is terminal, so GET current would answer 404 within two
      // seconds; seeding the snapshot keeps the settled result visible meanwhile.
      queryClient.setQueryData(agentTaskKeys.current(projectId), snapshot);
    },
  });
}
