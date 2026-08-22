import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../api/authApi';
import { ApiRequestError } from '../api/ApiRequestError';
import { downloadFileBlob, getFileContent, getFileMetadata, listDirectory } from '../api/fileApi';
import { getProject, listProjects } from '../api/projectApi';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID } from '../mocks/state';
import { server } from '../mocks/node';
import { renderApp, resetAppRuntime } from '../test/renderApp';
import { useWorkspaceSession, workspaceSessionStore } from '../features/editor/workspaceSession';
import { fileKeys } from '../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import { projectKeys } from '../features/projects/projectQueries';
import { disposeAllProjectModels, toProjectModelUri } from '../lib/projectMonacoModels';
import {
  authSession,
  connectionRegistry,
  logout,
  queryClient,
  workspaceResourceRegistry,
} from './appRuntime';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');
const APP = parseProjectRelativePath('src/main/java/demo/App.java');
const SRC = parseProjectRelativePath('src');
const LAB_NOTES = parseProjectRelativePath('lab-notes.md');
const ROOT = parseProjectDirectoryPath('');
const SRC_DIR = parseProjectDirectoryPath('src');

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

function seedWorkspaceSession(projectId: string, relativePath: string): void {
  const store = workspaceSessionStore.getState();
  store.activateProject(projectId);
  store.openFile(parseProjectRelativePath(relativePath));
}

function expectEmptyWorkspaceSession(): void {
  const state = workspaceSessionStore.getState();
  expect(state.projectId).toBeNull();
  expect(state.openPaths).toEqual([]);
  expect(state.activePath).toBeNull();
  expect(state.selectedPath).toBeNull();
  expect(state.expandedPaths.size).toBe(0);
}

async function prefetchFileQuery(
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
): Promise<void> {
  await queryClient.prefetchQuery({
    queryKey,
    queryFn,
    retry: false,
  });
}

async function seedAliceOpenFiles(): Promise<{ pomUri: monaco.Uri; appUri: monaco.Uri }> {
  const store = workspaceSessionStore.getState();
  store.activateProject(ALICE_SEED_PROJECT_ID);
  store.toggleDirectory(SRC);
  store.openFile(POM);
  store.openFile(APP);

  await prefetchFileQuery(fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT), () =>
    listDirectory(ALICE_SEED_PROJECT_ID, ROOT),
  );
  await prefetchFileQuery(fileKeys.tree(ALICE_SEED_PROJECT_ID, SRC_DIR), () =>
    listDirectory(ALICE_SEED_PROJECT_ID, SRC_DIR),
  );
  await prefetchFileQuery(fileKeys.meta(ALICE_SEED_PROJECT_ID, POM), () =>
    getFileMetadata(ALICE_SEED_PROJECT_ID, POM),
  );
  await prefetchFileQuery(fileKeys.content(ALICE_SEED_PROJECT_ID, POM), () =>
    getFileContent(ALICE_SEED_PROJECT_ID, POM),
  );
  await prefetchFileQuery(fileKeys.meta(ALICE_SEED_PROJECT_ID, APP), () =>
    getFileMetadata(ALICE_SEED_PROJECT_ID, APP),
  );
  await prefetchFileQuery(fileKeys.content(ALICE_SEED_PROJECT_ID, APP), () =>
    getFileContent(ALICE_SEED_PROJECT_ID, APP),
  );

  const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
  const appUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, APP);
  monaco.editor.createModel('<project />', 'xml', pomUri);
  monaco.editor.createModel('class App {}', 'java', appUri);
  workspaceResourceRegistry.register(disposeAllProjectModels);
  return { pomUri, appUri };
}

async function expireCurrentSessionToken(): Promise<void> {
  const token = authSession.getAccessToken();
  expect(token).toBeTruthy();
  const expire = await fetch('/api/v1/session/expire', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(expire.status).toBe(204);
}

function expectFileCacheCleared(): void {
  expect(queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT))).toBeUndefined();
  expect(queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, SRC_DIR))).toBeUndefined();
  expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, POM))).toBeUndefined();
  expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).toBeUndefined();
  expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, APP))).toBeUndefined();
  expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, APP))).toBeUndefined();
}

const originalClipboardItem = globalThis.ClipboardItem;

beforeEach(() => {
  resetAppRuntime();
  globalThis.ClipboardItem = class {
    constructor(items: Record<string, Blob | string | Promise<Blob | string>> = {}) {
      for (const value of Object.values(items)) {
        void Promise.resolve(value).catch(() => {});
      }
    }
    static supports() {
      return false;
    }
  } as unknown as typeof ClipboardItem;
});

