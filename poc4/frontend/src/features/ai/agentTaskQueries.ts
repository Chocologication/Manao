import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { clearAgentTaskId, closeAgentTask, pauseAgentTask, getAgentTask, getCurrentAgentTask, readAgentTaskId, readAgentTaskIntent } from '../../api/agentTaskApi';
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

export async function fetchCurrentAgentTask(projectId: string, userId?: string, reconcilePending = true): Promise<AgentTaskSnapshot | null> {
  // A current read started before a new POST must never discover/clear that new intent.
  const pending = userId && reconcilePending ? readAgentTaskIntent(userId, projectId) : null;
  try {
    return await getCurrentAgentTask(projectId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      const pendingId = pending?.taskId ?? null;
      if (pendingId === null) return null;
      try {
        const found = await getAgentTask(projectId, pendingId);
        if (found.taskId !== pendingId || pending!.conversationId !== null && found.conversationId !== pending!.conversationId || readAgentTaskId(userId!, projectId) !== pendingId) throw new Error('Unconfirmed agent task identity');
        return found;
      }
      catch (pendingError) {
        if (pendingError instanceof ApiRequestError && pendingError.status === 404) {
          clearAgentTaskId(userId!, projectId, pendingId);
          return null;
        }
        throw pendingError;
      }
    }
    throw error;
  }
}

export function useCurrentAgentTaskQuery(projectId: string, enabled: boolean, userId?: string, reconcilePending = true) {
  return useQuery({
    queryKey: agentTaskKeys.current(projectId),
    queryFn: () => fetchCurrentAgentTask(projectId, userId, reconcilePending),
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
      // Close records intent and may return NEEDS_ATTENTION with writesLocked.
      // Preserve that snapshot until polling confirms terminal state or absence.
      queryClient.setQueryData(agentTaskKeys.current(projectId), snapshot);
    },
  });
}

export function usePauseAgentTaskMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => pauseAgentTask(projectId, taskId),
    onSuccess: snapshot => { queryClient.setQueryData(agentTaskKeys.current(projectId), snapshot); },
  });
}
