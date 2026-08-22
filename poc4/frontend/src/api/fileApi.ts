import {
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
  type FileContentResponse,
  type FileMetadata,
  type FileTreeResponse,
  type ProjectDirectoryPath,
  type ProjectRelativePath,
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

export async function listDirectory(
  projectId: string,
  directory: ProjectDirectoryPath,
): Promise<FileTreeResponse> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'tree', directory),
  );
  return parseFileTreeResponse(payload, directory);
}

export async function getFileMetadata(
  projectId: string,
  path: ProjectRelativePath,
): Promise<FileMetadata> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'meta', path),
  );
  return parseFileMetadata(payload, path);
}

export async function getFileContent(
  projectId: string,
  path: ProjectRelativePath,
): Promise<FileContentResponse> {
  const payload = await getHttpClient().request<unknown>(
    projectFileUrl(projectId, 'content', path),
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
