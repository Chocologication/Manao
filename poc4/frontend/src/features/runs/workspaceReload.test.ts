import { cleanup, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { authSession, queryClient, workspaceBufferRegistry } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { projectAuthorityScope } from '../files/fileMutations';
import { fileKeys } from '../files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../files/pathPolicy';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import * as projectMonacoModels from '../../lib/projectMonacoModels';
import { server } from '../../mocks/node';
import {
  getMockFile,
  getWorkspaceRevision as getMockWorkspaceRevision,
} from '../../mocks/fileFixtures';
import {
  advanceMockRunClock,
  installVirtualRunClock,
  MOCK_RUN_START_DELAY_MS,
  MOCK_RUN_TERMINAL_DELAY_MS,
  setRunScenario,
  startRun as mockStartRun,
} from '../../mocks/runState';
import { ALICE_SEED_PROJECT_ID, getFileRequestCount } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { reloadWorkspaceAfterTerminalRun } from './workspaceReload';

const ALICE = { username: 'alice', password: 'demo-pass' };
const README = parseProjectRelativePath('README.md');
const POM = parseProjectRelativePath('pom.xml');
const SRC = parseProjectRelativePath('src');
const GONE_DIR = parseProjectRelativePath('gone-dir');
const APP_TEST = parseProjectRelativePath('src/test/java/demo/AppTest.java');
const LOGO = parseProjectRelativePath('assets/logo.png');
const ROOT = parseProjectDirectoryPath('');
const RELOAD_MARKER = 'ensoai-stage4-reload-change';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const pending = { pending: true as const };
  const winner = await Promise.race([
    promise.then(
      () => null,
      () => null,
    ),
    Promise.resolve(pending),
  ]);
  return winner === pending;
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function activateAndOpen(paths: Array<typeof README>, active: typeof README): void {
  const session = useWorkspaceSession.getState();
  session.activateProject(ALICE_SEED_PROJECT_ID);
  for (const path of paths) {
    session.openFile(path);
  }
  session.openFile(active);
}

function registerPlainBuffer(path: typeof README, content: string): void {
  workspaceBufferRegistry.register({
    projectId: ALICE_SEED_PROJECT_ID,
    path,
    kind: 'plain-text',
    content,
  });
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  disposeAllProjectModels();
  await queryClient.cancelQueries();
  resetAppRuntime();
  vi.restoreAllMocks();
});

