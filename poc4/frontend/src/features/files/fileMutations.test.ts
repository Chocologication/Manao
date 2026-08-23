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
const WRITE_SCOPE = `project-file-write:${ALICE_SEED_PROJECT_ID}`;

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
  it('uses project-file-write scope and retry false for save/create/rename/delete', async () => {
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
