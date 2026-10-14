import { describe, expect, it } from 'vitest';
import { resolveAgentTaskPreconditions } from './agentTaskPreconditions';

const STARTABLE = {
  dirtyCount: 0,
  writePending: false,
  hasActiveRun: false,
  workspaceRevision: '7',
  taskWritesLocked: false,
  reloading: false,
};

const BLOCKED_CASES: ReadonlyArray<{
  name: string;
  input: Partial<typeof STARTABLE>;
  reason: string;
}> = [
  { name: 'dirty files', input: { dirtyCount: 1 }, reason: 'DIRTY_FILES' },
  { name: 'a pending save or dependency write', input: { writePending: true }, reason: 'WRITE_PENDING' },
  { name: 'an active run', input: { hasActiveRun: true }, reason: 'RUN_ACTIVE' },
  {
    name: 'an unknown workspace revision',
    input: { workspaceRevision: undefined },
    reason: 'REVISION_UNAVAILABLE',
  },
  {
    name: 'an empty workspace revision',
    input: { workspaceRevision: '' },
    reason: 'REVISION_UNAVAILABLE',
  },
  { name: 'an occupying agent task', input: { taskWritesLocked: true }, reason: 'TASK_ACTIVE' },
  { name: 'a workspace reload in progress', input: { reloading: true }, reason: 'RELOADING' },
];

describe('resolveAgentTaskPreconditions', () => {
  it('blocks a start with DIRTY_FILES exactly as specified', () => {
    expect(
      resolveAgentTaskPreconditions({
        dirtyCount: 1,
        writePending: false,
        hasActiveRun: false,
        workspaceRevision: '7',
        taskWritesLocked: false,
        reloading: false,
      }),
    ).toEqual({ canStart: false, reason: 'DIRTY_FILES' });
  });

  it.each(BLOCKED_CASES)('refuses to start with $name ($reason)', ({ input, reason }) => {
    expect(resolveAgentTaskPreconditions({ ...STARTABLE, ...input })).toEqual({
      canStart: false,
      reason,
    });
  });

  it('keeps DIRTY_FILES ahead of every other refusal', () => {
    expect(
      resolveAgentTaskPreconditions({
        dirtyCount: 2,
        writePending: true,
        hasActiveRun: true,
        workspaceRevision: undefined,
        taskWritesLocked: true,
        reloading: true,
      }),
    ).toEqual({ canStart: false, reason: 'DIRTY_FILES' });
  });

  it('allows a start only when the workspace is clean, settled and known', () => {
    expect(resolveAgentTaskPreconditions(STARTABLE)).toEqual({ canStart: true, reason: null });
  });
});