describe('reloadWorkspaceAfterTerminalRun ordering', () => {
  it('captures paths, cancels, disposes, removes queries, then fetches root and metadata-first content', async () => {
    const events: string[] = [];
    const rootGate = deferred();
    const readmeMetaGate = deferred();
    const readmeContentGate = deferred();
    const pomMetaGate = deferred();
    const pomContentGate = deferred();

    await authenticateAsAlice();
    activateAndOpen([README, POM], POM);
    registerPlainBuffer(README, '# stale-readme');
    registerPlainBuffer(POM, '<stale />');
    monaco.editor.createModel('# stale-readme', 'markdown', toProjectModelUri(ALICE_SEED_PROJECT_ID, README));
    queryClient.setQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID), parseWorkspaceRevision('stale-rev'));
    queryClient.setQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README), {
      path: README,
      content: '# stale-readme',
      workspaceRevision: parseWorkspaceRevision('stale-rev'),
    });

    const originalCancel = queryClient.cancelQueries.bind(queryClient);
    vi.spyOn(queryClient, 'cancelQueries').mockImplementation(async (filters) => {
      if (!events.includes('cancel')) {
        events.push('cancel');
      }
      return originalCancel(filters);
    });
    const originalDispose = workspaceBufferRegistry.disposeProject.bind(workspaceBufferRegistry);
    vi.spyOn(workspaceBufferRegistry, 'disposeProject').mockImplementation((projectId) => {
      events.push('dispose-buffers');
      originalDispose(projectId);
    });
    const originalDisposeModels = projectMonacoModels.disposeProjectModels;
    vi.spyOn(projectMonacoModels, 'disposeProjectModels').mockImplementation((projectId) => {
      events.push('dispose-models');
      originalDisposeModels(projectId);
    });
    const originalRemove = queryClient.removeQueries.bind(queryClient);
    vi.spyOn(queryClient, 'removeQueries').mockImplementation((filters) => {
      events.push('remove');
      return originalRemove(filters);
    });

    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === '') {
          events.push('root');
          await rootGate.promise;
        }
        return undefined;
      }),
      http.get('/api/v1/projects/:projectId/files/meta', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        events.push(`meta:${path}`);
        if (path === 'README.md') {
          await readmeMetaGate.promise;
        }
        if (path === 'pom.xml') {
          await pomMetaGate.promise;
        }
        return undefined;
      }),
      http.get('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        events.push(`content:${path}`);
        if (path === 'README.md') {
          await readmeContentGate.promise;
        }
        if (path === 'pom.xml') {
          await pomContentGate.promise;
        }
        return undefined;
      }),
    );

    const pending = reloadWorkspaceAfterTerminalRun({
      projectId: ALICE_SEED_PROJECT_ID,
      queryClient,
    });

    await waitFor(() => {
      expect(events).toEqual(['cancel', 'dispose-buffers', 'dispose-models', 'remove', 'root']);
    });
    expect(await stillPending(pending)).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, README))).toBeNull();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toBeUndefined();
    expect(useWorkspaceSession.getState().openPaths).toEqual([README, POM]);
    expect(events).not.toContain('meta:README.md');

    rootGate.resolve();
    await waitFor(() => {
      expect(events).toContain('meta:README.md');
    });
    expect(events).not.toContain('content:README.md');
    expect(events).not.toContain('meta:pom.xml');
    expect(await stillPending(pending)).toBe(true);
    expect(useWorkspaceSession.getState().activePath).toBe(POM);

    readmeMetaGate.resolve();
    await waitFor(() => {
      expect(events).toContain('content:README.md');
    });
    expect(events).not.toContain('meta:pom.xml');
    expect(await stillPending(pending)).toBe(true);

    readmeContentGate.resolve();
    await waitFor(() => {
      expect(events).toContain('meta:pom.xml');
    });
    expect(events).not.toContain('content:pom.xml');
    expect(await stillPending(pending)).toBe(true);

    pomMetaGate.resolve();
    await waitFor(() => {
      expect(events).toContain('content:pom.xml');
    });
    expect(await stillPending(pending)).toBe(true);

    pomContentGate.resolve();
    await pending;

    expect(events).toEqual([
      'cancel',
      'dispose-buffers',
      'dispose-models',
      'remove',
      'root',
      'meta:README.md',
      'content:README.md',
      'meta:pom.xml',
      'content:pom.xml',
    ]);
    expect(useWorkspaceSession.getState().openPaths).toEqual([README, POM]);
    expect(useWorkspaceSession.getState().activePath).toBe(POM);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
      getMockWorkspaceRevision(ALICE_SEED_PROJECT_ID),
    );
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toEqual(
      expect.objectContaining({ path: README, content: expect.stringContaining('Alice Notebook') }),
    );
  });
});

