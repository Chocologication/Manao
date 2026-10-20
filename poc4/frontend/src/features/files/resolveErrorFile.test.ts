import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDirectory } from '@/api/fileApi';
import type { FileTreeResponse, ProjectDirectoryPath } from '@/contracts/file';
import { parseProjectRelativePath } from './pathPolicy';
import { parseWorkspaceRevision } from '@/contracts/file';
import { fileKeys } from './fileQueries';
import { resolveErrorFile } from './resolveErrorFile';

vi.mock('@/api/fileApi', () => ({ listDirectory: vi.fn() }));
const revision = parseWorkspaceRevision('rev-1');
function tree(directory: ProjectDirectoryPath, files: string[], directories: string[] = []): FileTreeResponse {
  return { directory, workspaceRevision: revision, entries: [
    ...files.map((path) => ({ path: parseProjectRelativePath(path), name: path.split('/').at(-1)!, kind: 'file' as const, hidden: false, sizeBytes: 1, hasChildren: null })),
    ...directories.map((path) => ({ path: parseProjectRelativePath(path), name: path.split('/').at(-1)!, kind: 'directory' as const, hidden: false, sizeBytes: null, hasChildren: true })),
  ] };
}
const location = { path: 'App.java', line: 12, source: 'java' as const };
afterEach(() => vi.resetAllMocks());
describe('unopened error files', () => {
  it('reads collapsed directories and caches them with the existing project keys', async () => {
    const client = new QueryClient();
    vi.mocked(listDirectory).mockImplementation(async (_id, directory) => directory === '' ? tree('', [], ['src']) : tree(directory, ['src/App.java']));
    expect(await resolveErrorFile(client, 'project-a', location, new AbortController().signal)).toEqual({ path: 'src/App.java', reason: 'found' });
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(fileKeys.tree('project-a', parseProjectRelativePath('src')))).toMatchObject({ directory: 'src' });
  });
  it('reports duplicate filenames and skips dependency directories', async () => {
    vi.mocked(listDirectory).mockImplementation(async (_id, directory) => directory === '' ? tree('', [], ['src', 'tests', 'node_modules']) : tree(directory, [`${directory}/App.java`]));
    expect(await resolveErrorFile(new QueryClient(), 'project-a', location, new AbortController().signal)).toEqual({ path: null, reason: 'ambiguous' });
    expect(listDirectory).toHaveBeenCalledTimes(3);
    expect(await resolveErrorFile(new QueryClient(), 'project-a', { ...location, path: '.venv/site-packages/main.py' }, new AbortController().signal)).toEqual({ path: null, reason: 'external' });
  });
  it('does not read or cache after cancellation', async () => {
    const client = new QueryClient();
    const controller = new AbortController();
    vi.mocked(listDirectory).mockImplementation(async () => { controller.abort(); return tree('', ['App.java']); });
    await expect(resolveErrorFile(client, 'project-a', location, controller.signal)).rejects.toThrow();
    expect(client.getQueryData(fileKeys.tree('project-a', ''))).toBeUndefined();
  });
  it('bounds file discovery and reuses fresh cached directories', async () => {
    const client = new QueryClient();
    client.setQueryData(fileKeys.tree('project-a', ''), tree('', ['App.java']));
    expect(await resolveErrorFile(client, 'project-a', location, new AbortController().signal)).toEqual({ path: 'App.java', reason: 'found' });
    expect(listDirectory).not.toHaveBeenCalled();
    vi.mocked(listDirectory).mockResolvedValue(tree('', Array.from({ length: 5001 }, (_, index) => `file-${index}.java`)));
    expect(await resolveErrorFile(new QueryClient(), 'project-b', location, new AbortController().signal)).toEqual({ path: null, reason: 'limit' });
  });
});
