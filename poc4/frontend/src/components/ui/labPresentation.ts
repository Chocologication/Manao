import type { RunState } from '@/contracts/run';
import type { DependencyState } from '@/contracts/project';
import type { TerminalAuditState } from '@/contracts/terminal';
import type { AgentTaskState } from '@/contracts/agentTask';

export const runStateLabels: Record<RunState, string> = {
  STARTING: '准备运行环境', RUNNING: '正在执行', STOPPING: '正在停止',
  RECOVERING: '正在恢复状态', SUCCEEDED: '运行成功', FAILED: '运行失败',
  TIMED_OUT: '运行超时', CANCELLED: '已停止',
};

export function runStateLabel(state: string): string {
  return Object.hasOwn(runStateLabels, state) ? runStateLabels[state as RunState] : '状态未知';
}

export const dependencyStateLabels: Record<DependencyState, string> = {
  ABSENT: '未启用', PROVISIONING: '正在准备', READY: '已就绪',
  UNAVAILABLE: '暂不可用', RECOVERY_REQUIRED: '需要恢复',
};

export const terminalAuditStateLabels: Record<TerminalAuditState, string> = {
  RUNNING: '正在执行', SUCCEEDED: '执行成功', FAILED: '执行失败', INTERRUPTED: '已中断',
};

export const agentTaskStateLabels: Record<AgentTaskState, string> = {
  QUEUED: '等待执行', RUNNING: '正在执行', COMPLETED: '已完成', FAILED: '执行失败', NEEDS_ATTENTION: '需要处理',
};

export function formatLabDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
