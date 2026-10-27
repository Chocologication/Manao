import type { AgentTaskSnapshot } from '@/contracts/agentTask';

export const CONTINUE_TASK_PROMPT = '继续这个会话中尚未完成的工作。先读取当前项目相关文件并核对应用状态，基于当前已保存版本继续；不要重放上一次未确认的工具操作。';

export function canContinueTask(task: AgentTaskSnapshot | null, conversationId: string | undefined): boolean {
  return Boolean(conversationId && task?.conversationId === conversationId && task.state === 'FAILED'
    && !task.writesLocked && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(task.closeReasonCode ?? ''));
}
