import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../api/authApi';
import { ApiRequestError } from '../api/ApiRequestError';
import { downloadFileBlob, getFileContent, getFileMetadata, listDirectory } from '../api/fileApi';
import { getProject, listProjects } from '../api/projectApi';
import { createTerminalSession } from '../api/terminalApi';
import { parseRunId } from '../contracts/run';
import { parseTerminalAuditId, parseTerminalSessionId } from '../contracts/terminal';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID } from '../mocks/state';
import { server } from '../mocks/node';
import { renderApp, resetAppRuntime } from '../test/renderApp';
import { useWorkspaceSession, workspaceSessionStore } from '../features/editor/workspaceSession';
import { fileKeys } from '../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import { RunLogStore } from '../features/logs/RunLogStore';
import { RunLogTransport } from '../features/logs/RunLogTransport';
import { RunLogView } from '../components/runs/RunLogView';
import { TerminalAuditView } from '../components/terminal/TerminalAuditView';
import { projectKeys } from '../features/projects/projectQueries';
import { disposeAllProjectModels, toProjectModelUri } from '../lib/projectMonacoModels';
import {
  authSession,
  connectionRegistry,
  handleUnauthorized,
  logout,
  queryClient,
  registerTerminalRuntimeResource,
  workspaceBufferRegistry,
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
  expect(state.dirtyPaths.size).toBe(0);
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

class TestLogSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Set<(event: { data?: unknown; code?: number; reason?: string }) => void>
  >();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === TestLogSocket.CLOSED) {
      return;
    }
    this.readyState = TestLogSocket.CLOSED;
    this.emit('close', { code: 1000, reason: '' });
  }

  open(): void {
    this.readyState = TestLogSocket.OPEN;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  remoteClose(code: number, reason = ''): void {
    this.readyState = TestLogSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

async function connectTestLogTransport(runId: string, replayText = `${runId}-chunk`): Promise<{
  store: RunLogStore;
  socket: TestLogSocket;
  timers: Map<number, () => void>;
}> {
  const store = new RunLogStore({
    projectId: ALICE_SEED_PROJECT_ID,
    runId: parseRunId(runId),
    schedule: (notify) => {
      notify();
      return () => {};
    },
  });
  const sockets: TestLogSocket[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const transport = new RunLogTransport({
    projectId: ALICE_SEED_PROJECT_ID,
    runId: store.runId,
    store,
    queryClient,
    connectionRegistry,
    createTicket: async () => ({
      ticket: `ticket-${runId}` as never,
      expiresAt: '2026-08-24T10:00:30.000Z',
    }),
    getAccessToken: () => authSession.getAccessToken(),
    onUnauthorized: handleUnauthorized,
    webSocketFactory: (url) => {
      const socket = new TestLogSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    location: { protocol: 'http:', host: 'localhost:4173' },
    setTimeout: (handler) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(Number(id));
    },
    jitter: false,
  });
  transport.connect();
  await Promise.resolve();
  await Promise.resolve();
  const socket = sockets[0];
  expect(socket).toBeDefined();
  socket!.open();
  socket!.message(
    JSON.stringify({
      type: 'log.replay',
      chunks: [
        {
          seq: 1,
          text: replayText,
          byteLength: new TextEncoder().encode(replayText).byteLength,
          persistedAt: '2026-08-24T10:00:02.000Z',
        },
      ],
      window: {
        firstAvailableSeq: 1,
        lastAvailableSeq: 1,
        retainedBytes: new TextEncoder().encode(replayText).byteLength,
        truncated: false,
        evictedBytes: 0,
      },
    }),
  );
  expect(store.getSnapshot().lastAppliedSeq).toBe(1);
  expect(socket!.readyState).toBe(TestLogSocket.OPEN);
  return { store, socket: socket!, timers };
}

function trackCleanupOrder(socket: TestLogSocket): {
  order: string[];
  restore: () => void;
} {
  const order: string[] = [];
  const origClose = socket.close.bind(socket);
  socket.close = () => {
    order.push('socket');
    origClose();
  };
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
  return {
    order,
    restore() {
      queryClient.clear = clearQuery;
      authSession.clear = clearAuth;
    },
  };
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
  await import('../features/projects/WorkbenchPage');
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

  it('keeps Bob current when Alice terminal ticket POST returns a delayed 401', async () => {
    await authenticateAsAlice();
    const aliceToken = authSession.getAccessToken();
    expect(aliceToken).toBeTruthy();
    let releaseAlice: () => void = () => {};
    const aliceHold = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.endsWith('/terminal-sessions') && authorization === `Bearer ${aliceToken}`) {
        await aliceHold;
        return new Response(JSON.stringify(UNAUTHENTICATED_BODY), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const pendingTicket = createTerminalSession(
        ALICE_SEED_PROJECT_ID,
        parseRunId('run-alice-terminal'),
        { cols: 80, rows: 24 },
      );
      logout();
      const bob = await login({ username: 'bob', password: 'demo-pass' });
      authSession.authenticate(bob);
      const bobClose = vi.fn();
      const bobDispose = vi.fn();
      connectionRegistry.register(bobClose);
      workspaceResourceRegistry.register(bobDispose);

      releaseAlice();
      const aliceError = await pendingTicket.catch((reason: unknown) => reason);

      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });
      expect(bobClose).not.toHaveBeenCalled();
      expect(bobDispose).not.toHaveBeenCalled();
      expect(authSession.getSnapshot()).toMatchObject({
        status: 'authenticated',
        user: { username: 'bob' },
      });
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
      await waitFor(() => {
        expect(workspaceBufferRegistry.get(BOB_SEED_PROJECT_ID, LAB_NOTES)).toBeDefined();
      });
      expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();

      releaseAlice();
      const aliceError = await pendingAliceContent.catch((reason: unknown) => reason);
      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });

      expect(closer).not.toHaveBeenCalled();
      expect(workspaceDispose).not.toHaveBeenCalled();
      expect(monaco.editor.getModel(bobUri)).not.toBeNull();
      expect(queryClient.getQueryData(fileKeys.meta(BOB_SEED_PROJECT_ID, LAB_NOTES))).toBeDefined();
      expect(queryClient.getQueryData(fileKeys.content(BOB_SEED_PROJECT_ID, LAB_NOTES))).toBeDefined();
      expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
      expect(workspaceBufferRegistry.get(BOB_SEED_PROJECT_ID, LAB_NOTES)).toBeDefined();
      expect(workspaceBufferRegistry.get(BOB_SEED_PROJECT_ID, LAB_NOTES)?.snapshot().content).not.toMatch(
        /alice/i,
      );
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

  it('closes log-transport sockets and timers before query and auth clear', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    const { socket, timers } = await connectTestLogTransport('run-401-log');
    expect(timers.size).toBeGreaterThan(0);
    const tracked = trackCleanupOrder(socket);
    try {
      await expireCurrentSessionToken();
      const error = await getFileContent(ALICE_SEED_PROJECT_ID, POM).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: 401 });
      expect(tracked.order.indexOf('socket')).toBeGreaterThanOrEqual(0);
      expect(tracked.order.indexOf('socket')).toBeLessThan(tracked.order.indexOf('query'));
      expect(tracked.order.indexOf('query')).toBeLessThan(tracked.order.indexOf('auth'));
      expect(socket.readyState).toBe(TestLogSocket.CLOSED);
      expect(timers.size).toBe(0);
      expect(authSession.getAccessToken()).toBeNull();
    } finally {
      tracked.restore();
    }
  });
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

  it('closes registered log-transport sockets and timers before query and auth clear', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    const { socket, timers } = await connectTestLogTransport('run-alice-log');
    expect(timers.size).toBeGreaterThan(0);
    const tracked = trackCleanupOrder(socket);
    try {
      logout();
      expect(tracked.order.indexOf('socket')).toBeGreaterThanOrEqual(0);
      expect(tracked.order.indexOf('socket')).toBeLessThan(tracked.order.indexOf('query'));
      expect(tracked.order.indexOf('query')).toBeLessThan(tracked.order.indexOf('auth'));
      expect(socket.readyState).toBe(TestLogSocket.CLOSED);
      expect(timers.size).toBe(0);
      expect(authSession.getAccessToken()).toBeNull();
    } finally {
      tracked.restore();
    }
  });
});