afterEach(async () => {
  globalThis.ClipboardItem = originalClipboardItem;
  cleanup();
  disposeAllProjectModels();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

beforeAll(async () => {
  await import('../features/projects/ReadonlyWorkbenchPage');
}, 30_000);

describe('appRuntime unauthorized recovery', () => {
  it('handles two concurrent 401s once and shows a single expired-session alert', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    seedWorkspaceSession(ALICE_SEED_PROJECT_ID, 'pom.xml');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closerA = vi.fn();
    const closerB = vi.fn();
    const workspaceDispose = vi.fn();
    connectionRegistry.register(closerA);
    connectionRegistry.register(closerB);
    workspaceResourceRegistry.register(workspaceDispose);

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
    expect(workspaceDispose).toHaveBeenCalledTimes(1);
    expectEmptyWorkspaceSession();
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

      seedWorkspaceSession('prj-bob-lab', 'lab-notes.md');
      const closer = vi.fn();
      const workspaceDispose = vi.fn();
      connectionRegistry.register(closer);
      workspaceResourceRegistry.register(workspaceDispose);

      releaseAlice();
      const aliceError = await pendingAliceList.catch((reason: unknown) => reason);
      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });

      expect(closer).not.toHaveBeenCalled();
      expect(workspaceDispose).not.toHaveBeenCalled();
      expect(workspaceSessionStore.getState().projectId).toBe('prj-bob-lab');
      expect(workspaceSessionStore.getState().openPaths).toEqual([
        parseProjectRelativePath('lab-notes.md'),
      ]);
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

  it('does not clear Bob auth, workspace, file cache or model when Alice delayed file-content 401 arrives', async () => {
    await authenticateAsAlice();
    const aliceToken = authSession.getAccessToken();
    expect(aliceToken).toBeTruthy();
    seedWorkspaceSession(ALICE_SEED_PROJECT_ID, 'pom.xml');

    let releaseAlice: () => void = () => {};
    const aliceHold = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    let interceptedAliceContent = false;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const authorization = new Headers(init?.headers).get('Authorization');
      const path = (() => {
        try {
          return new URL(url, 'http://localhost').searchParams.get('path');
        } catch {
          return null;
        }
      })();
      if (
        !interceptedAliceContent &&
        url.includes('/files/content') &&
        path === 'pom.xml' &&
        authorization === `Bearer ${aliceToken}`
      ) {
        interceptedAliceContent = true;
        await aliceHold;
        return new Response(JSON.stringify(UNAUTHENTICATED_BODY), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const pendingAliceContent = getFileContent(ALICE_SEED_PROJECT_ID, POM);
      logout();

      const bob = await login({ username: 'bob', password: 'demo-pass' });
      authSession.authenticate(bob);

      const store = workspaceSessionStore.getState();
      store.activateProject(BOB_SEED_PROJECT_ID);
      store.openFile(LAB_NOTES);
      store.toggleDirectory(parseProjectRelativePath('samples'));

      await prefetchFileQuery(fileKeys.meta(BOB_SEED_PROJECT_ID, LAB_NOTES), () =>
        getFileMetadata(BOB_SEED_PROJECT_ID, LAB_NOTES),
      );
      await prefetchFileQuery(fileKeys.content(BOB_SEED_PROJECT_ID, LAB_NOTES), () =>
        getFileContent(BOB_SEED_PROJECT_ID, LAB_NOTES),
      );

      const bobUri = toProjectModelUri(BOB_SEED_PROJECT_ID, LAB_NOTES);
      monaco.editor.createModel('# Bob Lab\n', 'markdown', bobUri);
      workspaceResourceRegistry.register(disposeAllProjectModels);

      const closer = vi.fn();
      const workspaceDispose = vi.fn();
      connectionRegistry.register(closer);
      workspaceResourceRegistry.register(workspaceDispose);

      renderApp({ initialEntries: [`/projects/${BOB_SEED_PROJECT_ID}`] });
      expect(await screen.findByRole('heading', { name: 'Bob Lab' }, { timeout: 10_000 })).toBeInTheDocument();
      expect(screen.queryByText('Alice Notebook')).not.toBeInTheDocument();

      releaseAlice();
      const aliceError = await pendingAliceContent.catch((reason: unknown) => reason);
      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });

      expect(closer).not.toHaveBeenCalled();
      expect(workspaceDispose).not.toHaveBeenCalled();
      expect(monaco.editor.getModel(bobUri)).not.toBeNull();
      expect(queryClient.getQueryData(fileKeys.meta(BOB_SEED_PROJECT_ID, LAB_NOTES))).toBeDefined();
      expect(queryClient.getQueryData(fileKeys.content(BOB_SEED_PROJECT_ID, LAB_NOTES))).toBeDefined();
      expect(workspaceSessionStore.getState().projectId).toBe(BOB_SEED_PROJECT_ID);
      expect(workspaceSessionStore.getState().openPaths).toEqual([LAB_NOTES]);
      expect(workspaceSessionStore.getState().expandedPaths.has(parseProjectRelativePath('samples'))).toBe(
        true,
      );
      expect(authSession.getSnapshot()).toMatchObject({
        status: 'authenticated',
        user: { username: 'bob' },
      });
      expect(screen.getByRole('heading', { name: 'Bob Lab' })).toBeInTheDocument();
      expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});

describe('appRuntime current-session 401 with open workbench', () => {
  it('clears tabs, expanded paths, file cache, models and connections once then lands on login', async () => {
    await authenticateAsAlice();
    const { pomUri, appUri } = await seedAliceOpenFiles();

    const closer = vi.fn();
    connectionRegistry.register(closer);

    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tree', { name: 'Files' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pom\.xml/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /App\.java/ })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().expandedPaths.has(SRC)).toBe(true);
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();
    expect(monaco.editor.getModel(appUri)).not.toBeNull();

    await expireCurrentSessionToken();
    const error = await getFileContent(ALICE_SEED_PROJECT_ID, POM).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });

    expect(closer).toHaveBeenCalledTimes(1);
    expectEmptyWorkspaceSession();
    expectFileCacheCleared();
    expect(monaco.editor.getModel(pomUri)).toBeNull();
    expect(monaco.editor.getModel(appUri)).toBeNull();
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(authSession.getAccessToken()).toBeNull();

    const echo = screen.getByTestId('location-echo');
    expect(echo).toHaveAttribute('data-pathname', '/login');
    expect(echo).toHaveAttribute('data-history-action', 'REPLACE');
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/session has expired/i);
    expect(screen.queryByRole('tree', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByText('Alice Notebook')).not.toBeInTheDocument();
  }, 15_000);

  it('clears the same workbench state once when download 401 uses the current token', async () => {
    await authenticateAsAlice();
    const { pomUri, appUri } = await seedAliceOpenFiles();

    const closer = vi.fn();
    connectionRegistry.register(closer);

    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tree', { name: 'Files' }, { timeout: 10_000 })).toBeInTheDocument();

    await expireCurrentSessionToken();
    const error = await downloadFileBlob(ALICE_SEED_PROJECT_ID, POM, 'pom.xml').catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });

    expect(closer).toHaveBeenCalledTimes(1);
    expectEmptyWorkspaceSession();
    expectFileCacheCleared();
    expect(monaco.editor.getModel(pomUri)).toBeNull();
    expect(monaco.editor.getModel(appUri)).toBeNull();
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(screen.getByTestId('location-echo')).toHaveAttribute('data-pathname', '/login');
    expect(screen.getByRole('alert')).toHaveTextContent(/session has expired/i);
  }, 15_000);
});

