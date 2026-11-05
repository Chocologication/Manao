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
  | 'AGENT_TASK_ACTIVE'
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
  /** Explicitly forwarded: an occupying agent task blocks Run starts. */
  agentTaskActive?: boolean;
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
  if (input.agentTaskActive === true) {
    return { canRequestRun: false, reason: 'AGENT_TASK_ACTIVE' };
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
    return '运行前请先保存或放弃未保存的修改';
  }
  if (reason === 'WRITE_PENDING') {
    return '文件正在保存，请稍后运行';
  }
  if (reason === 'REVISION_UNAVAILABLE') {
    return '暂时无法获取工作区版本';
  }
  if (reason === 'AUTHORITY_LOADING') {
    return '正在核对运行状态，请稍候';
  }
  if (reason === 'START_PENDING') {
    return '正在提交运行请求';
  }
  if (reason === 'RUN_ACTIVE') {
    return '项目正在运行，请先停止当前运行';
  }
  if (reason === 'RELOADING_WORKSPACE') {
    return '正在重新加载运行后的工作区';
  }
  if (reason === 'RELOAD_FAILED') {
    return '工作区重新加载失败，请重试';
  }
  if (reason === 'AGENT_TASK_ACTIVE') {
    return 'AI 任务正在使用工作区，请等待任务结束';
  }
  return '当前环境暂不支持运行';
}
