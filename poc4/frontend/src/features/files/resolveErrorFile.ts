import type { QueryClient } from '@tanstack/react-query';
import { listDirectory } from '@/api/fileApi';
import { readWithProjectBusyRetry } from '@/api/projectBusyRetry';
import type { FileTreeResponse, ProjectDirectoryPath } from '@/contracts/file';
import { resolveRunErrorPath, type RunErrorLocation } from '@/components/runs/runErrorLocator';
import { cacheDirectoryTree, fileKeys } from './fileQueries';

const excludedDirectories = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'target', 'build', 'dist']);
export type ErrorFileResolution = { path: string | null; reason: 'found' | 'not-found' | 'ambiguous' | 'limit' | 'external' };

export async function resolveErrorFile(queryClient: QueryClient, projectId: string, location: RunErrorLocation, signal: AbortSignal): Promise<ErrorFileResolution> {
  if (/(?:^|[/\\])(?:site-packages|node_modules|\.venv|venv)(?:[/\\]|$)/.test(location.path)) return { path: null, reason: 'external' };
  const queue: ProjectDirectoryPath[] = [''];
  const visited = new Set<string>();
  const files = new Set<string>();
  while (queue.length > 0) {
    signal.throwIfAborted();
    if (visited.size >= 64 || files.size >= 5000) return { path: null, reason: 'limit' };
    const directory = queue.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const state = queryClient.getQueryState<FileTreeResponse>(fileKeys.tree(projectId, directory));
    const cached = state?.data && !state.isInvalidated && Date.now() - state.dataUpdatedAt < 30_000 ? state.data : null;
    const tree = cached
      ? cached
      : await readWithProjectBusyRetry(() => listDirectory(projectId, directory, signal));
    signal.throwIfAborted();
    if (!cached) cacheDirectoryTree(queryClient, projectId, tree);
    for (const entry of tree.entries) {
      if (entry.kind === 'file') {
        if (files.size >= 5000) return { path: null, reason: 'limit' };
        files.add(entry.path);
      }
      else if (entry.hasChildren && !excludedDirectories.has(entry.name)) queue.push(entry.path);
    }
  }
  const paths = [...files];
  const path = resolveRunErrorPath(location, paths);
  if (path) return { path, reason: 'found' };
  const basename = location.path.replaceAll('\\', '/').split('/').at(-1);
  return { path: null, reason: paths.filter((item) => item.split('/').at(-1) === basename).length > 1 ? 'ambiguous' : 'not-found' };
}
