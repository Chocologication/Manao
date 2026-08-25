import type { WorkspaceRevision } from '../../contracts/file';
import type { RunAuthorityPhase } from '../runs/RunAuthorityCoordinator';

export type RunPreconditionReason =
  | 'DIRTY_FILES'
  | 'WRITE_PENDING'
  | 'REVISION_UNAVAILABLE'
  | 'AUTHORITY_LOADING'
  | 'START_PENDING'
  | 'RUN_ACTIVE'
  | 'RELOADING_WORKSPACE'
  | 'RELOAD_FAILED'
  | 'STAGE_4_UNAVAILABLE';

export type RunPreconditions =
  | { canRequestRun: true; reason: null }
  | { canRequestRun: false; reason: RunPreconditionReason };

export type RunPreconditionsInput = {
  dirtyCount: number;
  writePending: boolean;
  workspaceRevision: WorkspaceRevision | undefined;
  authorityLoaded?: boolean;
  hasActiveLockingRun?: boolean;
  startPending?: boolean;
  reloadPhase?: RunAuthorityPhase;
};

function authorityFieldsOmitted(input: RunPreconditionsInput): boolean {
  return (
    input.authorityLoaded === undefined &&
    input.hasActiveLockingRun === undefined &&
    input.startPending === undefined &&
    input.reloadPhase === undefined
  );
}
function allAuthorityFieldsPresent(input: RunPreconditionsInput): boolean {
  return (
    input.authorityLoaded !== undefined &&
    input.hasActiveLockingRun !== undefined &&
    input.startPending !== undefined &&
    input.reloadPhase !== undefined
  );
}

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
  if (authorityFieldsOmitted(input)) {
    return { canRequestRun: false, reason: 'STAGE_4_UNAVAILABLE' };
  }
  if (!allAuthorityFieldsPresent(input)) {
    return { canRequestRun: false, reason: 'AUTHORITY_LOADING' };
  }
  if (input.authorityLoaded !== true) {
    return { canRequestRun: false, reason: 'AUTHORITY_LOADING' };
  }
  if (input.reloadPhase === 'RELOADING_WORKSPACE') {
    return { canRequestRun: false, reason: 'RELOADING_WORKSPACE' };
  }
  if (input.reloadPhase === 'RELOAD_FAILED') {
    return { canRequestRun: false, reason: 'RELOAD_FAILED' };
  }
  if (input.startPending === true) {
    return { canRequestRun: false, reason: 'START_PENDING' };
  }
  if (input.hasActiveLockingRun === true) {
    return { canRequestRun: false, reason: 'RUN_ACTIVE' };
  }
  if (input.reloadPhase === 'LOADING_AUTHORITY') {
    return { canRequestRun: false, reason: 'AUTHORITY_LOADING' };
  }
  return { canRequestRun: true, reason: null };
}

export function runPreconditionDescription(reason: RunPreconditionReason | null): string {
  if (reason === null) {
    return '';
  }
  if (reason === 'DIRTY_FILES') {
    return 'DIRTY_FILES: Save or discard unsaved changes before running';
  }
  if (reason === 'WRITE_PENDING') {
    return 'WRITE_PENDING: A file write is in progress';
  }
  if (reason === 'REVISION_UNAVAILABLE') {
    return 'REVISION_UNAVAILABLE: Workspace revision is unavailable';
  }
  if (reason === 'AUTHORITY_LOADING') {
    return 'AUTHORITY_LOADING: Cannot verify run authority';
  }
  if (reason === 'START_PENDING') {
    return 'START_PENDING: A start request is in progress';
  }
  if (reason === 'RUN_ACTIVE') {
    return 'RUN_ACTIVE: A run is already active';
  }
  if (reason === 'RELOADING_WORKSPACE') {
    return 'RELOADING_WORKSPACE: Workspace is reloading after a run';
  }
  if (reason === 'RELOAD_FAILED') {
    return 'RELOAD_FAILED: Workspace reload failed';
  }
  return 'STAGE_4_UNAVAILABLE: Run is not available in this stage';
}
