import { useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { listTerminalAudits } from '../../api/terminalApi';
import type { RunId } from '../../contracts/run';
import type { JobTerminalPhase } from './JobTerminalController';

export const TERMINAL_AUDIT_QUERY_MAX_RETRIES = 2;
export const TERMINAL_AUDIT_QUERY_RETRY_DELAY_MS = 10;
export const TERMINAL_AUDIT_POLL_MS = 2_000;

export const terminalAuditKeys = {
  all: (projectId: string) => ['terminal-audits', projectId] as const,
  list: (projectId: string, runId: RunId) =>
    ['terminal-audits', projectId, runId] as const,
};

export function retryTerminalAuditQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= TERMINAL_AUDIT_QUERY_MAX_RETRIES) return false;
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return false;
    return error.status >= 500;
  }
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function terminalAuditRefetchInterval(phase: JobTerminalPhase): number | false {
  return phase === 'ready' || phase === 'paused' ? TERMINAL_AUDIT_POLL_MS : false;
}

export function useTerminalAuditQuery(
  projectId: string,
  runId: RunId,
  phase: JobTerminalPhase,
) {
  return useInfiniteQuery({
    queryKey: terminalAuditKeys.list(projectId, runId),
    queryFn: ({ pageParam, signal }) =>
      listTerminalAudits(projectId, runId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: projectId.length > 0,
    retry: retryTerminalAuditQuery,
    retryDelay: TERMINAL_AUDIT_QUERY_RETRY_DELAY_MS,
    refetchInterval: terminalAuditRefetchInterval(phase),
  });
}

export function invalidateTerminalAudits(
  queryClient: QueryClient,
  projectId: string,
  runId: RunId,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: terminalAuditKeys.list(projectId, runId),
    exact: true,
  });
}
