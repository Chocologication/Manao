import { HttpClient, setHttpClient } from '../api/httpClient';
import { clearPythonDependencyOperationIdsForUser } from '../api/pythonDependencyApi';
import { clearAgentTaskIdsForUser } from '../api/agentTaskApi';
import {
  createAuthSession,
  type AuthenticatedSnapshot,
  type AuthSnapshot,
} from '../features/auth/authSession';
import { resetUnsavedDialog } from '../features/editor/unsavedChangesGuard';
import { WorkspaceBufferRegistry } from '../features/editor/WorkspaceBufferRegistry';
import { workspaceSessionStore } from '../features/editor/workspaceSession';
import { ConnectionRegistry } from '../runtime/ConnectionRegistry';
import { WorkspaceResourceRegistry } from '../runtime/WorkspaceResourceRegistry';
import { createQueryClient } from './queryClient';

export const authSession = createAuthSession({ onBeforeClear: clearSessionState });
export const queryClient = createQueryClient();
export const connectionRegistry = new ConnectionRegistry();
export const workspaceResourceRegistry = new WorkspaceResourceRegistry();

export type TerminalRuntimeResource = {
  closeConnection(): void;
  disposeWorkspace(): void;
};

export function registerTerminalRuntimeResource(resource: TerminalRuntimeResource): () => void {
  const unregisterConnection = connectionRegistry.register(() => {
    resource.closeConnection();
  });
  const unregisterWorkspace = workspaceResourceRegistry.register(() => {
    unregisterConnection();
    resource.disposeWorkspace();
  });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    unregisterConnection();
    unregisterWorkspace();
  };
}

export const workspaceBufferRegistry = new WorkspaceBufferRegistry((projectId, path, dirty) => {
  const session = workspaceSessionStore.getState();
  if (session.projectId !== projectId) {
    return;
  }
  session.setDirty(path, dirty);
});

workspaceResourceRegistry.registerLazy(() => {
  workspaceBufferRegistry.disposeAll();
});

/** One failing cleanup step must not skip the remaining steps or the auth clear. */
function runCleanupStep(step: () => void): void {
  try {
    step();
  } catch {
    // The remaining session cleanup still runs; authSession.clear has its own finally.
  }
}

/**
 * Logout, natural expiry and a current-token 401 all end through this cleanup.
 * User-scoped ids and live state belong to the previous user, never to the next session.
 */
function clearSessionState(previous: AuthenticatedSnapshot): void {
  runCleanupStep(() => {
    clearPythonDependencyOperationIdsForUser(previous.user.id);
  });
  runCleanupStep(() => {
    clearAgentTaskIdsForUser(previous.user.id);
  });
  runCleanupStep(() => {
    connectionRegistry.closeAll();
  });
  runCleanupStep(() => {
    workspaceResourceRegistry.disposeAll();
  });
  runCleanupStep(() => {
    workspaceSessionStore.getState().reset();
  });
  runCleanupStep(() => {
    resetUnsavedDialog();
  });
  runCleanupStep(() => {
    queryClient.clear();
  });
}

export function handleUnauthorized(): void {
  authSession.clear('unauthorized');
}

/** One-shot confirmations displayed on the login page after a session-ending flow. */
export type LoginLifecycleNotice = 'registered' | 'passwordReset' | 'passwordChanged';

let pendingLoginNotice: LoginLifecycleNotice | null = null;

/**
 * Router location state is not a reliable carrier for the change-password
 * confirmation: RequireAuth's anonymous redirect can overwrite it with
 * { from: ... }. Keep the one-shot notice in memory only (never localStorage,
 * sessionStorage or the URL); LoginPage consumes and clears it on render.
 */
export function postLoginNotice(notice: LoginLifecycleNotice): void {
  pendingLoginNotice = notice;
}

export function consumeLoginNotice(): LoginLifecycleNotice | null {
  const notice = pendingLoginNotice;
  pendingLoginNotice = null;
  return notice;
}

/**
 * Stream revocation must only clear the session it was opened under: a late
 * 4401/revoked event from an old connection can never terminate a newer login.
 */
export function handleSessionRevoked(expected: AuthSnapshot): void {
  if (expected.status === 'authenticated' && authSession.getSnapshot() === expected) {
    authSession.clear('unauthorized');
  }
}

export function logout(): void {
  authSession.clear('logout');
}

export const httpClient = new HttpClient({
  getAccessToken: () => authSession.getAccessToken(),
  onUnauthorized: handleUnauthorized,
});

setHttpClient(httpClient);
