import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceBufferRegistry } from '../../app/appRuntime';
import { parseWorkspaceRevision, type FileTreeEntry, type ProjectRelativePath } from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { parseProjectDirectoryPath, parseProjectRelativePath } from './pathPolicy';
import {
  applyWorkspaceRevisionFromRead,
  cacheDirectoryTree,
  cacheFileContent,
  cacheFileMetadata,
  fileKeys,
  refreshProjectFiles,
  sortFileTreeEntries,
  useDirectoryTreeQuery,
  useFileContentQuery,
  useFileMetadataQuery,
} from './fileQueries';
import { server } from '../../mocks/node';
import {
  ALICE_SEED_PROJECT_ID,
  BOB_SEED_PROJECT_ID,
  getFileRequestCount,
  recordFileRequest,
} from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ROOT = parseProjectDirectoryPath('');
const SRC = parseProjectDirectoryPath('src');
const POM = parseProjectRelativePath('pom.xml');
const LOGO = parseProjectRelativePath('assets/logo.png');
const LARGE_NOTES = parseProjectRelativePath('docs/large-notes.md');

function treeEntry(
  path: string,
  kind: FileTreeEntry['kind'],
  name = path.slice(path.lastIndexOf('/') + 1),
): FileTreeEntry {
  return {
    path: parseProjectRelativePath(path),
    name,
    kind,
    hidden: name.startsWith('.'),
    sizeBytes: kind === 'file' ? 1 : null,
    hasChildren: kind === 'directory' ? true : null,
  };
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('fileKeys', () => {
  it('uses the hierarchical project-files key tuples', () => {
    expect(fileKeys.all('prj-1')).toEqual(['project-files', 'prj-1']);
    expect(fileKeys.trees('prj-1')).toEqual(['project-files', 'prj-1', 'tree']);
    expect(fileKeys.tree('prj-1', ROOT)).toEqual(['project-files', 'prj-1', 'tree', '']);
    expect(fileKeys.tree('prj-1', SRC)).toEqual(['project-files', 'prj-1', 'tree', 'src']);
    expect(fileKeys.meta('prj-1')).toEqual(['project-files', 'prj-1', 'meta']);
    expect(fileKeys.meta('prj-1', POM)).toEqual(['project-files', 'prj-1', 'meta', 'pom.xml']);
    expect(fileKeys.content('prj-1')).toEqual(['project-files', 'prj-1', 'content']);
    expect(fileKeys.content('prj-1', POM)).toEqual([
      'project-files',
      'prj-1',
      'content',
      'pom.xml',
    ]);
    expect(fileKeys.revision('prj-1')).toEqual(['project-files', 'prj-1', 'revision']);
  });
});

describe('sortFileTreeEntries', () => {
  it('copies the array, directories first, then case-insensitive name with original name as tie-breaker', () => {
    const entries = [
      treeEntry('z.txt', 'file'),
      treeEntry('B', 'directory'),
      treeEntry('a.md', 'file'),
      treeEntry('A.md', 'file'),
      treeEntry('assets', 'directory'),
    ];
    Object.freeze(entries);
    const original = [...entries];

    const sorted = sortFileTreeEntries(entries);

    expect(sorted).not.toBe(entries);
    expect(entries).toEqual(original);
    expect(sorted.map((entry) => entry.name)).toEqual(['assets', 'B', 'A.md', 'a.md', 'z.txt']);
  });
});

describe('directory tree queries', () => {
  it('fetches root with retry false, 30s staleTime, and default five-minute GC', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(1);

    const cached = queryClient.getQueryCache().find({
      queryKey: fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT),
    });
    expect(cached?.options.retry).toBe(false);
    expect(cached?.observers[0]?.options.staleTime).toBe(30_000);
    expect(cached?.gcTime).toBe(5 * 60 * 1000);
  });

  it('does not retry a failed tree request', async () => {
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        recordFileRequest('tree', ALICE_SEED_PROJECT_ID, path);
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Mock tree failure', traceId: 'trace-tree' },
          { status: 500 },
        );
      }),
    );
    await authenticateAsAlice();
    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(1);
  });

  it('does not fetch a collapsed directory until it is expanded', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, SRC), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.fetchStatus).toBe('idle');
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(0);

    useWorkspaceSession.getState().toggleDirectory(parseProjectRelativePath('src'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(1);
  });
});

