import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../../api/ApiRequestError';
import { createEntry, deleteEntry, renameEntry, saveFileContent } from '../../api/fileApi';
import { workspaceBufferRegistry } from '../../app/appRuntime';
import type {
  CreateEntryResponse,
  DeleteEntryResponse,
  EntryKind,
  FileContentResponse,
  FileMetadata,
  ProjectDirectoryPath,
  ProjectRelativePath,
  RenameEntryResponse,
  SaveFileResponse,
  WorkspaceRevision,
} from '../../contracts/file';
import type { BufferSnapshot } from '../editor/editorTypes';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { disposeDescendantProjectModels } from '../../lib/projectMonacoModels';
import { parseProjectDirectoryPath } from './pathPolicy';
import {
  cancelProjectFileReads,
  fileKeys,
  getWorkspaceRevision,
} from './fileQueries';

export class MissingWorkspaceRevisionError extends Error {
  constructor() {
    super('Workspace revision is unavailable');
    this.name = 'MissingWorkspaceRevisionError';
  }
}

export type FileMutationCallbacks = {
  onCloseAfterSave?: (path: ProjectRelativePath, snapshot: BufferSnapshot) => void;
  onRenameCleanup?: (path: ProjectRelativePath, nextPath: ProjectRelativePath) => void;
  onDeleteCleanup?: (path: ProjectRelativePath) => void;
};

export type SaveFileVariables = {
  path: ProjectRelativePath;
  snapshot: BufferSnapshot;
  closeAfterSave?: boolean;
};

export type CreateEntryVariables = {
  kind: EntryKind;
  path: ProjectRelativePath;
};

export type RenameEntryVariables = {
  path: ProjectRelativePath;
  nextPath: ProjectRelativePath;
};

export type DeleteEntryVariables = {
  path: ProjectRelativePath;
};

export function projectFileWriteScope(projectId: string): { id: `project-file-write:${string}` } {
  return { id: `project-file-write:${projectId}` };
}

function requireWorkspaceRevision(
  queryClient: QueryClient,
  projectId: string,
): WorkspaceRevision {
  const revision = getWorkspaceRevision(queryClient, projectId);
  if (revision === undefined) {
    throw new MissingWorkspaceRevisionError();
  }
  return revision;
}

async function beginProjectFileWrite(
  queryClient: QueryClient,
  projectId: string,
): Promise<WorkspaceRevision> {
  const expected = requireWorkspaceRevision(queryClient, projectId);
  await cancelProjectFileReads(queryClient, projectId);
  return expected;
}

function parentDirectory(path: ProjectRelativePath): ProjectDirectoryPath {
  const index = path.lastIndexOf('/');
  if (index === -1) {
    return parseProjectDirectoryPath('');
  }
  return parseProjectDirectoryPath(path.slice(0, index));
}

function isSelfOrDescendant(parent: ProjectRelativePath, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function removePathQueries(
  queryClient: QueryClient,
  projectId: string,
  path: ProjectRelativePath,
): void {
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== 'project-files' || key[1] !== projectId) {
        return false;
      }
      const kind = key[2];
      if (kind !== 'tree' && kind !== 'meta' && kind !== 'content') {
        return false;
      }
      const stored = key[3];
      return typeof stored === 'string' && stored.length > 0 && isSelfOrDescendant(path, stored);
    },
  });
}

function writeWorkspaceRevision(
  queryClient: QueryClient,
  projectId: string,
  revision: WorkspaceRevision,
): void {
  queryClient.setQueryData(fileKeys.revision(projectId), revision);
}

function seedCreatedFileCaches(
  queryClient: QueryClient,
  projectId: string,
  path: ProjectRelativePath,
  file: FileMetadata,
  revision: WorkspaceRevision,
): void {
  queryClient.setQueryData(fileKeys.meta(projectId, path), file);
  const content: FileContentResponse = {
    path,
    content: '',
    workspaceRevision: revision,
  };
  queryClient.setQueryData(fileKeys.content(projectId, path), content);
}

function applySaveSuccess(
  queryClient: QueryClient,
  projectId: string,
  variables: SaveFileVariables,
  response: SaveFileResponse,
  callbacks?: FileMutationCallbacks,
): void {
  queryClient.setQueryData(fileKeys.meta(projectId, variables.path), response.file);
  const content: FileContentResponse = {
    path: variables.path,
    content: variables.snapshot.content,
    workspaceRevision: response.workspaceRevision,
  };
  queryClient.setQueryData(fileKeys.content(projectId, variables.path), content);
  writeWorkspaceRevision(queryClient, projectId, response.workspaceRevision);
  workspaceBufferRegistry.get(projectId, variables.path)?.markSaved(variables.snapshot);
  if (variables.closeAfterSave) {
    callbacks?.onCloseAfterSave?.(variables.path, variables.snapshot);
  }
}

async function applyCreateSuccess(
  queryClient: QueryClient,
  projectId: string,
  variables: CreateEntryVariables,
  response: CreateEntryResponse,
): Promise<void> {
  if (response.file !== null) {
    seedCreatedFileCaches(
      queryClient,
      projectId,
      variables.path,
      response.file,
      response.workspaceRevision,
    );
  }
  writeWorkspaceRevision(queryClient, projectId, response.workspaceRevision);
  await queryClient.invalidateQueries({
    queryKey: fileKeys.tree(projectId, parentDirectory(variables.path)),
  });
}

