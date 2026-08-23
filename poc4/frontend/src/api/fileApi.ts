import {
  parseCreateEntryResponse,
  parseDeleteEntryResponse,
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
  parseRenameEntryResponse,
  parseSaveFileResponse,
  type CreateEntryRequest,
  type CreateEntryResponse,
  type DeleteEntryRequest,
  type DeleteEntryResponse,
  type FileContentResponse,
  type FileMetadata,
  type FileTreeResponse,
  type ProjectDirectoryPath,
  type ProjectRelativePath,
  type RenameEntryRequest,
  type RenameEntryResponse,
  type SaveFileRequest,
  type SaveFileResponse,
} from '../contracts/file';
import { getHttpClient, type BlobResponse } from './httpClient';

export type { BlobResponse };

function projectFileUrl(
  projectId: string,
  resource: 'tree' | 'meta' | 'content' | 'download',
  path: ProjectDirectoryPath,
): string {
  const search = new URLSearchParams();
  search.set('path', path);
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/${resource}?${search.toString()}`;
}

function projectEntriesUrl(projectId: string, suffix = '', path?: ProjectRelativePath): string {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/entries${suffix}`;
  if (path === undefined) {
    return base;
  }
  const search = new URLSearchParams();
  search.set('path', path);
  return `${base}?${search.toString()}`;
}

export async function listDirectory(
  projectId: string,
  directory: ProjectDirectoryPath,
  signal?: AbortSignal,
): Promise<FileTreeResponse> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'tree', directory),
    { signal },
  );
  return parseFileTreeResponse(payload, directory);
}

export async function getFileMetadata(
  projectId: string,
  path: ProjectRelativePath,
  signal?: AbortSignal,
): Promise<FileMetadata> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'meta', path),
    { signal },
  );
  return parseFileMetadata(payload, path);
}

export async function getFileContent(
  projectId: string,
  path: ProjectRelativePath,
  signal?: AbortSignal,
): Promise<FileContentResponse> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'content', path),
    { signal },
  );
  return parseFileContentResponse(payload, path);
}

export function downloadFileBlob(
  projectId: string,
  path: ProjectRelativePath,
  fallbackName: string,
): Promise<BlobResponse> {
  return getHttpClient().requestBlob(projectFileUrl(projectId, 'download', path), {
    fallbackName,
  });
}

export async function saveFileContent(
  projectId: string,
  path: ProjectRelativePath,
  request: SaveFileRequest,
  signal?: AbortSignal,
): Promise<SaveFileResponse> {
  const payload = await getHttpClient().request<unknown>(projectFileUrl(projectId, 'content', path), {
    method: 'PUT',
    body: request,
    signal,
  });
  return parseSaveFileResponse(payload, path);
}

export async function createEntry(
  projectId: string,
  request: CreateEntryRequest,
  signal?: AbortSignal,
): Promise<CreateEntryResponse> {
  const payload = await getHttpClient().request<unknown>(projectEntriesUrl(projectId), {
    method: 'POST',
    body: request,
    signal,
  });
  return parseCreateEntryResponse(payload, request.path, request.kind);
}

export async function renameEntry(
  projectId: string,
  request: RenameEntryRequest,
  signal?: AbortSignal,
): Promise<RenameEntryResponse> {
  const payload = await getHttpClient().request<unknown>(projectEntriesUrl(projectId, '/rename'), {
    method: 'POST',
    body: request,
    signal,
  });
  return parseRenameEntryResponse(payload, request.path, request.nextPath);
}

export async function deleteEntry(
  projectId: string,
  path: ProjectRelativePath,
  request: DeleteEntryRequest,
  signal?: AbortSignal,
): Promise<DeleteEntryResponse> {
  const payload = await getHttpClient().request<unknown>(projectEntriesUrl(projectId, '', path), {
    method: 'DELETE',
    body: request,
    signal,
  });
  return parseDeleteEntryResponse(payload, path);
}
