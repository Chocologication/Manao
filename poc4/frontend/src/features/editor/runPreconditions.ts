import type { WorkspaceRevision } from '../../contracts/file';

export type RunPreconditions = {
  canRequestRun: boolean;
  reason: 'DIRTY_FILES' | 'WRITE_PENDING' | 'REVISION_UNAVAILABLE' | 'STAGE_4_UNAVAILABLE';
};

export type RunPreconditionsInput = {
  dirtyCount: number;
  writePending: boolean;
  workspaceRevision: WorkspaceRevision | undefined;
};

export function resolveRunPreconditions(input: RunPreconditionsInput): RunPreconditions {
  if (input.dirtyCount > 0) {
    return { canRequestRun: false, reason: 'DIRTY_FILES' };
  }
  if (input.writePending) {
    return { canRequestRun: false, reason: 'WRITE_PENDING' };
  }
  if (input.workspaceRevision === undefined || input.workspaceRevision.length === 0) {
    return { canRequestRun: false, reason: 'REVISION_UNAVAILABLE' };
  }
  return { canRequestRun: false, reason: 'STAGE_4_UNAVAILABLE' };
}

export function runPreconditionDescription(reason: RunPreconditions['reason']): string {
  if (reason === 'DIRTY_FILES') {
    return 'DIRTY_FILES: Save or discard unsaved changes before running';
  }
  if (reason === 'WRITE_PENDING') {
    return 'WRITE_PENDING: A file write is in progress';
  }
  if (reason === 'REVISION_UNAVAILABLE') {
    return 'REVISION_UNAVAILABLE: Workspace revision is unavailable';
  }
  return 'STAGE_4_UNAVAILABLE: Run is not available in this stage';
}

export function terminalPreconditionDescription(
  reason: Extract<RunPreconditions['reason'], 'DIRTY_FILES' | 'STAGE_4_UNAVAILABLE'>,
): string {
  if (reason === 'DIRTY_FILES') {
    return 'DIRTY_FILES: Save or discard unsaved changes before using the terminal';
  }
  return 'STAGE_4_UNAVAILABLE: Terminal is not available in this stage';
}