async function applyRenameSuccess(
  queryClient: QueryClient,
  projectId: string,
  variables: RenameEntryVariables,
  response: RenameEntryResponse,
  callbacks?: FileMutationCallbacks,
): Promise<void> {
  removePathQueries(queryClient, projectId, variables.path);
  if (response.file !== null) {
    queryClient.setQueryData(fileKeys.meta(projectId, variables.nextPath), response.file);
  }
  writeWorkspaceRevision(queryClient, projectId, response.workspaceRevision);
  workspaceBufferRegistry.remove(projectId, variables.path);
  disposeDescendantProjectModels(projectId, variables.path);
  useWorkspaceSession.getState().remapPath(variables.path, variables.nextPath);
  callbacks?.onRenameCleanup?.(variables.path, variables.nextPath);
  await queryClient.invalidateQueries({
    queryKey: fileKeys.tree(projectId, parentDirectory(variables.path)),
  });
}

async function applyDeleteSuccess(
  queryClient: QueryClient,
  projectId: string,
  variables: DeleteEntryVariables,
  response: DeleteEntryResponse,
  callbacks?: FileMutationCallbacks,
): Promise<void> {
  removePathQueries(queryClient, projectId, variables.path);
  writeWorkspaceRevision(queryClient, projectId, response.workspaceRevision);
  workspaceBufferRegistry.remove(projectId, variables.path);
  disposeDescendantProjectModels(projectId, variables.path);
  useWorkspaceSession.getState().removePathAndDescendants(variables.path);
  callbacks?.onDeleteCleanup?.(variables.path);
  await queryClient.invalidateQueries({
    queryKey: fileKeys.tree(projectId, parentDirectory(variables.path)),
  });
}

export function useSaveFileMutation(projectId: string, callbacks?: FileMutationCallbacks) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: projectFileWriteScope(projectId),
    retry: false,
    mutationFn: async (variables: SaveFileVariables) => {
      const expected = await beginProjectFileWrite(queryClient, projectId);
      const response = await saveFileContent(projectId, variables.path, {
        content: variables.snapshot.content,
        expectedWorkspaceRevision: expected,
      });
      applySaveSuccess(queryClient, projectId, variables, response, callbacks);
      return response;
    },
  });
}

export function useCreateEntryMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: projectFileWriteScope(projectId),
    retry: false,
    mutationFn: async (variables: CreateEntryVariables) => {
      const expected = await beginProjectFileWrite(queryClient, projectId);
      const response = await createEntry(projectId, {
        kind: variables.kind,
        path: variables.path,
        expectedWorkspaceRevision: expected,
      });
      await applyCreateSuccess(queryClient, projectId, variables, response);
      return response;
    },
  });
}

export function useRenameEntryMutation(projectId: string, callbacks?: FileMutationCallbacks) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: projectFileWriteScope(projectId),
    retry: false,
    mutationFn: async (variables: RenameEntryVariables) => {
      const expected = await beginProjectFileWrite(queryClient, projectId);
      const response = await renameEntry(projectId, {
        path: variables.path,
        nextPath: variables.nextPath,
        expectedWorkspaceRevision: expected,
      });
      await applyRenameSuccess(queryClient, projectId, variables, response, callbacks);
      return response;
    },
  });
}

export function useDeleteEntryMutation(projectId: string, callbacks?: FileMutationCallbacks) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: projectFileWriteScope(projectId),
    retry: false,
    mutationFn: async (variables: DeleteEntryVariables) => {
      const expected = await beginProjectFileWrite(queryClient, projectId);
      const response = await deleteEntry(projectId, variables.path, {
        expectedWorkspaceRevision: expected,
      });
      await applyDeleteSuccess(queryClient, projectId, variables, response, callbacks);
      return response;
    },
  });
}

export function fileMutationErrorMessage(
  error: unknown,
  fallback = 'Unable to update files',
): string {
  if (error instanceof MissingWorkspaceRevisionError) {
    return 'Workspace revision is unavailable';
  }
  if (error instanceof Error && /network request failed/i.test(error.message)) {
    return 'Network request failed';
  }
  if (!(error instanceof ApiRequestError)) {
    return fallback;
  }
  if (error.status === 403 || error.body?.code === 'FORBIDDEN') {
    return 'Access denied';
  }
  if (error.body?.code === 'PROJECT_LOCKED') {
    return 'Project is locked';
  }
  if (error.body?.code === 'WORKSPACE_REVISION_CONFLICT') {
    return 'Workspace revision conflict';
  }
  if (error.body?.code === 'ENTRY_ALREADY_EXISTS') {
    return 'An entry with this name already exists';
  }
  if (error.body?.code === 'DIRECTORY_NOT_EMPTY') {
    return 'Directory is not empty';
  }
  if (error.status === 413 || error.body?.code === 'FILE_TOO_LARGE') {
    return 'File is too large';
  }
  if (error.status === 415 || error.body?.code === 'BINARY_FILE') {
    return 'This file type is not supported';
  }
  if (error.status >= 500) {
    return fallback;
  }
  return fallback;
}
