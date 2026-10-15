import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { handleUnauthorized } from '@/app/appRuntime';
import type { RunId } from '@/contracts/run';
import { EMPTY_LOG_WINDOW, RunLogStore, type RunLogSnapshot } from './RunLogStore';
import { RunLogTransport } from './RunLogTransport';

const empty: RunLogSnapshot = { projectId: '', runId: '' as RunId, chunks: [], lastAppliedSeq: null, window: EMPTY_LOG_WINDOW, connection: 'idle', pendingOutput: false, error: null };
const subscribeNone = () => () => {};
const getEmpty = () => empty;

export function useRunLogEvidence(projectId: string, runId: RunId | null): RunLogSnapshot {
  const queryClient = useQueryClient();
  const [resource, setResource] = useState<RunLogStore | null>(null);
  useEffect(() => {
    if (runId === null) { setResource(null); return; }
    const store = new RunLogStore({ projectId, runId });
    const transport = new RunLogTransport({ projectId, runId, store, queryClient, onUnauthorized: handleUnauthorized });
    setResource(store);
    transport.connect();
    return () => { transport.dispose(); store.dispose(); };
  }, [projectId, queryClient, runId]);
  const store = resource?.projectId === projectId && resource.runId === runId ? resource : null;
  return useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.getSnapshot ?? getEmpty, getEmpty);
}