describe('metadata-gated content queries', () => {
  function useGatedContent(path: ProjectRelativePath) {
    const meta = useFileMetadataQuery(ALICE_SEED_PROJECT_ID, path, true);
    const content = useFileContentQuery(ALICE_SEED_PROJECT_ID, path, meta.data?.renderMode);
    return { meta, content };
  }

  it('requests content only after metadata authorizes MONACO_TEXT or PLAIN_TEXT', async () => {
    await authenticateAsAlice();
    const { rerender } = renderHook(({ path }) => useGatedContent(path), {
      wrapper: AppProviders,
      initialProps: { path: POM },
    });

    await waitFor(() => expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1));
    await waitFor(() =>
      expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1),
    );

    rerender({ path: LARGE_NOTES });
    await waitFor(() =>
      expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'docs/large-notes.md')).toBe(1),
    );
    await waitFor(() =>
      expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'docs/large-notes.md')).toBe(1),
    );

    rerender({ path: LOGO });
    await waitFor(() =>
      expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(0);
  });
});

describe('refreshProjectFiles', () => {
  it('cancels then invalidates only tree keys and does not clear open tabs', async () => {
    await authenticateAsAlice();
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
    useWorkspaceSession.getState().openFile(POM);

    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const remove = vi.spyOn(queryClient, 'removeQueries');

    await refreshProjectFiles(queryClient, ALICE_SEED_PROJECT_ID);

    expect(cancel).toHaveBeenCalledWith({ queryKey: fileKeys.trees(ALICE_SEED_PROJECT_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fileKeys.trees(ALICE_SEED_PROJECT_ID) });
    expect(cancel).not.toHaveBeenCalledWith({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(invalidate.mock.invocationCallOrder[0]);
    expect(remove).not.toHaveBeenCalled();
    expect(useWorkspaceSession.getState().openPaths).toEqual([POM]);
    expect(useWorkspaceSession.getState().activePath).toBe(POM);
  });

  it('does not refetch content or replace a dirty buffer', async () => {
    await authenticateAsAlice();
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);

    const { result } = renderHook(
      () => ({
        tree: useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT),
        content: useFileContentQuery(ALICE_SEED_PROJECT_ID, POM, 'MONACO_TEXT'),
      }),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(result.current.tree.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.content.isSuccess).toBe(true));
    const loaded = result.current.content.data?.content;
    expect(typeof loaded).toBe('string');

    const buffer = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: loaded ?? '',
    });
    const plain = buffer as typeof buffer & { replace(content: string): void };
    plain.replace(`${loaded ?? ''}// dirty`);
    const dirtySnapshot = buffer.snapshot();
    expect(buffer.isDirty()).toBe(true);
    const contentRequests = getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml');

    await refreshProjectFiles(queryClient, ALICE_SEED_PROJECT_ID);
    await waitFor(() => expect(result.current.tree.isFetching).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(contentRequests);
    expect(result.current.content.data?.content).toBe(loaded);
    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot()).toEqual(dirtySnapshot);
  });
});

