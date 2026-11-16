import { parseOwnerShare, parsePublicRunShare, parseRunSharePreview, parseSharePage, type PublishRequest } from '../contracts/runShare';
import { getHttpClient } from './httpClient';

function runUrl(projectId: string, runId: string) { return `/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`; }
export async function getRunSharePreview(projectId: string, runId: string, signal?: AbortSignal) {
  return parseRunSharePreview(await getHttpClient().request<unknown>(`${runUrl(projectId, runId)}/share-preview`, { signal }));
}
export async function createRunShare(projectId: string, runId: string, request: PublishRequest) {
  const { requestId, snapshotDigest, title, description } = request;
  return parseOwnerShare(await getHttpClient().request<unknown>(`${runUrl(projectId, runId)}/shares`, { method: 'POST', body: { requestId, snapshotDigest, title, description } }));
}
export async function getPublicRunShare(token: string, signal?: AbortSignal) {
  return parsePublicRunShare(await getHttpClient().request<unknown>(`/api/v1/public/run-shares/${encodeURIComponent(token)}`, { auth: false, signal }));
}
export async function listMyRunShares(before?: string, signal?: AbortSignal) {
  const search = new URLSearchParams({ limit: '20' }); if (before !== undefined) search.set('before', before);
  return parseSharePage(await getHttpClient().request<unknown>(`/api/v1/run-shares?${search}`, { signal }));
}
export async function revokeRunShare(shareId: string): Promise<void> {
  await getHttpClient().request(`/api/v1/run-shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
}
