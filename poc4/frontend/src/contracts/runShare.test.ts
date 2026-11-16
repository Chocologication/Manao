import { describe, expect, it } from 'vitest';
import { parseOwnerShare, parsePublicRunShare, parseRunSharePreview, parseSharePage, shareUrl } from './runShare';

const token = 'a'.repeat(43);
const owner = { id: 'share-1', title: '结果', sourceProjectName: 'Demo', createdAt: '2026-11-16T00:00:00Z', expiresAt: '2026-11-19T00:00:00Z', status: 'ACTIVE', sharePath: `/shares/${token}` };
const snapshot = { run: { state: 'FAILED', exitCode: null, createdAt: '2026-11-16T00:00:00Z', startedAt: null, finishedAt: '2026-11-16T00:00:01Z', language: 'python', runtimeLabel: 'Python 3.13 / uv' }, logText: '<script>alert(1)</script>\n' };

describe('run share response boundary', () => {
  it('keeps null exit and log bytes and discards fields outside the public contract', () => {
    const parsed = parsePublicRunShare({ title: '结果', description: '', createdAt: owner.createdAt, expiresAt: owner.expiresAt, snapshot, ownerId: 'secret' });
    expect(parsed.snapshot.run.exitCode).toBeNull();
    expect(parsed.snapshot.logText).toBe('<script>alert(1)</script>\n');
    expect(parsed).not.toHaveProperty('ownerId');
  });
  it('requires the discriminated preview shape and terminal state', () => {
    expect(parseRunSharePreview({ kind: 'PREVIEW', snapshot, snapshotDigest: 'd'.repeat(64), share: null }).kind).toBe('PREVIEW');
    expect(() => parseRunSharePreview({ kind: 'EXISTING', snapshot, snapshotDigest: null, share: owner })).toThrow();
    expect(() => parseRunSharePreview({ kind: 'PREVIEW', snapshot: { ...snapshot, run: { ...snapshot.run, state: 'RUNNING' } }, snapshotDigest: 'd'.repeat(64), share: null })).toThrow();
  });
  it.each(['https://evil.test/shares/x', '//evil.test/x', `/shares/${token}?x=1`, `/shares/${token}#x`, '/shares/short', `/shares/${token}/..`, `/shares/${token}\n`])('rejects unsafe share path %s', (sharePath) => {
    expect(() => parseOwnerShare({ ...owner, sharePath })).toThrow();
  });
  it('builds a same-origin URL and parses inactive summaries without a link', () => {
    expect(shareUrl(owner.sharePath, 'https://manao.test')).toBe(`https://manao.test/shares/${token}`);
    expect(parseSharePage({ items: [{ ...owner, status: 'EXPIRED', sharePath: null }], nextCursor: 'opaque' }).items[0]?.sharePath).toBeNull();
    expect(() => parseOwnerShare({ ...owner, status: 'REVOKED' })).toThrow();
  });
  it('rejects missing logs and malformed timestamps instead of showing an empty successful result', () => {
    expect(() => parsePublicRunShare({ title: '', description: '', createdAt: 'bad', expiresAt: owner.expiresAt, snapshot })).toThrow();
    expect(() => parsePublicRunShare({ title: '', description: '', createdAt: owner.createdAt, expiresAt: owner.expiresAt, snapshot: { ...snapshot, logText: null } })).toThrow();
  });
});
