import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceBufferRegistry } from '../../app/appRuntime';
import type { FileTreeResponse } from '../../contracts/file';
import { parseWorkspaceRevision } from '../../contracts/file';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID, setWriteScenario } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { useWorkspaceSession } from '../editor/workspaceSession';
import {
  fileMutationErrorMessage,
  projectAuthorityScope,
  useCreateEntryMutation,
  useDeleteEntryMutation,
  useRenameEntryMutation,
  useSaveFileMutation,
} from './fileMutations';
import { fileKeys, useDirectoryTreeQuery, useFileContentQuery } from './fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from './pathPolicy';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ROOT = parseProjectDirectoryPath('');
const POM = parseProjectRelativePath('pom.xml');
const README = parseProjectRelativePath('README.md');
const NOTES = parseProjectRelativePath('notes.md');
const README_NEXT = parseProjectRelativePath('GUIDE.md');
const WRITE_SCOPE = `project-authority:${ALICE_SEED_PROJECT_ID}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function seedRootRevision(): Promise<void> {
  useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
  const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
    wrapper: AppProviders,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
}

function rootTree(): FileTreeResponse | undefined {
  return queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT));
}

function lastMutation() {
  const mutations = queryClient.getMutationCache().getAll();
  const mutation = mutations[mutations.length - 1];
  expect(mutation).toBeDefined();
  return mutation!;
}

function registerPlain(path: typeof POM, content: string) {
  return workspaceBufferRegistry.register({
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
});

describe('missing workspace revision', () => {
  it('does not send a write when revision is absent', async () => {
    await authenticateAsAlice();
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
    let puts = 0;
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        puts += 1;
        return HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'no', traceId: 't' }, { status: 500 });
      }),
    );
    const { result } = renderHook(() => useSaveFileMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    await expect(
      result.current.mutateAsync({
        path: POM,
        snapshot: { content: 'x', version: 1 },
      }),
    ).rejects.toThrow('Workspace revision is unavailable');

    expect(puts).toBe(0);
  });
});

describe('serialized project file mutations', () => {
  it('uses project-authority scope and retry false for save/create/rename/delete', async () => {
    await authenticateAsAlice();
    await seedRootRevision();

    const hooks = renderHook(
      () => ({
        save: useSaveFileMutation(ALICE_SEED_PROJECT_ID),
        create: useCreateEntryMutation(ALICE_SEED_PROJECT_ID),
        rename: useRenameEntryMutation(ALICE_SEED_PROJECT_ID),
        remove: useDeleteEntryMutation(ALICE_SEED_PROJECT_ID),
      }),
      { wrapper: AppProviders },
    );

    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project edited />');

    await hooks.result.current.save.mutateAsync({
      path: POM,
      snapshot: buffer.snapshot(),
    });
    expect(lastMutation().options.scope).toEqual({ id: WRITE_SCOPE });
    expect(lastMutation().options.retry).toBe(false);

    await hooks.result.current.create.mutateAsync({
      kind: 'file',
      path: NOTES,
    });
    expect(lastMutation().options.scope).toEqual({ id: WRITE_SCOPE });
    expect(lastMutation().options.retry).toBe(false);

    await hooks.result.current.rename.mutateAsync({
      path: README,
      nextPath: README_NEXT,
    });
    expect(lastMutation().options.scope).toEqual({ id: WRITE_SCOPE });
    expect(lastMutation().options.retry).toBe(false);

    await hooks.result.current.remove.mutateAsync({ path: NOTES });
    expect(lastMutation().options.scope).toEqual({ id: WRITE_SCOPE });
    expect(lastMutation().options.retry).toBe(false);
  });

  it('serializes same-project writes and keeps other project scopes independent', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    expect(projectAuthorityScope(ALICE_SEED_PROJECT_ID)).toEqual({ id: WRITE_SCOPE });
    expect(projectAuthorityScope('other-project').id).not.toBe(WRITE_SCOPE);

    let releasePut = () => {};
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let puts = 0;
    let creates = 0;
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        puts += 1;
        await putGate;
        return undefined;
      }),
      http.post('/api/v1/projects/:projectId/entries', () => {
        creates += 1;
        return undefined;
      }),
    );

    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project edited />');
    const { result } = renderHook(
      () => ({
        save: useSaveFileMutation(ALICE_SEED_PROJECT_ID),
        create: useCreateEntryMutation(ALICE_SEED_PROJECT_ID),
      }),
      { wrapper: AppProviders },
    );

    result.current.save.mutate({ path: POM, snapshot: buffer.snapshot() });
    await waitFor(() => expect(puts).toBe(1));
    result.current.create.mutate({ kind: 'file', path: NOTES });
    await sleep(40);
    expect(creates).toBe(0);

    releasePut();
    await waitFor(() => expect(creates).toBe(1));
  });

  it('cancels in-flight reads before write and does not optimistically mutate tree or dirty', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const treeBefore = rootTree();
    expect(treeBefore).toBeDefined();

    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project dirty />');
    const snapshot = buffer.snapshot();

    let releaseGet!: () => void;
    let releasePut!: () => void;
    let writeStarted!: () => void;
    const getHeld = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const putHeld = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const putStarted = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    let putCount = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        requestSignal = request.signal;
        await getHeld;
        return HttpResponse.json({
          path: 'pom.xml',
          content: 'stale',
          workspaceRevision: 'mock-rev-0001',
        });
      }),
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        putCount += 1;
        writeStarted();
        await putHeld;
        return HttpResponse.json({
          file: {
            path: 'pom.xml',
            name: 'pom.xml',
            sizeBytes: snapshot.content.length,
            mediaType: 'application/xml',
            encoding: 'UTF-8',
            language: 'xml',
            renderMode: 'MONACO_TEXT',
            blockReason: null,
          },
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );

    renderHook(() => useFileContentQuery(ALICE_SEED_PROJECT_ID, POM, 'MONACO_TEXT'), {
      wrapper: AppProviders,
    });
    await waitFor(() => expect(requestSignal).toBeDefined());

    const { result } = renderHook(() => useSaveFileMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const pending = result.current.mutateAsync({ path: POM, snapshot });
    await putStarted;

    expect(requestSignal?.aborted).toBe(true);
    expect(putCount).toBe(1);
    expect(rootTree()).toEqual(treeBefore);
    expect(buffer.isDirty()).toBe(true);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');

    releasePut();
    await pending;
    releaseGet();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).not.toEqual(
      expect.objectContaining({ content: 'stale' }),
    );
  });
});

describe('authoritative success apply', () => {
  it('writes save metadata and content then revision last, then close-after-save', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project saved />');
    const snapshot = buffer.snapshot();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        order.push('write');
        await held;
        return HttpResponse.json({
          file: {
            path: 'pom.xml',
            name: 'pom.xml',
            sizeBytes: snapshot.content.length,
            mediaType: 'application/xml',
            encoding: 'UTF-8',
            language: 'xml',
            renderMode: 'MONACO_TEXT',
            blockReason: null,
          },
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );

    const { result } = renderHook(
      () =>
        useSaveFileMutation(ALICE_SEED_PROJECT_ID, {
          onCloseAfterSave: () => {
            expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, POM))).toMatchObject({
              path: 'pom.xml',
            });
            expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).toEqual({
              path: POM,
              content: snapshot.content,
              workspaceRevision: parseWorkspaceRevision('mock-rev-0002'),
            });
            expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
              'mock-rev-0002',
            );
            order.push('close-after-save');
          },
        }),
      { wrapper: AppProviders },
    );
    const pending = result.current.mutateAsync({
      path: POM,
      snapshot,
      closeAfterSave: true,
    });
    await waitFor(() => expect(order).toContain('write'));
    expect(order).toEqual(['write']);
    expect(buffer.isDirty()).toBe(true);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, POM))).toBeUndefined();
    release();
    await pending;

    expect(order).toEqual(['write', 'close-after-save']);
    expect(buffer.isDirty()).toBe(false);
  });

  it('keeps dirty when the user edits after the captured save snapshot', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project saved />');
    const snapshot = buffer.snapshot();
    plain.replace('<project later />');

    const { result } = renderHook(() => useSaveFileMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await result.current.mutateAsync({ path: POM, snapshot });

    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot().content).toBe('<project later />');
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).toMatchObject({
      content: snapshot.content,
    });
  });

  it('creates a file by seeding empty content then writing revision last', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const treeBefore = rootTree();
    setWriteScenario('delayed');

    const { result } = renderHook(() => useCreateEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const pending = result.current.mutateAsync({ kind: 'file', path: NOTES });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, NOTES))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
    expect(rootTree()).toEqual(treeBefore);
    await pending;

    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, NOTES))).toEqual({
      path: NOTES,
      content: '',
      workspaceRevision: parseWorkspaceRevision('mock-rev-0002'),
    });
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    expect(treeBefore?.entries.some((entry) => entry.path === NOTES)).toBe(false);
    await waitFor(() =>
      expect(rootTree()?.entries.some((entry) => entry.path === NOTES)).toBe(true),
    );
  });

  it('renames by disposing old buffers then remapping session, without moving Monaco URIs', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    const model = monaco.editor.createModel(
      '# Readme\n',
      'markdown',
      toProjectModelUri(ALICE_SEED_PROJECT_ID, README),
    );
    workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: README,
      kind: 'monaco',
      model,
    });
    const order: string[] = [];
    const { result } = renderHook(
      () =>
        useRenameEntryMutation(ALICE_SEED_PROJECT_ID, {
          onRenameCleanup: (path, nextPath) => {
            expect(path).toBe(README);
            expect(nextPath).toBe(README_NEXT);
            expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
              'mock-rev-0002',
            );
            expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
            expect(useWorkspaceSession.getState().openPaths).toEqual([README_NEXT]);
            order.push('rename-cleanup');
          },
        }),
      { wrapper: AppProviders },
    );
    await result.current.mutateAsync({ path: README, nextPath: README_NEXT });

    expect(order).toEqual(['rename-cleanup']);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README_NEXT)).toBeUndefined();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, README))).toBeNull();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, README_NEXT))).toBeNull();
    expect(useWorkspaceSession.getState().openPaths).toEqual([README_NEXT]);
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, README))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });

  it('deletes by disposing buffers then removing session paths', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    registerPlain(README, '# Readme\n');
    const order: string[] = [];
    const { result } = renderHook(
      () =>
        useDeleteEntryMutation(ALICE_SEED_PROJECT_ID, {
          onDeleteCleanup: (path) => {
            expect(path).toBe(README);
            expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
              'mock-rev-0002',
            );
            expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
            expect(useWorkspaceSession.getState().openPaths).toEqual([]);
            order.push('delete-cleanup');
          },
        }),
      { wrapper: AppProviders },
    );
    await result.current.mutateAsync({ path: README });

    expect(order).toEqual(['delete-cleanup']);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
    expect(useWorkspaceSession.getState().openPaths).toEqual([]);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });

  function holdTreeRefetchAsFailure(): { release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async () => {
        await held;
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'tree refetch failed', traceId: 'trace-tree' },
          { status: 500 },
        );
      }),
    );
    return { release };
  }

  it('resolves create before a failing parent tree refetch and keeps the written revision', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const { release } = holdTreeRefetchAsFailure();
    const { result } = renderHook(() => useCreateEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    const pending = result.current.mutateAsync({ kind: 'file', path: NOTES });
    await expect(
      Promise.race([pending.then(() => 'resolved' as const), sleep(80).then(() => 'waiting' as const)]),
    ).resolves.toBe('resolved');
    await pending;
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isError).toBe(false);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, NOTES))).toMatchObject({
      content: '',
    });
    release();
    await sleep(40);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });

  it('resolves rename before a failing parent tree refetch and keeps session remap', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    const { release } = holdTreeRefetchAsFailure();
    const { result } = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    const pending = result.current.mutateAsync({ path: README, nextPath: README_NEXT });
    await expect(
      Promise.race([pending.then(() => 'resolved' as const), sleep(80).then(() => 'waiting' as const)]),
    ).resolves.toBe('resolved');
    await pending;
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(useWorkspaceSession.getState().openPaths).toEqual([README_NEXT]);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    release();
    await sleep(40);
    expect(result.current.isError).toBe(false);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });

  it('resolves delete before a failing parent tree refetch and keeps session removal', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    const { release } = holdTreeRefetchAsFailure();
    const { result } = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    const pending = result.current.mutateAsync({ path: README });
    await expect(
      Promise.race([pending.then(() => 'resolved' as const), sleep(80).then(() => 'waiting' as const)]),
    ).resolves.toBe('resolved');
    await pending;
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(useWorkspaceSession.getState().openPaths).toEqual([]);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    release();
    await sleep(40);
    expect(result.current.isError).toBe(false);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });
});

describe('mutation errors', () => {
  it.each([
    [new Error('Network request failed'), 'Network request failed'],
    [new ApiRequestError(403, { code: 'FORBIDDEN', message: 'no', traceId: 't' }), 'Access denied'],
    [
      new ApiRequestError(409, { code: 'PROJECT_LOCKED', message: 'locked', traceId: 't' }),
      'Project is locked',
    ],
    [
      new ApiRequestError(409, {
        code: 'WORKSPACE_REVISION_CONFLICT',
        message: 'conflict',
        traceId: 't',
      }),
      'Workspace revision conflict',
    ],
    [
      new ApiRequestError(409, {
        code: 'ENTRY_ALREADY_EXISTS',
        message: 'exists',
        traceId: 't',
      }),
      'An entry with this name already exists',
    ],
    [
      new ApiRequestError(409, {
        code: 'DIRECTORY_NOT_EMPTY',
        message: 'not empty',
        traceId: 't',
      }),
      'Directory is not empty',
    ],
    [
      new ApiRequestError(413, { code: 'FILE_TOO_LARGE', message: 'big', traceId: 't' }),
      'File is too large',
    ],
    [
      new ApiRequestError(415, { code: 'BINARY_FILE', message: 'bin', traceId: 't' }),
      'This file type is not supported',
    ],
    [
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'boom', traceId: 't' }),
      'Unable to update files',
    ],
  ] as const)('maps %s to a stable UI message', (error, message) => {
    expect(fileMutationErrorMessage(error)).toBe(message);
  });

  it('does not retry or treat a failed body as authority', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const buffer = registerPlain(POM, '<project />');
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace('<project dirty />');
    const snapshot = buffer.snapshot();
    const treeBefore = rootTree();
    let puts = 0;
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        puts += 1;
        return HttpResponse.json(
          {
            file: {
              path: 'pom.xml',
              name: 'pom.xml',
              sizeBytes: 1,
              mediaType: 'application/xml',
              encoding: 'UTF-8',
              language: 'xml',
              renderMode: 'MONACO_TEXT',
              blockReason: null,
            },
            workspaceRevision: 'should-not-apply',
            code: 'WORKSPACE_REVISION_CONFLICT',
            message: 'Workspace revision conflict',
            traceId: 'trace-conflict',
          },
          { status: 409 },
        );
      }),
    );

    const { result } = renderHook(() => useSaveFileMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await expect(result.current.mutateAsync({ path: POM, snapshot })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(puts).toBe(1);
    expect(lastMutation().options.retry).toBe(false);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).toBeUndefined();
    expect(rootTree()).toEqual(treeBefore);
    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot()).toEqual(snapshot);
    expect(fileMutationErrorMessage(result.current.error)).toBe('Workspace revision conflict');
  });

  it('lets a current-token 401 run appRuntime cleanup', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(POM);
    const expire = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authSession.getAccessToken()}` },
    });
    expect(expire.status).toBe(204);

    const { result } = renderHook(() => useSaveFileMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await expect(
      result.current.mutateAsync({
        path: POM,
        snapshot: { content: 'x', version: 1 },
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);

    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(useWorkspaceSession.getState().projectId).toBeNull();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBeUndefined();
  });
});