describe('appRuntime log stream session isolation', () => {
  it('renders the Run marker only in the Run logs region', async () => {
    const runMarker = 'RUN#9';
    const { store } = await connectTestLogTransport('run-channel-9', runMarker);

    render(createElement(RunLogView, { store }));

    const runLogs = screen.getByRole('region', { name: 'Run logs' });
    expect(runLogs).toHaveTextContent(runMarker);
    expect(runLogs).not.toHaveTextContent(
      /PTY#9|AUDIT#9|session-1|short ticket\?&|jwt-secret-that-must-not-leak/,
    );
  });

  it('renders only audit command data and keeps opaque credentials out of visible DOM', () => {
    const sessionSecret = 'session-1';
    const ticketSecret = 'short ticket?&';
    const jwtSecret = 'jwt-secret-that-must-not-leak';
    render(createElement(TerminalAuditView, {
      items: [{
        id: parseTerminalAuditId('audit-9'),
        sessionId: parseTerminalSessionId(sessionSecret),
        command: 'AUDIT#9',
        state: 'SUCCEEDED',
        startedAt: '2026-08-25T10:00:00.000Z',
        finishedAt: '2026-08-25T10:00:01.000Z',
        exitCode: 0,
      }],
      isPending: false,
      isError: false,
      errorMessage: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
    }));

    const audit = screen.getByRole('table', { name: 'Terminal command audit' });
    expect(audit).toHaveTextContent('AUDIT#9');
    const visibleText = document.body.textContent ?? '';
    for (const hidden of [sessionSecret, ticketSecret, jwtSecret, 'PTY#9', 'RUN#9']) {
      expect(visibleText).not.toContain(hidden);
    }
  });

  it('does not close Bob log stream when a delayed Alice 401 arrives', async () => {
    await authenticateAsAlice();
    const aliceToken = authSession.getAccessToken();
    expect(aliceToken).toBeTruthy();
    const alice = await connectTestLogTransport('run-alice-log');

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
      expect(alice.socket.readyState).toBe(TestLogSocket.CLOSED);

      const bob = await login({ username: 'bob', password: 'demo-pass' });
      authSession.authenticate(bob);
      const bobStream = await connectTestLogTransport('run-bob-log');
      expect(bobStream.socket.readyState).toBe(TestLogSocket.OPEN);
      expect(bobStream.store.getSnapshot().lastAppliedSeq).toBe(1);
      const bobTimerCount = bobStream.timers.size;

      releaseAlice();
      const aliceError = await pendingAliceList.catch((reason: unknown) => reason);
      expect(aliceError).toBeInstanceOf(ApiRequestError);
      expect(aliceError).toMatchObject({ status: 401 });

      alice.socket.remoteClose(4401, 'Bearer stale-alice');
      expect(bobStream.socket.readyState).toBe(TestLogSocket.OPEN);
      expect(bobStream.store.getSnapshot().lastAppliedSeq).toBe(1);
      expect(bobStream.store.getSnapshot().chunks[0]?.text).toBe('run-bob-log-chunk');
      expect(bobStream.timers.size).toBe(bobTimerCount);
      expect(authSession.getSnapshot()).toMatchObject({
        status: 'authenticated',
        user: { username: 'bob' },
      });
      expect(authSession.getAccessToken()).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resetAppRuntime connection cleanup', () => {
  it('closes log sockets and timers before query and auth clear', async () => {
    await authenticateAsAlice();
    await seedCachedProjectQueries();
    const { socket, timers } = await connectTestLogTransport('run-reset-log');
    const tracked = trackCleanupOrder(socket);
    try {
      resetAppRuntime();
      expect(tracked.order.indexOf('socket')).toBeGreaterThanOrEqual(0);
      expect(tracked.order.indexOf('socket')).toBeLessThan(tracked.order.indexOf('query'));
      expect(tracked.order.indexOf('query')).toBeLessThan(tracked.order.indexOf('auth'));
      expect(socket.readyState).toBe(TestLogSocket.CLOSED);
      expect(timers.size).toBe(0);
    } finally {
      tracked.restore();
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

describe('appRuntime workspace buffer disposal', () => {
  it('does not statically import monaco-editor or project Monaco models', () => {
    const source = readFileSync('src/app/appRuntime.ts', 'utf8');
    expect(source).not.toMatch(/from ['"]monaco-editor['"]/);
    expect(source).not.toMatch(/from ['"]monaco-editor\//);
    expect(source).not.toMatch(/projectMonacoModels/);
  });

  it('injects dirty changes into the session and disposes buffers on logout', () => {
    const store = workspaceSessionStore.getState();
    store.activateProject(ALICE_SEED_PROJECT_ID);
    const buffer = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: 'before',
    });
    (buffer as typeof buffer & { replace(content: string): void }).replace('after');

    expect(workspaceSessionStore.getState().dirtyPaths.has(POM)).toBe(true);

    logout();

    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expectEmptyWorkspaceSession();
  });

  it('disposes buffers on a current-session 401 and keeps them available after the next register', async () => {
    await authenticateAsAlice();
    workspaceSessionStore.getState().activateProject(ALICE_SEED_PROJECT_ID);
    workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: 'open',
    });

    await expireCurrentSessionToken();
    const error = await getFileContent(ALICE_SEED_PROJECT_ID, POM).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });

    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expectEmptyWorkspaceSession();

    const next = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: 'reopened',
    });
    expect(next.snapshot().content).toBe('reopened');
    workspaceBufferRegistry.remove(ALICE_SEED_PROJECT_ID, POM);
  });

  it('does not leak Alice dirty into Bob and disposeProject drops leftover Alice buffers', () => {
    const aliceStore = workspaceSessionStore.getState();
    aliceStore.activateProject(ALICE_SEED_PROJECT_ID);
    const alice = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: 'alice',
    });
    (alice as typeof alice & { replace(content: string): void }).replace('alice-dirty');
    expect(workspaceSessionStore.getState().dirtyPaths.has(POM)).toBe(true);

    workspaceSessionStore.getState().activateProject(BOB_SEED_PROJECT_ID);
    expect(workspaceSessionStore.getState().projectId).toBe(BOB_SEED_PROJECT_ID);
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBe(alice);

    (alice as typeof alice & { replace(content: string): void }).replace('still-alice');
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
    expect(workspaceSessionStore.getState().dirtyPaths.has(POM)).toBe(false);

    workspaceBufferRegistry.disposeProject(ALICE_SEED_PROJECT_ID);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);

    workspaceSessionStore.getState().activateProject(ALICE_SEED_PROJECT_ID);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
  });
});

