import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getFileContent, getFileMetadata, listDirectory } from '../../api/fileApi';
import type {
  FileContentResponse,
  FileMetadata,
  FileRenderMode,
  FileTreeEntry,
  FileTreeResponse,
  ProjectDirectoryPath,
  ProjectRelativePath,
  WorkspaceRevision,
} from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';

const FILE_STALE_TIME_MS = 30_000;

export const fileKeys = {
  all: (projectId: string) => ['project-files', projectId] as const,
  trees: (projectId: string) => ['project-files', projectId, 'tree'] as const,
  tree: (projectId: string, path: ProjectDirectoryPath) =>
    ['project-files', projectId, 'tree', path] as const,
  meta: (projectId: string, path?: ProjectRelativePath) =>
    path === undefined
      ? (['project-files', projectId, 'meta'] as const)
      : (['project-files', projectId, 'meta', path] as const),
  content: (projectId: string, path?: ProjectRelativePath) =>
    path === undefined
      ? (['project-files', projectId, 'content'] as const)
      : (['project-files', projectId, 'content', path] as const),
  revision: (projectId: string) => ['project-files', projectId, 'revision'] as const,
};

export function sortFileTreeEntries(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
  return entries.slice().sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    const byInsensitiveName = left.name.localeCompare(right.name, 'en', { sensitivity: 'accent' });
    if (byInsensitiveName !== 0) {
      return byInsensitiveName;
    }
    if (left.name === right.name) {
      return 0;
    }
    return left.name < right.name ? -1 : 1;
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  throw new DOMException('The operation was aborted.', 'AbortError');
}

function canRefreshWorkspaceRevision(projectId: string, source: 'root-tree' | 'nested'): boolean {
  const current = useWorkspaceSession.getState().projectId;
  if (current !== null && current !== projectId) {
    return false;
  }
  return source === 'root-tree' || current === projectId;
}

export function applyWorkspaceRevisionFromRead(
  queryClient: QueryClient,
  projectId: string,
  revision: WorkspaceRevision,
  source: 'root-tree' | 'nested',
  signal?: AbortSignal,
): void {
  if (signal !== undefined) {
    throwIfAborted(signal);
  }
  if (!canRefreshWorkspaceRevision(projectId, source)) {
    return;
  }
  queryClient.setQueryData(fileKeys.revision(projectId), revision);
}

export function cacheDirectoryTree(
  queryClient: QueryClient,
  projectId: string,
  tree: FileTreeResponse,
): void {
  queryClient.setQueryData(fileKeys.tree(projectId, tree.directory), tree);
  applyWorkspaceRevisionFromRead(
    queryClient,
    projectId,
    tree.workspaceRevision,
    tree.directory === '' ? 'root-tree' : 'nested',
  );
}

export function cacheFileMetadata(
  queryClient: QueryClient,
  projectId: string,
  meta: FileMetadata,
): void {
  queryClient.setQueryData(fileKeys.meta(projectId, meta.path), meta);
}

export function cacheFileContent(
  queryClient: QueryClient,
  projectId: string,
  content: FileContentResponse,
): void {
  queryClient.setQueryData(fileKeys.content(projectId, content.path), content);
  applyWorkspaceRevisionFromRead(queryClient, projectId, content.workspaceRevision, 'nested');
}

export function getWorkspaceRevision(
  queryClient: QueryClient,
  projectId: string,
): WorkspaceRevision | undefined {
  return queryClient.getQueryData(fileKeys.revision(projectId));
}

export function useDirectoryTreeQuery(projectId: string, path: ProjectDirectoryPath) {
  const queryClient = useQueryClient();
  const enabled = useWorkspaceSession((state) => {
    if (projectId.length === 0) {
      return false;
    }
    if (path === '') {
      return true;
    }
    return state.expandedPaths.has(path);
  });

  return useQuery({
    queryKey: fileKeys.tree(projectId, path),
    queryFn: async ({ signal }) => {
      const tree = await listDirectory(projectId, path, signal);
      applyWorkspaceRevisionFromRead(
        queryClient,
        projectId,
        tree.workspaceRevision,
        path === '' ? 'root-tree' : 'nested',
        signal,
      );
      return tree;
    },
    retry: false,
    staleTime: FILE_STALE_TIME_MS,
    enabled,
  });
}

function isCurrentProject(projectId: string, sessionProjectId: string | null): boolean {
  return sessionProjectId === null || sessionProjectId === projectId;
}

export function useFileMetadataQuery(
  projectId: string,
  path: ProjectRelativePath,
  enabled: boolean,
) {
  const sessionProjectId = useWorkspaceSession((state) => state.projectId);
  return useQuery({
    queryKey: fileKeys.meta(projectId, path),
    queryFn: ({ signal }) => getFileMetadata(projectId, path, signal),
    retry: false,
    staleTime: FILE_STALE_TIME_MS,
    enabled: enabled && projectId.length > 0 && isCurrentProject(projectId, sessionProjectId),
  });
}

export function useFileContentQuery(
  projectId: string,
  path: ProjectRelativePath,
  renderMode: FileRenderMode | undefined,
) {
  const queryClient = useQueryClient();
  const sessionProjectId = useWorkspaceSession((state) => state.projectId);
  const authorized = renderMode === 'MONACO_TEXT' || renderMode === 'PLAIN_TEXT';
  return useQuery({
    queryKey: fileKeys.content(projectId, path),
    queryFn: async ({ signal }) => {
      const content = await getFileContent(projectId, path, signal);
      applyWorkspaceRevisionFromRead(
        queryClient,
        projectId,
        content.workspaceRevision,
        'nested',
        signal,
      );
      return content;
    },
    retry: false,
    staleTime: FILE_STALE_TIME_MS,
    enabled: authorized && projectId.length > 0 && isCurrentProject(projectId, sessionProjectId),
  });
}

export async function refreshProjectFiles(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  const queryKey = fileKeys.trees(projectId);
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export async function cancelProjectFileReads(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: fileKeys.trees(projectId) }),
    queryClient.cancelQueries({ queryKey: fileKeys.meta(projectId) }),
    queryClient.cancelQueries({ queryKey: fileKeys.content(projectId) }),
  ]);
}

export function fileQueryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && /network request failed/i.test(error.message)) {
    return 'Network request failed';
  }
  if (
    error instanceof ApiRequestError &&
    (error.status === 403 || error.body?.code === 'FORBIDDEN')
  ) {
    return 'Access denied';
  }
  return fallback;
}
