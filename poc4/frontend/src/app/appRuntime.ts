import { HttpClient, setHttpClient } from '../api/httpClient';
import { createAuthSession } from '../features/auth/authSession';
import { WorkspaceBufferRegistry } from '../features/editor/WorkspaceBufferRegistry';
import { workspaceSessionStore } from '../features/editor/workspaceSession';
import { ConnectionRegistry } from '../runtime/ConnectionRegistry';
import { WorkspaceResourceRegistry } from '../runtime/WorkspaceResourceRegistry';
import { createQueryClient } from './queryClient';

export const authSession = createAuthSession();
export const queryClient = createQueryClient();
export const connectionRegistry = new ConnectionRegistry();
export const workspaceResourceRegistry = new WorkspaceResourceRegistry();
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

let unauthorizedInFlight = false;

function disposeWorkspaceSession(): void {
  connectionRegistry.closeAll();
  workspaceResourceRegistry.disposeAll();
  workspaceSessionStore.getState().reset();
  queryClient.clear();
}

function handleUnauthorized(): void {
  if (unauthorizedInFlight) {
    return;
  }
  unauthorizedInFlight = true;
  try {
    disposeWorkspaceSession();
    authSession.clear('unauthorized');
  } finally {
    unauthorizedInFlight = false;
  }
}

export function logout(): void {
  disposeWorkspaceSession();
  authSession.clear('logout');
}

export const httpClient = new HttpClient({
  getAccessToken: () => authSession.getAccessToken(),
  onUnauthorized: handleUnauthorized,
});

setHttpClient(httpClient);
