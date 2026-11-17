export type RunShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type RunSnapshot = {
  state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  language: 'java' | 'python' | 'javascript' | 'typescript';
  runtimeLabel: string;
};
export type SnapshotContent = { run: RunSnapshot; logText: string };
export type PublishRequest = { requestId: string; snapshotDigest: string; title: string; description: string };
export type OwnerShare = { id: string; title: string; sourceProjectName: string; createdAt: string; expiresAt: string; status: RunShareStatus; sharePath: string | null };
export type RunSharePreview =
  | { kind: 'PREVIEW'; snapshot: SnapshotContent; snapshotDigest: string; share: null }
  | { kind: 'EXISTING'; snapshot: null; snapshotDigest: null; share: OwnerShare };
export type PublicShare = { title: string; description: string; createdAt: string; expiresAt: string; snapshot: SnapshotContent };
export type SharePage = { items: OwnerShare[]; nextCursor: string | null };

function invalid(): never { throw new Error('Invalid run share response'); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function date(value: unknown): string { const result = text(value); return /^\d{4}-\d{2}-\d{2}T/.test(result) && Number.isFinite(Date.parse(result)) ? result : invalid(); }
function nullableDate(value: unknown): string | null { return value === null ? null : date(value); }
function member<T extends string>(value: unknown, allowed: readonly T[]): T { return allowed.includes(value as T) ? value as T : invalid(); }

export function shareUrl(path: string, origin = window.location.origin): string {
  if (!/^\/shares\/[A-Za-z0-9_-]{43}$/.test(path)) return invalid();
  return new URL(path, origin).toString();
}
export function parseOwnerShare(value: unknown): OwnerShare {
  const v = record(value); const status = member(v.status, ['ACTIVE', 'EXPIRED', 'REVOKED']);
  const sharePath = status === 'ACTIVE' ? text(v.sharePath) : v.sharePath === null ? null : invalid();
  if (sharePath !== null) shareUrl(sharePath, 'https://validation.invalid');
  return { id: text(v.id), title: text(v.title), sourceProjectName: text(v.sourceProjectName), createdAt: date(v.createdAt), expiresAt: date(v.expiresAt), status, sharePath };
}
export function parseSnapshotContent(value: unknown): SnapshotContent {
  const v = record(value), r = record(v.run);
  const exitCode = r.exitCode === null ? null : typeof r.exitCode === 'number' && Number.isSafeInteger(r.exitCode) ? r.exitCode : invalid();
  return { run: { state: member(r.state, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']), exitCode, createdAt: date(r.createdAt), startedAt: nullableDate(r.startedAt), finishedAt: nullableDate(r.finishedAt), language: member(r.language, ['java', 'python', 'javascript', 'typescript']), runtimeLabel: text(r.runtimeLabel) }, logText: text(v.logText) };
}
export function parseRunSharePreview(value: unknown): RunSharePreview {
  const v = record(value);
  if (v.kind === 'EXISTING' && v.snapshot === null && v.snapshotDigest === null) return { kind: 'EXISTING', snapshot: null, snapshotDigest: null, share: parseOwnerShare(v.share) };
  if (v.kind === 'PREVIEW' && v.share === null && typeof v.snapshotDigest === 'string' && /^[a-f0-9]{64}$/.test(v.snapshotDigest)) return { kind: 'PREVIEW', snapshot: parseSnapshotContent(v.snapshot), snapshotDigest: v.snapshotDigest, share: null };
  return invalid();
}
export function parsePublicRunShare(value: unknown): PublicShare {
  const v = record(value); return { title: text(v.title), description: text(v.description), createdAt: date(v.createdAt), expiresAt: date(v.expiresAt), snapshot: parseSnapshotContent(v.snapshot) };
}
export function parseSharePage(value: unknown): SharePage {
  const v = record(value); if (!Array.isArray(v.items)) return invalid();
  return { items: v.items.map(parseOwnerShare), nextCursor: v.nextCursor === null ? null : text(v.nextCursor) };
}
