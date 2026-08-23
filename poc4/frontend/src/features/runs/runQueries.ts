import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getActiveRun, getRun, listRuns } from '../../api/runApi';
import {
  isRunLockingState,
  isRunTerminalState,
  type ActiveRunResponse,
  type RunId,
  type RunListResponse,
  type RunSummary,
} from '../../contracts/run';

export const RUN_QUERY_MAX_RETRIES = 2;
export const RUN_QUERY_RETRY_DELAY_MS = 10;
export const ACTIVE_RUN_POLL_MS = 5_000;

export const runKeys = {
  all: (projectId: string) => ['project-runs', projectId] as const,
  active: (projectId: string) => ['project-runs', projectId, 'active'] as const,
  detail: (projectId: string, runId?: RunId) =>
    runId === undefined
      ? (['project-runs', projectId, 'detail'] as const)
      : (['project-runs', projectId, 'detail', runId] as const),
  history: (projectId: string) => ['project-runs', projectId, 'history'] as const,
};

export function retryRunQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= RUN_QUERY_MAX_RETRIES) {
    return false;
  }
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      return false;
    }
    return error.status >= 500;
  }
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function activeRunRefetchInterval(query: {
  state: { data: ActiveRunResponse | undefined };
}): number | false {
  const run = query.state.data?.run;
  if (run === undefined || run === null || !isRunLockingState(run.state)) {
    return false;
  }
  return ACTIVE_RUN_POLL_MS;
}

export function flattenRunHistoryPages(pages: readonly RunListResponse[]): RunSummary[] {
  const seen = new Set<string>();
  const items: RunSummary[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
    }
  }
  return items.slice().sort((left, right) => {
    const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (byTime !== 0) {
      return byTime;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
}

export async function requireTerminalRun(
  projectId: string,
  runId: RunId,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const summary = await getRun(projectId, runId, signal);
  if (!isRunTerminalState(summary.state)) {
    throw new Error('Run is not terminal');
  }
  return summary;
}

export function useActiveRunQuery(projectId: string) {
  return useQuery({
    queryKey: runKeys.active(projectId),
    queryFn: ({ signal }) => getActiveRun(projectId, signal),
    enabled: projectId.length > 0,
    retry: retryRunQuery,
    retryDelay: RUN_QUERY_RETRY_DELAY_MS,
    refetchInterval: activeRunRefetchInterval,
  });
}

export function useRunDetailQuery(projectId: string, runId: RunId | null) {
  return useQuery({
    queryKey: runId === null ? runKeys.detail(projectId) : runKeys.detail(projectId, runId),
    queryFn: ({ signal }) => {
      if (runId === null) {
        throw new Error('Run id is required');
      }
      return getRun(projectId, runId, signal);
    },
    enabled: projectId.length > 0 && runId !== null,
    retry: retryRunQuery,
    retryDelay: RUN_QUERY_RETRY_DELAY_MS,
  });
}

export function useRunHistoryQuery(projectId: string) {
  return useInfiniteQuery({
    queryKey: runKeys.history(projectId),
    queryFn: ({ pageParam, signal }) => listRuns(projectId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: projectId.length > 0,
    retry: retryRunQuery,
    retryDelay: RUN_QUERY_RETRY_DELAY_MS,
  });
}
