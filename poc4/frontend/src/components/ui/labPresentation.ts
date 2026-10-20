import type { RunState } from '@/contracts/run';

export const runStateLabels: Record<RunState, string> = {
  STARTING: '准备运行环境', RUNNING: '正在执行', STOPPING: '正在停止',
  RECOVERING: '正在恢复状态', SUCCEEDED: '运行成功', FAILED: '运行失败',
  TIMED_OUT: '运行超时', CANCELLED: '已停止',
};

export function formatLabDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
