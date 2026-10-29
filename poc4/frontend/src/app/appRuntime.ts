import { HttpClient, setHttpClient } from '../api/httpClient';
import { clearPythonDependencyOperationIdsForUser } from '../api/pythonDependencyApi';
import { clearAgentTaskIdsForUser } from '../api/agentTaskApi';
import {
  createAuthSession,
  type AnonymousReason,
  type AuthenticatedSnapshot,
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
 * `previous` is absent only for the defensive already-anonymous teardown below.
 */
function clearSessionState(previous?: AuthenticatedSnapshot): void {
  runCleanupStep(() => {
    if (previous === undefined) {
      return;
    }
    clearPythonDependencyOperationIdsForUser(previous.user.id);
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

/**
 * A public termination request normally ends the authenticated session through
 * authSession.clear, so the onBeforeClear callback owns the cleanup. When the
 * snapshot is already anonymous (for example a component registered a live
 * stream before login in a test harness), still tear down leftover runtime
 * resources instead of leaving them attached to no session.
 */
function endSession(reason: AnonymousReason): void {
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear(reason);
    return;
  }
  clearSessionState();
}

export function handleUnauthorized(): void {
  endSession('unauthorized');
}

export function logout(): void {
  endSession('logout');
}

export const httpClient = new HttpClient({
  getAccessToken: () => authSession.getAccessToken(),
  onUnauthorized: handleUnauthorized,
});

setHttpClient(httpClient);
