import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from './httpClient';
import { createRunShare, getPublicRunShare, getRunSharePreview, listMyRunShares, revokeRunShare } from './runShareApi';

const owner = { id: 'share-1', title: '结果', sourceProjectName: 'Demo', createdAt: '2026-11-16T00:00:00Z', expiresAt: '2026-11-19T00:00:00Z', status: 'ACTIVE', sharePath: `/shares/${'a'.repeat(43)}` };
const snapshot = { run: { state: 'SUCCEEDED', exitCode: 0, createdAt: owner.createdAt, startedAt: null, finishedAt: owner.createdAt, language: 'java', runtimeLabel: 'Java 17 / Maven 3' }, logText: '' };
afterEach(() => { setHttpClient(null); vi.restoreAllMocks(); });
describe('run share HTTP boundary', () => {
  it.each([200, 201])('posts only the four publish fields and accepts status %s', async (status) => {
    let captured: RequestInit | undefined; let path = '';
    setHttpClient(new HttpClient({ getAccessToken: () => 'owner-token', onUnauthorized() { }, fetchImpl: async (url, init) => { path = String(url); captured = init; return Response.json(owner, { status }); } }));
    const request = { requestId: 'request-1', snapshotDigest: 'd'.repeat(64), title: '结果', description: '' };
    expect((await createRunShare('project/1', 'run/1', { ...request, logText: 'private' } as typeof request)).id).toBe('share-1');
    expect(path).toBe('/api/v1/projects/project%2F1/runs/run%2F1/shares');
    const body = JSON.parse(String(captured?.body));
    expect(Object.keys(body).sort()).toEqual(['description', 'requestId', 'snapshotDigest', 'title']);
    expect(body).not.toHaveProperty('logText'); expect(body).not.toHaveProperty('expiresAt');
    expect(new Headers(captured?.headers).get('Authorization')).toBe('Bearer owner-token');
  });
  it.each([null, 'signed-in-token'])('public reads never attach credentials for %s', async (accessToken) => {
    let authorization: string | null = 'unexpected';
    setHttpClient(new HttpClient({ getAccessToken: () => accessToken, onUnauthorized() { throw new Error('must not clear session'); }, fetchImpl: async (_url, init) => { authorization = new Headers(init?.headers).get('Authorization'); return Response.json({ title: '结果', description: '', createdAt: owner.createdAt, expiresAt: owner.expiresAt, snapshot }); } }));
    expect((await getPublicRunShare('a'.repeat(43))).snapshot.logText).toBe(''); expect(authorization).toBeNull();
  });
  it.each([['RUN_SHARE_NOT_TERMINAL', 409], ['RUN_SHARE_PREVIEW_CHANGED', 409], ['RUN_SHARE_ALREADY_ACTIVE', 409], ['RUN_SHARE_REQUEST_MISMATCH', 409], ['RUN_SHARE_EXPIRED', 410], ['RUN_SHARE_REVOKED', 410], ['RUN_SHARE_NOT_FOUND', 404], ['UNAUTHENTICATED', 401]] as const)('preserves %s and does not clear the signed-in session for public failures', async (code, status) => {
    const clear = vi.fn();
    setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: clear, fetchImpl: async () => Response.json({ code, message: 'Safe error', traceId: 'trace' }, { status }) }));
    await expect(getPublicRunShare('a'.repeat(43))).rejects.toMatchObject({ status, body: { code } }); expect(clear).not.toHaveBeenCalled();
  });
  it('uses preview, encoded owner cursor and share-id revoke endpoints', async () => {
    const paths: string[] = [];
    setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized() { }, fetchImpl: async (url, init) => { paths.push(`${init?.method} ${url}`); if (init?.method === 'DELETE') return new Response(null, { status: 204 }); if (String(url).includes('share-preview')) return Response.json({ kind: 'EXISTING', snapshot: null, snapshotDigest: null, share: owner }); return Response.json({ items: [owner], nextCursor: null }); } }));
    await getRunSharePreview('p', 'r'); await listMyRunShares('cursor+/='); await revokeRunShare('share/1');
    expect(paths).toEqual(['GET /api/v1/projects/p/runs/r/share-preview', 'GET /api/v1/run-shares?limit=20&before=cursor%2B%2F%3D', 'DELETE /api/v1/run-shares/share%2F1']);
  });
});