describe('rename/delete state matrix', () => {
  const SRC = parseProjectRelativePath('src');
  const SOURCE = parseProjectRelativePath('source');
  const APP = parseProjectRelativePath('src/main/java/demo/App.java');
  const APP_NEXT = parseProjectRelativePath('source/main/java/demo/App.java');
  const SRC_NOTES = parseProjectRelativePath('src-notes.md');
  const SRC_A = parseProjectRelativePath('src/a');
  const SRC_AB = parseProjectRelativePath('src/ab');
  const SRC_A_FOO = parseProjectRelativePath('src/a/foo.ts');

  it('renames a clean closed file using the server next path and reloads it', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const { result } = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await result.current.mutateAsync({ path: README, nextPath: README_NEXT });

    expect(useWorkspaceSession.getState().openPaths).toEqual([]);
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, README))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, README_NEXT))).toMatchObject({
      path: README_NEXT,
    });
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');

    const content = renderHook(
      () => useFileContentQuery(ALICE_SEED_PROJECT_ID, README_NEXT, 'MONACO_TEXT'),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(content.result.current.isSuccess).toBe(true));
    expect(content.result.current.data?.path).toBe(README_NEXT);
  });

  it('remaps a clean open file without moving a live Monaco URI', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    const model = monaco.editor.createModel(
      '# Readme\n',
      'markdown',
      toProjectModelUri(ALICE_SEED_PROJECT_ID, README),
    );
    workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: README,
      kind: 'monaco',
      model,
    });

    const { result } = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await result.current.mutateAsync({ path: README, nextPath: README_NEXT });

    expect(useWorkspaceSession.getState().openPaths).toEqual([README_NEXT]);
    expect(useWorkspaceSession.getState().activePath).toBe(README_NEXT);
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, README))).toBeNull();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, README_NEXT))).toBeNull();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README_NEXT)).toBeUndefined();
  });

  it('remaps directory descendants and leaves a prefix sibling untouched', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const create = renderHook(() => useCreateEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await create.result.current.mutateAsync({ kind: 'file', path: SRC_NOTES });

    const session = useWorkspaceSession.getState();
    session.openFile(APP);
    session.openFile(SRC_NOTES);
    session.toggleDirectory(SRC);
    session.selectPath(APP);
    session.setDirty(SRC_NOTES, true);

    const { result } = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await result.current.mutateAsync({ path: SRC, nextPath: SOURCE });

    expect(useWorkspaceSession.getState().openPaths).toEqual([APP_NEXT, SRC_NOTES]);
    expect(useWorkspaceSession.getState().selectedPath).toBe(APP_NEXT);
    expect(useWorkspaceSession.getState().expandedPaths.has(SOURCE)).toBe(true);
    expect(useWorkspaceSession.getState().expandedPaths.has(SRC)).toBe(false);
    expect([...useWorkspaceSession.getState().dirtyPaths]).toEqual([SRC_NOTES]);
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, APP))).toBeUndefined();
  });

  it('does not treat src/ab as a descendant of src/a on rename or delete', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const create = renderHook(() => useCreateEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await create.result.current.mutateAsync({ kind: 'directory', path: SRC_A });
    await create.result.current.mutateAsync({ kind: 'directory', path: SRC_AB });

    const session = useWorkspaceSession.getState();
    session.openFile(SRC_A_FOO);
    session.openFile(SRC_AB);
    session.toggleDirectory(SRC_A);
    session.toggleDirectory(SRC_AB);
    session.selectPath(SRC_A_FOO);
    session.setDirty(SRC_A_FOO, true);
    session.setDirty(SRC_AB, true);
    registerPlain(SRC_A_FOO, 'export {};');
    registerPlain(SRC_AB, 'ab');

    const rename = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await rename.result.current.mutateAsync({
      path: SRC_A,
      nextPath: parseProjectRelativePath('src/b'),
    });

    expect(useWorkspaceSession.getState().openPaths).toEqual([
      parseProjectRelativePath('src/b/foo.ts'),
      SRC_AB,
    ]);
    expect(useWorkspaceSession.getState().expandedPaths.has(SRC_AB)).toBe(true);
    expect([...useWorkspaceSession.getState().dirtyPaths].sort()).toEqual(
      [parseProjectRelativePath('src/b/foo.ts'), SRC_AB].sort(),
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, SRC_A_FOO)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, SRC_AB)?.snapshot().content).toBe('ab');

    const remove = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await remove.result.current.mutateAsync({ path: parseProjectRelativePath('src/b') });

    expect(useWorkspaceSession.getState().openPaths).toEqual([SRC_AB]);
    expect(useWorkspaceSession.getState().dirtyPaths.has(SRC_AB)).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, SRC_AB)?.snapshot().content).toBe('ab');
  });

  it('leaves buffers, session and revision unchanged when delete is rejected as not empty', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(APP);
    useWorkspaceSession.getState().toggleDirectory(SRC);
    registerPlain(APP, 'class App {}');
    const treeBefore = rootTree();

    const { result } = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const rejected = await result.current.mutateAsync({ path: SRC }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(ApiRequestError);
    expect(fileMutationErrorMessage(rejected)).toBe('Directory is not empty');
    expect(useWorkspaceSession.getState().openPaths).toEqual([APP]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, APP)).toBeDefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
    expect(rootTree()).toEqual(treeBefore);
  });

  it('leaves session and revision unchanged on locked rename and conflict delete', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    registerPlain(README, '# Readme\n');

    setWriteScenario('locked');
    const rename = renderHook(() => useRenameEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const locked = await rename.result.current.mutateAsync({ path: README, nextPath: README_NEXT }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(locked).toBeInstanceOf(ApiRequestError);
    expect(fileMutationErrorMessage(locked)).toBe('Project is locked');
    expect(useWorkspaceSession.getState().openPaths).toEqual([README]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeDefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');

    setWriteScenario('conflict');
    const remove = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const conflicted = await remove.result.current.mutateAsync({ path: README }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflicted).toBeInstanceOf(ApiRequestError);
    expect(fileMutationErrorMessage(conflicted)).toBe('Workspace revision conflict');
    expect(useWorkspaceSession.getState().openPaths).toEqual([README]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeDefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
  });

  it('does not remove UI, buffers or queries while a delete request is still in flight', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(README);
    registerPlain(README, '# Readme\n');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.delete('/api/v1/projects/:projectId/entries', async () => {
        await held;
        return undefined;
      }),
    );

    const { result } = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const pending = result.current.mutateAsync({ path: README });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(useWorkspaceSession.getState().openPaths).toEqual([README]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeDefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');

    release();
    await pending;
    expect(useWorkspaceSession.getState().openPaths).toEqual([]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)).toBeUndefined();
  });

  it('cleans captured descendants when a mock recursive delete succeeds (mock-contract only)', async () => {
    // Frontend contract only: a 200 DELETE for a non-empty directory must drop
    // descendant session paths, buffers and queries. This is not proof of real
    // backend recursive-delete safety; the default mock still returns 409.
    await authenticateAsAlice();
    await seedRootRevision();
    useWorkspaceSession.getState().openFile(APP);
    useWorkspaceSession.getState().openFile(POM);
    useWorkspaceSession.getState().toggleDirectory(SRC);
    registerPlain(APP, 'class App {}');
    registerPlain(POM, '<project />');
    server.use(
      http.delete('/api/v1/projects/:projectId/entries', () => {
        return HttpResponse.json({
          path: 'src',
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );

    const { result } = renderHook(() => useDeleteEntryMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await result.current.mutateAsync({ path: SRC });

    expect(useWorkspaceSession.getState().openPaths).toEqual([POM]);
    expect(useWorkspaceSession.getState().expandedPaths.has(SRC)).toBe(false);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, APP)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeDefined();
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, APP))).toBeUndefined();
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
  });
});
