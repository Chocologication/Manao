import { describe, expect, it } from 'vitest';
import { parseWorkspaceRevision } from '@/contracts/file';
import { parseRunId, type RunSummary } from '@/contracts/run';
import { clonePoc4RunPolicy } from '@/mocks/runFixtures';
import { EMPTY_LOG_WINDOW, type RunLogSnapshot } from './RunLogStore';
import { createRunEvidence } from './runEvidence';

const run: RunSummary = {
  id: parseRunId('run-a'), state: 'FAILED', requestedWorkspaceRevision: parseWorkspaceRevision('rev-a'),
  policy: clonePoc4RunPolicy(), createdAt: '2026-10-14T10:00:00.000Z',
  startedAt: '2026-10-14T10:00:01.000Z', finishedAt: '2026-10-14T10:00:03.000Z',
  terminationReason: 'BUILD_FAILED', exitCode: 1, logTruncated: true,
  logEvictedBytes: 128, lastLogSeq: 20, firstReadyAt: null, expiresAt: null,
};
const snapshot: RunLogSnapshot = {
  projectId: 'project-a', runId: run.id,
  chunks: [{ seq: 18, text: 'first\n', byteLength: 6, persistedAt: run.createdAt },
    { seq: 19, text: 'last\n', byteLength: 5, persistedAt: run.createdAt }],
  lastAppliedSeq: 19, connection: 'complete', pendingOutput: false, error: null,
  window: { ...EMPTY_LOG_WINDOW, firstAvailableSeq: 18, lastAvailableSeq: 20, truncated: true, evictedBytes: 256 },
};

describe('run evidence export', () => {
  it('preserves Run metadata and exports only the read sequence range with truncation', () => {
    const evidence = createRunEvidence('project-a', run, snapshot);
    expect(evidence.run).toEqual(run);
    expect(evidence.logs).toMatchObject({ text: 'first\nlast\n', firstReadSeq: 18, lastReadSeq: 19,
      truncated: true, evictedBytes: 256, connection: 'complete' });
    expect(evidence.logs.scope).toContain('不保证');
  });
  it('never exports stale logs from a different project or Run', () => {
    for (const stale of [{ ...snapshot, projectId: 'project-b' }, { ...snapshot, runId: parseRunId('run-b') }]) {
      const evidence = createRunEvidence('project-a', run, stale);
      expect(evidence.logs).toMatchObject({ text: '', connection: 'idle', firstReadSeq: null, lastReadSeq: null,
        truncated: true, evictedBytes: 128 });
      expect(evidence.run.id).toBe(run.id);
    }
  });
});
