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
     * A stream that ends without auth.revoked (normal EOF, reader failure or a
     * rejected request) gets exactly ONE /auth/me check. A 401 runs the unified
     * snapshot-guarded cleanup; every other failure only shows "disconnected".
     * There is deliberately no timer-driven reconnect loop and no auto-relogin.
     */
    const verifySessionOnce = async (): Promise<void> => {
      try {
        await getMe();
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
      if (!autoReconnectUsed) {
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
        await verifySessionOnce();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof LiveOutputRevokedError) {
          handleSessionRevoked(connectionSnapshot);
          update('unavailable');
          return;
        }
        if (error instanceof LiveOutputError || error instanceof ApiRequestError) {
          update('unavailable');
          return;
        }
        await verifySessionOnce();
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
