import { HttpClient, setHttpClient } from '../api/httpClient';
import { createAuthSession } from '../features/auth/authSession';
import { ConnectionRegistry } from '../runtime/ConnectionRegistry';
import { createQueryClient } from './queryClient';

export const authSession = createAuthSession();
export const queryClient = createQueryClient();
export const connectionRegistry = new ConnectionRegistry();

let unauthorizedInFlight = false;

function handleUnauthorized(): void {
  if (unauthorizedInFlight) {
    return;
  }
  unauthorizedInFlight = true;
  try {
    connectionRegistry.closeAll();
    queryClient.clear();
    authSession.clear('unauthorized');
  } finally {
    unauthorizedInFlight = false;
  }
}

export function logout(): void {
  connectionRegistry.closeAll();
  queryClient.clear();
  authSession.clear('logout');
}

export const httpClient = new HttpClient({
  getAccessToken: () => authSession.getAccessToken(),
  onUnauthorized: handleUnauthorized,
});

setHttpClient(httpClient);
