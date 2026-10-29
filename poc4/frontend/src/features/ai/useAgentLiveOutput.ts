import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/ApiRequestError';
import { getAgentLiveOutput } from '@/api/agentConversationApi';
import { getMe } from '@/api/authApi';
import {
  authSession,
  connectionRegistry,
  handleSessionRevoked,
} from '@/app/appRuntime';
import {
  consumeLiveOutput,
  LiveOutputError,
  LiveOutputRevokedError,
  type LiveSnapshot,
} from './agentLiveOutput';

export type LiveScope = {
  userId: string;
  projectId: string;
  conversationId: string;
  taskId: string | null;
  enabled?: boolean;
};
export type LiveConnectionState = 'connecting' | 'live' | 'reconnecting' | 'history' | 'unavailable';

export function useAgentLiveOutput({
  userId,
  projectId,
  conversationId,
  taskId,
  enabled = true,
}: LiveScope) {
  const identity = JSON.stringify([userId, projectId, conversationId, taskId]);
  const [state, setState] = useState<{
    identity: string;
    latest: LiveSnapshot | null;
    connectionState: LiveConnectionState;
  }>({ identity, latest: null, connectionState: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    // Every stream belongs to the auth snapshot that existed when it opened:
    // a delayed revocation or /auth/me answer can never clear a newer login.
    const connectionSnapshot = authSession.getSnapshot();
    let closedByCleanup = false;
    let autoReconnectUsed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const unregister = connectionRegistry.register(() => {
      controller.abort();
      if (!closedByCleanup) {
        closedByCleanup = true;
        setState({ identity, latest: null, connectionState: 'history' });
      }
    });
    const update = (connectionState: LiveConnectionState) => {
      if (controller.signal.aborted) return;
      setState((old) => ({
        identity,
        latest: old.identity === identity ? old.latest : null,
        connectionState,
      }));
    };
    if (!enabled || !taskId || !userId) {
      update('history');
      return () => {
        unregister();
        controller.abort();
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      };
    }
    update('connecting');

    /**
     * A stream that ends without auth.revoked (normal EOF, reader failure,
     * malformed frame or a rejected HTTP response) gets exactly ONE /auth/me
     * check. The check suppresses the shared HttpClient 401 cleanup so the
     * captured snapshot owns the decision: a 401 runs the snapshot-guarded
     * unified cleanup, and every other failure only shows "disconnected".
     * There is no infinite reconnect loop and no auto-relogin; a verified
     * session gets at most one bounded retry for network-ish endings.
     */
    const verifySessionOnce = async (allowBoundedReconnect: boolean): Promise<void> => {
      try {
        await getMe({ suppressUnauthorized: true });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          handleSessionRevoked(connectionSnapshot);
          update('unavailable');
          return;
        }
        // A network/5xx answer is only a disconnected display: no timer retry
        // and never an automatic re-login.
        update('unavailable');
        return;
      }
      if (controller.signal.aborted) return;
      if (allowBoundedReconnect && !autoReconnectUsed) {
        // The session is still valid: allow exactly ONE bounded reconnect for a
        // transient stream end. A second abnormal end shows "disconnected"
        // instead of looping forever.
        autoReconnectUsed = true;
        update('reconnecting');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          if (!controller.signal.aborted) void connect();
        }, 1000);
        return;
      }
      update('unavailable');
    };

    const connect = async () => {
      try {
        const response = await getAgentLiveOutput(projectId, taskId, controller.signal);
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        if (response.status === 204) {
          update('history');
          return;
        }
        if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
          throw new LiveOutputError('Invalid stream content type');
        }
        await consumeLiveOutput(
          response,
          (latest) => {
            if (controller.signal.aborted) return;
            if (latest.taskId !== taskId || latest.conversationId !== conversationId) return;
            setState((old) =>
              old.identity === identity &&
              old.latest !== null &&
              old.latest.revision >= latest.revision
                ? old
                : {
                    identity,
                    latest,
                    connectionState: latest.unavailable ? 'unavailable' : 'live',
                  },
            );
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        await verifySessionOnce(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof LiveOutputRevokedError) {
          handleSessionRevoked(connectionSnapshot);
          update('unavailable');
          return;
        }
        if (error instanceof LiveOutputError || error instanceof ApiRequestError) {
          // Malformed frames / rejected HTTP stream responses still count as an
          // abnormal end: run the one-shot identity check, then show disconnected.
          await verifySessionOnce(false);
          return;
        }
        await verifySessionOnce(true);
      }
    };
    void connect();
    return () => {
      unregister();
      controller.abort();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, [identity, userId, projectId, conversationId, taskId, enabled, attempt]);
  return {
    latest: state.identity === identity ? state.latest : null,
    connectionState:
      state.identity === identity ? state.connectionState : ('connecting' as LiveConnectionState),
    retry,
  };
}
