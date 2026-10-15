import type { RunSummary } from '@/contracts/run';
import type { RunLogSnapshot } from './RunLogStore';

export function createRunEvidence(projectId: string, run: RunSummary, snapshot: RunLogSnapshot) {
  const matched = snapshot.projectId === projectId && snapshot.runId === run.id;
  const chunks = matched ? snapshot.chunks : [];
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    projectId,
    run,
    logs: {
      scope: '已读取的日志窗口；不保证包含完整历史或尚未到达的输出',
      connection: matched ? snapshot.connection : 'idle',
      truncated: run.logTruncated || (matched && snapshot.window.truncated),
      evictedBytes: Math.max(run.logEvictedBytes, matched ? snapshot.window.evictedBytes : 0),
      firstReadSeq: chunks[0]?.seq ?? null,
      lastReadSeq: chunks[chunks.length - 1]?.seq ?? null,
      text: chunks.map((chunk) => chunk.text).join(''),
    },
  };
}
