import { describe, expect, it } from 'vitest';
import { canContinueTask } from './agentTaskControl';
import type { AgentTaskSnapshot } from '@/contracts/agentTask';

const task: AgentTaskSnapshot = { taskId: 'old', conversationId: 'conversation', state: 'FAILED',
  writesLocked: false, workspaceRevision: '8', progress: [], changedPaths: [], summary: null,
  failureCode: 'AI_ABORTED', closeReasonCode: 'AI_PAUSED_BY_OWNER' };
describe('continuation eligibility', () => {
  it('allows only released pause and restart tasks in their original conversation', () => {
    expect(canContinueTask(task, 'conversation')).toBe(true);
    expect(canContinueTask({ ...task, closeReasonCode: 'AI_WORKER_RESTARTED' }, 'conversation')).toBe(true);
    for (const value of [null, { ...task, writesLocked: true }, { ...task, state: 'RUNNING' as const },
      { ...task, state: 'COMPLETED' as const }, { ...task, closeReasonCode: 'AI_CLOSED' }]) {
      expect(canContinueTask(value, 'conversation')).toBe(false);
    }
    expect(canContinueTask(task, 'another')).toBe(false);
    expect(canContinueTask(task, undefined)).toBe(false);
  });
});