describe('workspace revision cache', () => {
  it('seeds fileKeys.revision from the root tree', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
  });

  it('lets nested tree and content refresh revision only for the current project', async () => {
    await authenticateAsAlice();
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
    useWorkspaceSession.getState().toggleDirectory(parseProjectRelativePath('src'));

    const { result } = renderHook(
      () => ({
        root: useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT),
        nested: useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, SRC),
        content: useFileContentQuery(ALICE_SEED_PROJECT_ID, POM, 'MONACO_TEXT'),
      }),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(result.current.root.isSuccess).toBe(true));
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');

    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        recordFileRequest('tree', ALICE_SEED_PROJECT_ID, path);
        if (path === 'src') {
          return HttpResponse.json({
            directory: 'src',
            entries: [
              {
                path: 'src/main',
                name: 'main',
                kind: 'directory',
                hidden: false,
                sizeBytes: null,
                hasChildren: true,
              },
            ],
            workspaceRevision: 'nested-tree-rev',
          });
        }
        return HttpResponse.json({
          directory: path,
          entries: [],
          workspaceRevision: 'root-should-not-clobber',
        });
      }),
    );
    await result.current.nested.refetch();
    await waitFor(() =>
      expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
        'nested-tree-rev',
      ),
    );

    server.use(
      http.get('/api/v1/projects/:projectId/files/content', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        recordFileRequest('content', ALICE_SEED_PROJECT_ID, path);
        return HttpResponse.json({
          path,
          content: '<project />',
          workspaceRevision: 'nested-content-rev',
        });
      }),
    );
    await result.current.content.refetch();
    await waitFor(() =>
      expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
        'nested-content-rev',
      ),
    );

    useWorkspaceSession.getState().activateProject(BOB_SEED_PROJECT_ID);
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', () =>
        HttpResponse.json({
          directory: 'src',
          entries: [
            {
              path: 'src/main',
              name: 'main',
              kind: 'directory',
              hidden: false,
              sizeBytes: null,
              hasChildren: true,
            },
          ],
          workspaceRevision: 'alice-after-switch',
        }),
      ),
    );
    await result.current.nested.refetch();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
      'nested-content-rev',
    );
  });

  it('clears the old revision on project switch or removal', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe(
        'mock-rev-0001',
      ),
    );
    expect(result.current.isSuccess).toBe(true);

    const queryKey = fileKeys.all(ALICE_SEED_PROJECT_ID);
    await queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
    useWorkspaceSession.getState().activateProject(BOB_SEED_PROJECT_ID);

    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBeUndefined();
  });

  it('aborts an in-flight GET on cancelQueries so a late body cannot regress revision after a write', async () => {
    await authenticateAsAlice();
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
    const { result: root } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
      wrapper: AppProviders,
    });
    await waitFor(() => expect(root.current.isSuccess).toBe(true));
    queryClient.setQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID), 'written-rev');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    server.use(
      http.get('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        requestSignal = request.signal;
        recordFileRequest('content', ALICE_SEED_PROJECT_ID, 'pom.xml');
        await held;
        return HttpResponse.json({
          path: 'pom.xml',
          content: 'stale-after-write',
          workspaceRevision: 'mock-rev-0001',
        });
      }),
    );

    const { result } = renderHook(
      () => useFileContentQuery(ALICE_SEED_PROJECT_ID, POM, 'MONACO_TEXT'),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(requestSignal).toBeDefined());
    expect(result.current.isFetching).toBe(true);

    await queryClient.cancelQueries({ queryKey: fileKeys.content(ALICE_SEED_PROJECT_ID, POM) });
    expect(requestSignal?.aborted).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('written-rev');
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).not.toEqual(
      expect.objectContaining({ content: 'stale-after-write' }),
    );
  });
});

describe('imperative file cache helpers', () => {
  it('writes tree, metadata, content and revision for the current project', () => {
    useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
    const revision = parseWorkspaceRevision('reload-rev');
    cacheDirectoryTree(queryClient, ALICE_SEED_PROJECT_ID, {
      directory: ROOT,
      entries: [treeEntry('README.md', 'file')],
      workspaceRevision: revision,
    });
    cacheFileMetadata(queryClient, ALICE_SEED_PROJECT_ID, {
      path: POM,
      name: 'pom.xml',
      sizeBytes: 4,
      mediaType: 'application/xml',
      encoding: 'UTF-8',
      language: 'xml',
      renderMode: 'MONACO_TEXT',
      blockReason: null,
    });
    cacheFileContent(queryClient, ALICE_SEED_PROJECT_ID, {
      path: POM,
      content: '<project />',
      workspaceRevision: parseWorkspaceRevision('content-rev'),
    });
    expect(queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT))).toEqual(
      expect.objectContaining({ workspaceRevision: revision }),
    );
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, POM))).toEqual(
      expect.objectContaining({ path: POM, renderMode: 'MONACO_TEXT' }),
    );
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, POM))).toEqual(
      expect.objectContaining({ content: '<project />' }),
    );
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('content-rev');

    applyWorkspaceRevisionFromRead(
      queryClient,
      ALICE_SEED_PROJECT_ID,
      parseWorkspaceRevision('direct-rev'),
      'root-tree',
    );
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('direct-rev');
  });
});