describe('appRuntime login 401', () => {
  it('does not clear cache or connections when login credentials are invalid', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    seedWorkspaceSession(ALICE_SEED_PROJECT_ID, 'pom.xml');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closer = vi.fn();
    const workspaceDispose = vi.fn();
    connectionRegistry.register(closer);
    workspaceResourceRegistry.register(workspaceDispose);

    const error = await login({ username: 'alice', password: 'wrong-pass' }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });
    expect(closer).not.toHaveBeenCalled();
    expect(workspaceDispose).not.toHaveBeenCalled();
    expect(workspaceSessionStore.getState().projectId).toBe(ALICE_SEED_PROJECT_ID);
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
    seedWorkspaceSession(ALICE_SEED_PROJECT_ID, 'pom.xml');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    const closerA = vi.fn();
    const closerB = vi.fn();
    const workspaceDispose = vi.fn();
    connectionRegistry.register(closerA);
    connectionRegistry.register(closerB);
    workspaceResourceRegistry.register(workspaceDispose);

    renderApp({ initialEntries: ['/projects'] });
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /log out/i }));

    expect(closerA).toHaveBeenCalledTimes(1);
    expect(closerB).toHaveBeenCalledTimes(1);
    expect(workspaceDispose).toHaveBeenCalledTimes(1);
    expectEmptyWorkspaceSession();
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

  it('disposes connections, workspace resources, session, query cache and auth in order', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    seedWorkspaceSession(ALICE_SEED_PROJECT_ID, 'pom.xml');

    const order: string[] = [];
    connectionRegistry.register(() => {
      order.push('connection');
    });
    workspaceResourceRegistry.register(() => {
      order.push('workspace');
    });
    const unsubscribe = useWorkspaceSession.subscribe((state, previous) => {
      if (previous.projectId !== null && state.projectId === null) {
        order.push('session');
      }
    });
    const clearQuery = queryClient.clear.bind(queryClient);
    queryClient.clear = () => {
      order.push('query');
      clearQuery();
    };
    const clearAuth = authSession.clear.bind(authSession);
    authSession.clear = (reason) => {
      order.push('auth');
      clearAuth(reason);
    };

    try {
      logout();
      expect(order).toEqual(['connection', 'workspace', 'session', 'query', 'auth']);
      expectEmptyWorkspaceSession();
    } finally {
      queryClient.clear = clearQuery;
      authSession.clear = clearAuth;
      unsubscribe();
    }
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