describe('reloadWorkspaceAfterTerminalRun path outcomes', () => {
  it('omits a deleted open path and continues with survivors', async () => {
    await authenticateAsAlice();
    activateAndOpen([README, APP_TEST, POM], APP_TEST);
    useWorkspaceSession.getState().selectPath(APP_TEST);
    useWorkspaceSession.getState().toggleDirectory(SRC);
    useWorkspaceSession.getState().toggleDirectory(GONE_DIR);
    server.use(
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === 'src/test/java/demo/AppTest.java') {
          return HttpResponse.json(
            { code: 'ENTRY_NOT_FOUND', message: 'Entry not found', traceId: 'trace-missing-tab' },
            { status: 409 },
          );
        }
        return undefined;
      }),
    );

    await reloadWorkspaceAfterTerminalRun({
      projectId: ALICE_SEED_PROJECT_ID,
      queryClient,
    });

    expect(useWorkspaceSession.getState().openPaths).toEqual([README, POM]);
    expect(useWorkspaceSession.getState().activePath).toBe(POM);
    expect(useWorkspaceSession.getState().selectedPath).toBeNull();
    expect(useWorkspaceSession.getState().expandedPaths.has(SRC)).toBe(true);
    expect(useWorkspaceSession.getState().expandedPaths.has(GONE_DIR)).toBe(false);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'src/test/java/demo/AppTest.java')).toBe(
      0,
    );
  });

  it('keeps a BLOCKED tab without fetching content or restoring a Monaco model', async () => {
    await authenticateAsAlice();
    activateAndOpen([README, LOGO], LOGO);
    monaco.editor.createModel('stale-logo', 'plaintext', toProjectModelUri(ALICE_SEED_PROJECT_ID, LOGO));

    await reloadWorkspaceAfterTerminalRun({
      projectId: ALICE_SEED_PROJECT_ID,
      queryClient,
    });

    expect(useWorkspaceSession.getState().openPaths).toEqual([README, LOGO]);
    expect(useWorkspaceSession.getState().activePath).toBe(LOGO);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(0);
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, LOGO))).toEqual(
      expect.objectContaining({ path: LOGO, renderMode: 'BLOCKED' }),
    );
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, LOGO))).toBeUndefined();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, LOGO))).toBeNull();
  });

  it('throws when a project-authority mutation is already submitted and does not dispose', async () => {
    await authenticateAsAlice();
    activateAndOpen([README], README);
    registerPlainBuffer(README, '# keep');
    const hold = deferred();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => hold.promise,
      scope: projectAuthorityScope(ALICE_SEED_PROJECT_ID),
    });
    const running = mutation.execute({});
    await waitFor(() => {
      expect(
        queryClient.isMutating({
          predicate: (item) => item.options.scope?.id === projectAuthorityScope(ALICE_SEED_PROJECT_ID).id,
        }),
      ).toBeGreaterThan(0);
    });

    await expect(
      reloadWorkspaceAfterTerminalRun({
        projectId: ALICE_SEED_PROJECT_ID,
        queryClient,
      }),
    ).rejects.toThrow(/pending project authority mutation/i);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeDefined();
    expect(useWorkspaceSession.getState().openPaths).toEqual([README]);

    hold.resolve();
    await running.catch(() => {});
  });

  it('fails closed on unexpected metadata errors without dropping surviving tabs early', async () => {
    await authenticateAsAlice();
    activateAndOpen([README, POM], README);
    server.use(
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === 'pom.xml') {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock meta failure', traceId: 'trace-meta' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );

    await expect(
      reloadWorkspaceAfterTerminalRun({
        projectId: ALICE_SEED_PROJECT_ID,
        queryClient,
      }),
    ).rejects.toThrow();
    expect(useWorkspaceSession.getState().openPaths).toEqual([README, POM]);
    expect(useWorkspaceSession.getState().activePath).toBe(README);
  });
});

describe('reloadWorkspaceAfterTerminalRun mock reload-change', () => {
  it('reopens surviving tabs against Job side effects and the advanced revision', async () => {
    installVirtualRunClock(Date.parse('2026-08-24T10:00:00.000Z'));
    await authenticateAsAlice();
    activateAndOpen([README, APP_TEST], README);
    registerPlainBuffer(README, '# Alice Notebook\n\nRead-only Maven demo.\n');
    const beforeRevision = getMockWorkspaceRevision(ALICE_SEED_PROJECT_ID);
    queryClient.setQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID), parseWorkspaceRevision(beforeRevision));

    setRunScenario('reload-change');
    const started = mockStartRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: beforeRevision,
    });
    expect(started.ok).toBe(true);
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    advanceMockRunClock(MOCK_RUN_TERMINAL_DELAY_MS);

    expect(getMockFile(ALICE_SEED_PROJECT_ID, 'README.md')?.textContent).toContain(RELOAD_MARKER);
    expect(getMockFile(ALICE_SEED_PROJECT_ID, 'docs/run-output.md')).not.toBeNull();
    expect(getMockFile(ALICE_SEED_PROJECT_ID, 'src/test/java/demo/AppTest.java')).toBeNull();
    expect(getMockWorkspaceRevision(ALICE_SEED_PROJECT_ID)).not.toBe(beforeRevision);

    await reloadWorkspaceAfterTerminalRun({
      projectId: ALICE_SEED_PROJECT_ID,
      queryClient,
    });

    expect(useWorkspaceSession.getState().openPaths).toEqual([README]);
    expect(useWorkspaceSession.getState().activePath).toBe(README);
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toEqual(
      expect.objectContaining({ content: expect.stringContaining(RELOAD_MARKER) }),
    );
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
      getMockWorkspaceRevision(ALICE_SEED_PROJECT_ID),
    );
    const docs = queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT));
    expect(docs).toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([expect.objectContaining({ name: 'docs' })]),
      }),
    );
  });
});

describe('reloadWorkspaceAfterTerminalRun isolation', () => {
  it('does not import a coordinator or call completeReload', () => {
    const source = readFileSync('src/features/runs/workspaceReload.ts', 'utf8');
    expect(source).not.toMatch(/completeReload/);
    expect(source).not.toMatch(/RunAuthorityCoordinator/);
  });
});
