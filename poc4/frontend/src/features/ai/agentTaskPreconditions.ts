/**
 * The pure start gate for an agent task submission, shared by the AI panel and
 * the workbench shell. It performs no I/O: the caller supplies the observed
 * workspace facts and the function only decides whether a task may start.
 */

export type AgentTaskPreconditionReason =
  | 'DIRTY_FILES'
  | 'WRITE_PENDING'
  | 'RUN_AUTHORITY_UNKNOWN'
  | 'REVISION_UNAVAILABLE'
  | 'TASK_ACTIVE'
  | 'RELOADING';

export const agentTaskPreconditionLabels: Record<AgentTaskPreconditionReason, string> = {
  DIRTY_FILES: '请先保存或放弃未保存的修改',
  WRITE_PENDING: '文件正在保存，请稍候',
  RUN_AUTHORITY_UNKNOWN: '正在核对运行状态，请稍候',
  REVISION_UNAVAILABLE: '暂时无法获取工作区版本',
  TASK_ACTIVE: '已有 AI 任务正在执行',
  RELOADING: '正在重新加载工作区',
};

export type AgentTaskPreconditions =
  | { canStart: true; reason: null }
  | { canStart: false; reason: AgentTaskPreconditionReason };

export type AgentTaskPreconditionsInput = {
  dirtyCount: number;
  writePending: boolean;
  hasActiveRun: boolean;
  runAuthorityKnown: boolean;
  /** The known workspace revision; unknown or empty means it was never loaded. */
  workspaceRevision: string | undefined;
  /** The backend's writesLocked — the authoritative task occupancy signal. */
  taskWritesLocked: boolean;
  reloading: boolean;
};

export function resolveAgentTaskPreconditions(
  input: AgentTaskPreconditionsInput,
): AgentTaskPreconditions {
  if (input.dirtyCount > 0) {
    return { canStart: false, reason: 'DIRTY_FILES' };
  }
  if (input.writePending) {
    return { canStart: false, reason: 'WRITE_PENDING' };
  }
  if (input.runAuthorityKnown === false) {
    return { canStart: false, reason: 'RUN_AUTHORITY_UNKNOWN' };
  }
  if (input.workspaceRevision === undefined || input.workspaceRevision.length === 0) {
    return { canStart: false, reason: 'REVISION_UNAVAILABLE' };
  }
  if (input.taskWritesLocked) {
    return { canStart: false, reason: 'TASK_ACTIVE' };
  }
  if (input.reloading) {
    return { canStart: false, reason: 'RELOADING' };
  }
  return { canStart: true, reason: null };
}
