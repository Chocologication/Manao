import type { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getFileContent, getFileMetadata, listDirectory } from '../../api/fileApi';
import { workspaceBufferRegistry } from '../../app/appRuntime';
import type { FileMetadata, FileRenderMode, ProjectRelativePath } from '../../contracts/file';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { projectAuthorityScope } from '../files/fileMutations';
import {
  cacheDirectoryTree,
  cacheFileContent,
  cacheFileMetadata,
  cancelProjectFileReads,
  fileKeys,
} from '../files/fileQueries';
import { parseProjectDirectoryPath } from '../files/pathPolicy';
import * as projectMonacoModels from '../../lib/projectMonacoModels';

export class PendingProjectAuthorityMutationError extends Error {
  constructor() {
    super('Pending project authority mutation');
    this.name = 'PendingProjectAuthorityMutationError';
  }
}

function isDeletedEntryError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }
  if (error.body?.code === 'ENTRY_NOT_FOUND') {
    return true;
  }
  return error.status === 400 && error.body?.code === 'INVALID_PATH';
}

function isRenderable(mode: FileRenderMode): boolean {
  return mode === 'MONACO_TEXT' || mode === 'PLAIN_TEXT';
}

function assertCurrentProject(projectId: string): void {
  if (useWorkspaceSession.getState().projectId !== projectId) {
    throw new Error('Workspace project changed during reload');
  }
}

function restoreOpenFiles(
  originalOpenPaths: ProjectRelativePath[],
  surviving: ProjectRelativePath[],
  activePath: ProjectRelativePath | null,
): void {
  let restoredActive: ProjectRelativePath | null = null;
  if (activePath !== null && surviving.includes(activePath)) {
    restoredActive = activePath;
  } else if (activePath !== null) {
    const index = originalOpenPaths.indexOf(activePath);
    restoredActive =
      originalOpenPaths.slice(index + 1).find((path) => surviving.includes(path)) ??
      [...originalOpenPaths.slice(0, index)].reverse().find((path) => surviving.includes(path)) ??
      surviving[0] ??
      null;
  } else {
    restoredActive = surviving[0] ?? null;
  }
  useWorkspaceSession.setState({
    openPaths: surviving,
    activePath: restoredActive,
  });
}

export async function reloadWorkspaceAfterTerminalRun(options: {
  projectId: string;
  queryClient: QueryClient;
}): Promise<void> {
  const { projectId, queryClient } = options;
  const session = useWorkspaceSession.getState();
  const openPaths = [...session.openPaths];
  const activePath = session.activePath;
  const scopeId = projectAuthorityScope(projectId).id;
  if (
    queryClient.isMutating({
      predicate: (mutation) => mutation.options.scope?.id === scopeId,
    }) > 0
  ) {
    throw new PendingProjectAuthorityMutationError();
  }

  await cancelProjectFileReads(queryClient, projectId);
  workspaceBufferRegistry.disposeProject(projectId);
  projectMonacoModels.disposeProjectModels(projectId);
  queryClient.removeQueries({ queryKey: fileKeys.all(projectId) });
  assertCurrentProject(projectId);

  const tree = await listDirectory(projectId, parseProjectDirectoryPath(''));
  assertCurrentProject(projectId);
  cacheDirectoryTree(queryClient, projectId, tree);

  const surviving: ProjectRelativePath[] = [];
  for (const path of openPaths) {
    assertCurrentProject(projectId);
    let meta: FileMetadata;
    try {
      meta = await getFileMetadata(projectId, path);
    } catch (error) {
      if (isDeletedEntryError(error)) {
        continue;
      }
      throw error;
    }
    cacheFileMetadata(queryClient, projectId, meta);
    if (meta.renderMode === 'BLOCKED' || !isRenderable(meta.renderMode)) {
      surviving.push(path);
      continue;
    }
    const content = await getFileContent(projectId, path);
    assertCurrentProject(projectId);
    cacheFileContent(queryClient, projectId, content);
    surviving.push(path);
  }

  assertCurrentProject(projectId);
  restoreOpenFiles(openPaths, surviving, activePath);
}
