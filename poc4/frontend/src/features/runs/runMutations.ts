import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getActiveRun, startRun, stopRun } from '../../api/runApi';
import type { WorkspaceRevision } from '../../contracts/file';
import { isRunLockingState, type RunSummary } from '../../contracts/run';
import { MissingWorkspaceRevisionError, projectAuthorityScope } from '../files/fileMutations';
import { getWorkspaceRevision } from '../files/fileQueries';
import type { RunAuthorityCoordinator } from './RunAuthorityCoordinator';
import { retryRunQuery, RUN_QUERY_RETRY_DELAY_MS, runKeys } from './runQueries';

export type StartRunVariables = {
  expectedWorkspaceRevision: WorkspaceRevision;
};

export function captureStartRunVariables(
  queryClient: QueryClient,
  projectId: string,
): StartRunVariables {
  const expectedWorkspaceRevision = getWorkspaceRevision(queryClient, projectId);
  if (expectedWorkspaceRevision === undefined || expectedWorkspaceRevision.length === 0) {
    throw new MissingWorkspaceRevisionError();
  }
  return { expectedWorkspaceRevision };
}

async function refetchActiveRun(queryClient: QueryClient, projectId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: runKeys.active(projectId),
    queryFn: ({ signal }) => getActiveRun(projectId, signal),
    retry: retryRunQuery,
    retryDelay: RUN_QUERY_RETRY_DELAY_MS,
    staleTime: 0,
  });
}

function applyAuthoritativeRun(queryClient: QueryClient, projectId: string, run: RunSummary): void {
  queryClient.setQueryData(runKeys.detail(projectId, run.id), run);
  if (isRunLockingState(run.state)) {
    queryClient.setQueryData(runKeys.active(projectId), { run });
  }
}

export function useStartRunMutation(projectId: string, coordinator: RunAuthorityCoordinator) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['start-run', projectId],
    scope: projectAuthorityScope(projectId),
    retry: false,
    mutationFn: async (variables: StartRunVariables) => {
      return startRun(projectId, {
        expectedWorkspaceRevision: variables.expectedWorkspaceRevision,
      });
    },
    onMutate: () => {
      coordinator.noteStartPending();
    },
    onSuccess: async (run) => {
      applyAuthoritativeRun(queryClient, projectId, run);
      void queryClient.invalidateQueries({ queryKey: runKeys.history(projectId) });
      await coordinator.reconcile('success', isRunLockingState(run.state) ? run : null);
    },
    onSettled: async () => {
      try {
        await refetchActiveRun(queryClient, projectId);
        const active = queryClient.getQueryData<{ run: RunSummary | null }>(runKeys.active(projectId));
        await coordinator.reconcile('success', active?.run ?? null);
        coordinator.clearStartPending();
      } catch {
        coordinator.noteStartPending();
      }
    },
  });
}

export function useStopRunMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['stop-run', projectId],
    scope: projectAuthorityScope(projectId),
    retry: false,
    mutationFn: async () => {
      const active = queryClient.getQueryData<{ run: RunSummary | null }>(runKeys.active(projectId));
      const runId = active?.run?.id;
      if (runId === undefined) {
        throw new Error('No active run to stop');
      }
      return stopRun(projectId, runId);
    },
    onSuccess: (run) => {
      applyAuthoritativeRun(queryClient, projectId, run);
      void queryClient.invalidateQueries({ queryKey: runKeys.history(projectId) });
    },
    onSettled: () => refetchActiveRun(queryClient, projectId),
  });
}
