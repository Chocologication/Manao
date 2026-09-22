import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { handleUnauthorized } from '@/app/appRuntime';
import { ApiRequestError } from '@/api/ApiRequestError';
import { projectFileWritePredicate } from '@/components/files/editorSaveCommand';
import type { RunId, RunSummary } from '@/contracts/run';
import {
  resolveRunPreconditions,
  runPreconditionDescription,
} from '@/features/editor/runPreconditions';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { getWorkspaceRevision, useDirectoryTreeQuery } from '@/features/files/fileQueries';
import { parseProjectDirectoryPath } from '@/features/files/pathPolicy';
import { RunLogStore, runLogStoreKey } from '@/features/logs/RunLogStore';
import { RunLogTransport } from '@/features/logs/RunLogTransport';
import {
  isWorkspaceEditable,
  type RunAuthorityCoordinator,
} from '@/features/runs/RunAuthorityCoordinator';
import { captureStartRunVariables, useStartRunMutation, useStopRunMutation } from '@/features/runs/runMutations';
import {
  flattenRunHistoryPages,
  useActiveRunQuery,
  useRunDetailQuery,
  useRunHistoryQuery,
} from '@/features/runs/runQueries';
import { RunHistory } from './RunHistory';
import { RunLogView } from './RunLogView';
import { RunToolbar } from './RunToolbar';
import { StopRunDialog } from './StopRunDialog';

export type RunPanelProps = {
  projectId: string;
  coordinator: RunAuthorityCoordinator;
};

function runQueryFallback(error: unknown, fallback: string): string {
  if (error instanceof Error && /network request failed/i.test(error.message)) {
    return 'Network request failed';
  }
  return fallback;
}

/** Surfaces the backend hint when a run cannot start because a dependency is not ready. */
function startRunErrorMessage(error: unknown): string {
  if (
    error instanceof ApiRequestError &&
    (error.body?.code === 'DEPENDENCY_NOT_READY' ||
      error.body?.code === 'DEPENDENCY_RECOVERY_REQUIRED')
  ) {
    return error.body.message;
  }
  return 'Unable to start run';
}

function statusText(options: {
  loadingAuthority: boolean;
  reloading: boolean;
  reloadFailed: boolean;
  idleEditable: boolean;
  run: RunSummary | null;
  stopWaiting: boolean;
}): string {
  if (options.loadingAuthority) {
    return 'Loading authority';
  }
  if (options.reloadFailed) {
    return 'RELOAD_FAILED';
  }
  if (options.reloading) {
    return 'Reloading workspace';
  }
  if (options.run !== null) {
    if (options.stopWaiting) {
      return `${options.run.state} · Waiting`;
    }
    return options.run.state;
  }
  if (options.idleEditable) {
    return 'Idle';
  }
  return 'Idle';
}

