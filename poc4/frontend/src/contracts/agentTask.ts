/**
 * The browser-side mirror of the backend's stage-one agent task snapshot
 * (AgentContracts.TaskSnapshot). Pure data plus honest parsing: a malformed
 * payload never becomes a fabricated task state.
 */

export type AgentTaskState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'NEEDS_ATTENTION';

export type AgentProgressItem = {
  seq: number;
  kind: string;
  text: string;
  truncated: boolean;
};

export type AgentTaskSnapshot = {
  taskId: string;
  state: AgentTaskState;
  workspaceRevision: string;
  writesLocked: boolean;
  progress: AgentProgressItem[];
  changedPaths: string[];
  summary: string | null;
  failureCode: string | null;
};

export type SubmitAgentTaskRequest = {
  taskId: string;
  prompt: string;
  expectedWorkspaceRevision: string;
};

const AGENT_TASK_STATES: ReadonlySet<string> = new Set([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'NEEDS_ATTENTION',
]);

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  return payload as Record<string, unknown>;
}

function parseProgressItems(payload: unknown): AgentProgressItem[] {
  if (!Array.isArray(payload)) {
    throw new Error('Malformed agent task snapshot: progress must be an array');
  }
  return payload.map((entry, index) => {
    const record = asRecord(entry);
    if (
      record === null ||
      typeof record.seq !== 'number' ||
      typeof record.kind !== 'string' ||
      typeof record.text !== 'string' ||
      typeof record.truncated !== 'boolean'
    ) {
      throw new Error(`Malformed agent task snapshot: progress item ${index}`);
    }
    return { seq: record.seq, kind: record.kind, text: record.text, truncated: record.truncated };
  });
}

export function parseAgentTaskSnapshot(payload: unknown): AgentTaskSnapshot {
  const record = asRecord(payload);
  if (
    record === null ||
    typeof record.taskId !== 'string' ||
    typeof record.state !== 'string' ||
    !AGENT_TASK_STATES.has(record.state) ||
    typeof record.workspaceRevision !== 'string' ||
    typeof record.writesLocked !== 'boolean' ||
    typeof record.summary !== 'string' && record.summary !== null ||
    typeof record.failureCode !== 'string' && record.failureCode !== null
  ) {
    throw new Error('Malformed agent task snapshot');
  }
  return {
    taskId: record.taskId,
    state: record.state as AgentTaskState,
    workspaceRevision: record.workspaceRevision,
    writesLocked: record.writesLocked,
    progress: parseProgressItems(record.progress),
    changedPaths: parseChangedPaths(record.changedPaths),
    summary: record.summary,
    failureCode: record.failureCode,
  };
}

function parseChangedPaths(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    throw new Error('Malformed agent task snapshot: changedPaths must be an array');
  }
  return payload.map((path, index) => {
    if (typeof path !== 'string') {
      throw new Error(`Malformed agent task snapshot: changed path ${index}`);
    }
    return path;
  });
}

/** The states in which a task owns the project's writes and old entries are refused. */
export function isAgentTaskOccupying(state: AgentTaskState): boolean {
  return state === 'QUEUED' || state === 'RUNNING' || state === 'NEEDS_ATTENTION';
}

/** The owner browser's view of one settled tool call (backend AgentToolCallView). */
export type AgentToolCallResult = {
  toolCallId: string;
  toolName: string;
  data: Record<string, unknown>;
};

/**
 * Honest parsing of the settled tool-call view: the backend answers only settled
 * calls with bounded data and no internal execution identity, and a malformed
 * payload never becomes a fabricated result.
 */
export function parseAgentToolCallResult(payload: unknown): AgentToolCallResult {
  const record = asRecord(payload);
  if (
    record === null ||
    typeof record.toolCallId !== 'string' ||
    typeof record.toolName !== 'string' ||
    record.data === null ||
    typeof record.data !== 'object' ||
    Array.isArray(record.data)
  ) {
    throw new Error('Malformed agent tool call result');
  }
  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    data: record.data as Record<string, unknown>,
  };
}

/** The real exit code of a settled build result, or null when it is honestly unknown. */
export function buildExitCode(result: AgentToolCallResult): number | null {
  const exitCode = result.data['exitCode'];
  return typeof exitCode === 'number' ? exitCode : null;
}

/** Whether the build's Job/Pod cleanup was proven, or unknown when absent. */
export function buildCleanupConfirmed(result: AgentToolCallResult): boolean | null {
  const confirmed = result.data['cleanupConfirmed'];
  return typeof confirmed === 'boolean' ? confirmed : null;
}
