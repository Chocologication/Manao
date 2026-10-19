import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/ApiRequestError';
import { getAgentLiveOutput } from '@/api/agentConversationApi';
import { connectionRegistry } from '@/app/appRuntime';
import { consumeLiveOutput, LiveOutputError, type LiveSnapshot } from './agentLiveOutput';
export type LiveScope = { userId: string; projectId: string; conversationId: string; taskId: string | null; enabled?: boolean };
export type LiveConnectionState = 'connecting' | 'live' | 'reconnecting' | 'history' | 'unavailable';
export function useAgentLiveOutput({ userId, projectId, conversationId, taskId, enabled = true }: LiveScope) {
  const identity = JSON.stringify([userId, projectId, conversationId, taskId]);
  const [state, setState] = useState<{ identity: string; latest: LiveSnapshot | null; connectionState: LiveConnectionState }>({ identity, latest: null, connectionState: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const unregister = connectionRegistry.register(() => { controller.abort(); clearTimeout(timer); setState({ identity, latest: null, connectionState: 'history' }); });
    const update = (connectionState: LiveConnectionState) => { if (!controller.signal.aborted) setState(old => ({ identity, latest: old.identity === identity ? old.latest : null, connectionState })); };
    if (!enabled || !taskId || !userId) { update('history'); return () => { unregister(); controller.abort(); }; }
    update('connecting');
    const connect = async () => {
      try {
        const response = await getAgentLiveOutput(projectId, taskId, controller.signal);
        if (controller.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
        if (response.status === 204) { update('history'); return; }
        if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) throw new LiveOutputError('Invalid stream content type');
        await consumeLiveOutput(response, latest => {
          if (controller.signal.aborted || latest.taskId !== taskId || latest.conversationId !== conversationId) return;
          setState(old => old.identity === identity && old.latest !== null && old.latest.revision >= latest.revision ? old : { identity, latest, connectionState: latest.unavailable ? 'unavailable' : 'live' });
        }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof LiveOutputError || error instanceof ApiRequestError) { update('unavailable'); return; }
      }
      if (!controller.signal.aborted) { update('reconnecting'); timer = setTimeout(() => void connect(), [1000, 2000, 5000][Math.min(failures++, 2)]); }
    };
    void connect();
    return () => { unregister(); controller.abort(); clearTimeout(timer); };
  }, [identity, userId, projectId, conversationId, taskId, enabled, attempt]);
  return { latest: state.identity === identity ? state.latest : null, connectionState: state.identity === identity ? state.connectionState : 'connecting' as LiveConnectionState, retry };
}
