import { useQuery, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getFileContent, getFileMetadata, listDirectory } from '../../api/fileApi';
import type {
  FileRenderMode,
  FileTreeEntry,
  ProjectDirectoryPath,
  ProjectRelativePath,
} from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';

const FILE_STALE_TIME_MS = 30_000;

export const fileKeys = {
  all: (projectId: string) => ['project-files', projectId] as const,
  tree: (projectId: string, path: ProjectDirectoryPath) =>
    ['project-files', projectId, 'tree', path] as const,
  meta: (projectId: string, path: ProjectRelativePath) =>
    ['project-files', projectId, 'meta', path] as const,
  content: (projectId: string, path: ProjectRelativePath) =>
    ['project-files', projectId, 'content', path] as const,
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

export function useDirectoryTreeQuery(projectId: string, path: ProjectDirectoryPath) {
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
    queryFn: () => listDirectory(projectId, path),
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
    queryFn: () => getFileMetadata(projectId, path),
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
  const sessionProjectId = useWorkspaceSession((state) => state.projectId);
  const authorized = renderMode === 'MONACO_TEXT' || renderMode === 'PLAIN_TEXT';
  return useQuery({
    queryKey: fileKeys.content(projectId, path),
    queryFn: () => getFileContent(projectId, path),
    retry: false,
    staleTime: FILE_STALE_TIME_MS,
    enabled: authorized && projectId.length > 0 && isCurrentProject(projectId, sessionProjectId),
  });
}

export async function refreshProjectFiles(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  const queryKey = fileKeys.all(projectId);
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
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