describe('appRuntime terminal resource registration', () => {
  it('keeps terminal and Run components isolated from the other channel transport', () => {
    const terminalSources = [
      readFileSync('src/components/terminal/JobTerminalPanel.tsx', 'utf8'),
      readFileSync('src/components/terminal/TerminalAuditView.tsx', 'utf8'),
    ].join('\n');
    const runSources = [
      readFileSync('src/components/runs/RunPanel.tsx', 'utf8'),
      readFileSync('src/components/runs/RunLogView.tsx', 'utf8'),
    ].join('\n');

    expect(terminalSources).not.toMatch(/features[\\/]logs|RunLog(?:Store|Transport)/);
    expect(runSources).not.toMatch(
      /features[\\/]terminal|JobTerminal(?:Controller|Transport)|terminalQueries/,
    );
  });

  it('treats screenshot naming as N/A because terminal runtime exposes no screenshot surface', () => {
    const runtimeSources = [
      readFileSync('src/app/appRuntime.ts', 'utf8'),
      readFileSync('src/features/terminal/JobTerminalController.ts', 'utf8'),
      readFileSync('src/features/terminal/JobTerminalTransport.ts', 'utf8'),
      readFileSync('src/components/terminal/JobTerminalPanel.tsx', 'utf8'),
    ].join('\n');

    expect(runtimeSources).not.toMatch(/\bscreenshot\b|capturePage|toHaveScreenshot/);
  });

  it('closes the socket before disposing controller/xterm and keeps heavy modules lazy', () => {
    const order: string[] = [];
    registerTerminalRuntimeResource({
      closeConnection: () => {
        order.push('socket');
      },
      disposeWorkspace: () => {
        order.push('controller-xterm');
      },
    });

    logout();

    expect(order).toEqual(['socket', 'controller-xterm']);
    const source = readFileSync('src/app/appRuntime.ts', 'utf8');
    expect(source).not.toMatch(/features[\\/]terminal/);
    expect(source).not.toMatch(/@xterm/);
  });

  it('unregisters both ownership paths and isolates throwing cleanup observers', () => {
    const removedClose = vi.fn();
    const removedDispose = vi.fn();
    const unregister = registerTerminalRuntimeResource({
      closeConnection: removedClose,
      disposeWorkspace: removedDispose,
    });
    unregister();
    unregister();

    const remainingClose = vi.fn();
    const remainingDispose = vi.fn();
    registerTerminalRuntimeResource({
      closeConnection: () => {
        throw new Error('close observer failed');
      },
      disposeWorkspace: () => {
        throw new Error('dispose observer failed');
      },
    });
    registerTerminalRuntimeResource({
      closeConnection: remainingClose,
      disposeWorkspace: remainingDispose,
    });

    expect(() => logout()).not.toThrow();
    expect(removedClose).not.toHaveBeenCalled();
    expect(removedDispose).not.toHaveBeenCalled();
    expect(remainingClose).toHaveBeenCalledOnce();
    expect(remainingDispose).toHaveBeenCalledOnce();
  });
});
