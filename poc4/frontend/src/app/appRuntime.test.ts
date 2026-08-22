import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../api/authApi';
import { ApiRequestError } from '../api/ApiRequestError';
import { getProject, listProjects } from '../api/projectApi';
import { ALICE_SEED_PROJECT_ID } from '../mocks/state';
import { server } from '../mocks/node';
import { renderApp, resetAppRuntime } from '../test/renderApp';
import { projectKeys } from '../features/projects/projectQueries';
import { authSession, connectionRegistry, logout, queryClient } from './appRuntime';

const ALICE = { username: 'alice', password: 'demo-pass' };

const UNAUTHENTICATED_BODY = {
  code: 'UNAUTHENTICATED' as const,
  message: 'Authentication required',
  traceId: 'mock-trace-unauthenticated',
};

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function seedCachedProjectQueries(): Promise<void> {
  await queryClient.prefetchQuery({
    queryKey: projectKeys.all,
    queryFn: listProjects,
    retry: false,
  });
  await queryClient.prefetchQuery({
    queryKey: projectKeys.detail(ALICE_SEED_PROJECT_ID),
    queryFn: () => getProject(ALICE_SEED_PROJECT_ID),
    retry: false,
  });
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('appRuntime unauthorized recovery', () => {
  it('handles two concurrent 401s once and shows a single expired-session alert', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closerA = vi.fn();
    const closerB = vi.fn();
    connectionRegistry.register(closerA);
    connectionRegistry.register(closerB);

    renderApp({ initialEntries: ['/projects'] });
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    server.use(
      http.get('/api/v1/projects', () =>
        HttpResponse.json(UNAUTHENTICATED_BODY, { status: 401 }),
      ),
      http.get('/api/v1/projects/:projectId', () =>
        HttpResponse.json(UNAUTHENTICATED_BODY, { status: 401 }),
      ),
    );

    await Promise.allSettled([listProjects(), getProject(ALICE_SEED_PROJECT_ID)]);

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });

    expect(closerA).toHaveBeenCalledTimes(1);
    expect(closerB).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(projectKeys.all)).toBeUndefined();
    expect(queryClient.getQueryData(projectKeys.detail(ALICE_SEED_PROJECT_ID))).toBeUndefined();
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(authSession.getAccessToken()).toBeNull();

    const echo = screen.getByTestId('location-echo');
    expect(echo).toHaveAttribute('data-pathname', '/login');
    expect(echo).toHaveAttribute('data-history-action', 'REPLACE');

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/session has expired/i);
    expect(alerts[0]).not.toHaveTextContent('mem-token');
    expect(alerts[0]).not.toHaveTextContent(UNAUTHENTICATED_BODY.traceId);
    expect(screen.queryByText('Alice Notebook')).not.toBeInTheDocument();
  });
});

describe('appRuntime stale session 401', () => {
  it('does not clear Bob when a delayed Alice 401 arrives', async () => {
    await authenticateAsAlice();
    const aliceToken = authSession.getAccessToken();
    expect(aliceToken).toBeTruthy();

    let releaseAlice: () => void = () => {};
    const aliceHold = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    let interceptedAliceList = false;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (
        !interceptedAliceList &&
        /\/api\/v1\/projects\/?$/.test(url) &&
        authorization === `Bearer ${aliceToken}`
      ) {
        interceptedAliceList = true;
        await aliceHold;
        return new Response(JSON.stringify(UNAUTHENTICATED_BODY), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const pendingAliceList = listProjects();
      logout();

      const bob = await login({ username: 'bob', password: 'demo-pass' });
      authSession.authenticate(bob);

      renderApp({ initialEntries: ['/projects'] });
      expect(await screen.findByRole('article', { name: 'Bob Lab' })).toBeInTheDocument();
      expect(screen.queryByText('Alice Notebook')).not.toBeInTheDocument();

      const closer = vi.fn();
      connectionRegistry.register(closer);

      releaseAlice();
      const aliceError = await pendingAliceList.catch((reason: unknown) => reason);
      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });

      expect(closer).not.toHaveBeenCalled();
      expect(authSession.getSnapshot()).toMatchObject({
        status: 'authenticated',
        user: { username: 'bob' },
      });
      expect(screen.getByRole('article', { name: 'Bob Lab' })).toBeInTheDocument();
      expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('appRuntime login 401', () => {
  it('does not clear cache or connections when login credentials are invalid', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closer = vi.fn();
    connectionRegistry.register(closer);

    const error = await login({ username: 'alice', password: 'wrong-pass' }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });
    expect(closer).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    expect(queryClient.getQueryData(projectKeys.all)).toBeDefined();
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(authSession.getAccessToken()).not.toBeNull();
  });

  it('shows invalid credentials without an expired-session banner or cache clear', async () => {
    const user = userEvent.setup();
    queryClient.setQueryData(projectKeys.all, { items: [], limit: 3 });
    const closer = vi.fn();
    connectionRegistry.register(closer);

    renderApp({ initialEntries: ['/login'] });
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid username or password/i);
    expect(alert).not.toHaveTextContent(/session has expired/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(closer).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(projectKeys.all)).toEqual({ items: [], limit: 3 });
    const snapshot = authSession.getSnapshot();
    expect(snapshot.status).toBe('anonymous');
    expect(snapshot).not.toMatchObject({ reason: 'unauthorized' });
    expect(snapshot).not.toMatchObject({ reason: 'expired' });
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });
});

describe('appRuntime explicit logout', () => {
  it('clears connections, query cache and auth without an expired-session message', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closerA = vi.fn();
    const closerB = vi.fn();
    connectionRegistry.register(closerA);
    connectionRegistry.register(closerB);

    renderApp({ initialEntries: ['/projects'] });
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /log out/i }));

    expect(closerA).toHaveBeenCalledTimes(1);
    expect(closerB).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(projectKeys.all)).toBeUndefined();
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(authSession.getAccessToken()).toBeNull();

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Alice Notebook')).not.toBeInTheDocument();

    const echo = screen.getByTestId('location-echo');
    expect(echo).toHaveAttribute('data-pathname', '/login');
    expect(echo).toHaveAttribute('data-history-action', 'REPLACE');
  });
});

describe('unknown routes', () => {
  it('renders NotFoundPage without the unexpected-error recovery view', () => {
    renderApp({ initialEntries: ['/missing'] });

    expect(screen.getByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to projects/i })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('heading', { name: /something went wrong/i })).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/stack|jwt|password|traceId/i);
  });
});
