import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import type { FileTreeEntry, ProjectRelativePath } from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { parseProjectDirectoryPath, parseProjectRelativePath } from './pathPolicy';
import {
  fileKeys,
  refreshProjectFiles,
  sortFileTreeEntries,
  useDirectoryTreeQuery,
  useFileContentQuery,
  useFileMetadataQuery,
} from './fileQueries';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID, getFileRequestCount, recordFileRequest } from '../../mocks/state';
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
    expect(fileKeys.tree('prj-1', ROOT)).toEqual(['project-files', 'prj-1', 'tree', '']);
    expect(fileKeys.tree('prj-1', SRC)).toEqual(['project-files', 'prj-1', 'tree', 'src']);
    expect(fileKeys.meta('prj-1', POM)).toEqual(['project-files', 'prj-1', 'meta', 'pom.xml']);
    expect(fileKeys.content('prj-1', POM)).toEqual([
      'project-files',
      'prj-1',
      'content',
      'pom.xml',
    ]);
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
  it('cancels then invalidates the project file key and does not clear open tabs', async () => {
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

    expect(cancel).toHaveBeenCalledWith({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(invalidate.mock.invocationCallOrder[0]);
    expect(remove).not.toHaveBeenCalled();
    expect(useWorkspaceSession.getState().openPaths).toEqual([POM]);
    expect(useWorkspaceSession.getState().activePath).toBe(POM);
  });
});
