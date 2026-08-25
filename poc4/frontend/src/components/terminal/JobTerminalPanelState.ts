import type { RunId } from '@/contracts/run';
import type { JobTerminalRunAuthority } from '@/features/terminal/JobTerminalController';

export type RetainedTerminalAuditRun = {
  projectId: string;
  runId: RunId;
};

export function resolveTerminalAuditRunId(
  projectId: string,
  run: JobTerminalRunAuthority | null,
  lastAuditRun: RetainedTerminalAuditRun | null,
): RunId | null {
  if (run !== null) return run.id;
  return lastAuditRun?.projectId === projectId ? lastAuditRun.runId : null;
}