export function RunPanel({ projectId, coordinator }: RunPanelProps) {
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const unconfirmedLock =
    snapshot.observedLockingRunId !== null &&
    snapshot.phase !== 'RELOADING_WORKSPACE' &&
    snapshot.phase !== 'RELOAD_FAILED';
  const activeQuery = useActiveRunQuery(projectId, unconfirmedLock);
  const historyQuery = useRunHistoryQuery(projectId);
  const startMutation = useStartRunMutation(projectId, coordinator);
  const stopMutation = useStopRunMutation(projectId);
  useDirectoryTreeQuery(projectId, parseProjectDirectoryPath(''));

  useEffect(() => {
    const status =
      activeQuery.status === 'pending' || activeQuery.status === 'error' ? activeQuery.status : 'success';
    void coordinator.reconcile(status, activeQuery.data?.run ?? null);
  }, [activeQuery.data, activeQuery.dataUpdatedAt, activeQuery.status, coordinator]);

  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const authorityMutating =
    useIsMutating({
      predicate: projectFileWritePredicate(projectId),
    }) > 0;
  const writePending = authorityMutating && !startMutation.isPending && !stopMutation.isPending;
  const startPending = snapshot.startPending || startMutation.isPending;
  const workspaceRevision = getWorkspaceRevision(queryClient, projectId);
  const preconditions = resolveRunPreconditions({
    dirtyCount,
    writePending,
    workspaceRevision,
    authorityLoaded: snapshot.phase !== 'LOADING_AUTHORITY',
    hasActiveLockingRun: snapshot.observedLockingRunId !== null,
    startPending,
    reloadPhase: snapshot.phase,
  });
  const workspaceEditable = isWorkspaceEditable(snapshot);
  const canStart = preconditions.canRequestRun;

  const historyItems = useMemo(
    () => flattenRunHistoryPages(historyQuery.data?.pages ?? []),
    [historyQuery.data],
  );
  const activeRun = activeQuery.data?.run ?? null;
  const followActiveRef = useRef(true);
  const [selectedRunId, setSelectedRunId] = useState<RunId | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [logStore, setLogStore] = useState<RunLogStore | null>(null);
  const storesRef = useRef<Map<string, RunLogStore>>(new Map());

  useEffect(() => {
    if (followActiveRef.current && activeRun !== null) {
      setSelectedRunId(activeRun.id);
      return;
    }
    setSelectedRunId((current) => {
      if (current !== null) {
        return current;
      }
      if (activeRun !== null) {
        return activeRun.id;
      }
      return historyItems[0]?.id ?? null;
    });
  }, [activeRun, historyItems]);

  const detailQuery = useRunDetailQuery(projectId, selectedRunId);
  const selectedRun =
    detailQuery.data !== undefined && detailQuery.data.id === selectedRunId
      ? detailQuery.data
      : activeRun !== null && activeRun.id === selectedRunId
        ? activeRun
        : (historyItems.find((item) => item.id === selectedRunId) ?? null);

  const ticking = selectedRun !== null && selectedRun.finishedAt === null;
  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [ticking, selectedRun?.id]);

  useEffect(() => {
    const stores = storesRef.current;
    return () => {
      for (const store of stores.values()) {
        store.dispose();
      }
      stores.clear();
    };
  }, [projectId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setLogStore(null);
      return undefined;
    }
    const key = runLogStoreKey(projectId, selectedRunId);
    let store = storesRef.current.get(key);
    if (store === undefined) {
      store = new RunLogStore({ projectId, runId: selectedRunId });
      storesRef.current.set(key, store);
    }
    setLogStore(store);
    const transport = new RunLogTransport({
      projectId,
      runId: selectedRunId,
      store,
      queryClient,
      coordinator,
      onUnauthorized: handleUnauthorized,
    });
    transport.connect();
    return () => {
      transport.dispose();
    };
  }, [coordinator, projectId, queryClient, selectedRunId]);

  const activeState = activeRun?.state;
  const canStop = (activeState === 'STARTING' || activeState === 'RUNNING') && !stopMutation.isPending;
  const stopWaiting = activeState === 'STOPPING' || activeState === 'RECOVERING';
  const loadingAuthority = snapshot.phase === 'LOADING_AUTHORITY';
  const reloading = snapshot.phase === 'RELOADING_WORKSPACE';
  const reloadFailed = snapshot.phase === 'RELOAD_FAILED';

  const onStart = useCallback(() => {
    if (!canStart) {
      return;
    }
    try {
      startMutation.mutate(captureStartRunVariables(queryClient, projectId));
    } catch {
      return;
    }
  }, [canStart, projectId, queryClient, startMutation]);

  const onSelect = useCallback(
    (runId: RunId) => {
      followActiveRef.current = activeRun?.id === runId;
      setSelectedRunId(runId);
    },
    [activeRun?.id],
  );

  return (
    <section aria-label="Run" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <RunToolbar
        run={selectedRun}
        statusText={statusText({
          loadingAuthority,
          reloading,
          reloadFailed,
          idleEditable: workspaceEditable && selectedRun === null,
          run: selectedRun,
          stopWaiting: selectedRun !== null && (selectedRun.state === 'STOPPING' || selectedRun.state === 'RECOVERING'),
        })}
        nowMs={nowMs}
        canStart={canStart}
        startTitle={
          preconditions.canRequestRun ? 'Start run' : runPreconditionDescription(preconditions.reason)
        }
        startPending={startPending}
        canStop={canStop}
        stopWaiting={stopWaiting}
        stopPending={stopMutation.isPending}
        authorityError={
          activeQuery.isError ? runQueryFallback(activeQuery.error, 'Unable to load run authority') : null
        }
        startError={startMutation.isError ? startRunErrorMessage(startMutation.error) : null}
        stopError={stopMutation.isError ? 'Unable to stop run' : null}
        reloadFailed={reloadFailed}
        onStart={onStart}
        onStop={() => {
          if (!canStop) {
            return;
          }
          setStopOpen(true);
        }}
        onRetryAuthority={() => {
          void activeQuery.refetch();
        }}
        onRetryReload={() => {
          coordinator.retryReload();
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <RunHistory
          items={historyItems}
          selectedRunId={selectedRunId}
          isPending={historyQuery.isPending}
          isError={historyQuery.isError}
          hasNextPage={historyQuery.hasNextPage}
          isFetchingNextPage={historyQuery.isFetchingNextPage}
          onSelect={onSelect}
          onLoadMore={() => {
            void historyQuery.fetchNextPage();
          }}
          onRetry={() => {
            void historyQuery.refetch();
          }}
        />
        <RunLogView key={selectedRunId ?? 'none'} store={logStore} />
      </div>
      <StopRunDialog
        open={stopOpen}
        pending={stopMutation.isPending}
        onCancel={() => {
          setStopOpen(false);
        }}
        onConfirm={() => {
          setStopOpen(false);
          stopMutation.mutate();
        }}
      />
    </section>
  );
}
