/**
 * The browser-side mirror of the backend's stage-one agent task snapshot
 * (AgentContracts.TaskSnapshot). Pure data plus honest parsing: a malformed
 * payload never becomes a fabricated task state.
 */

export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';
export function isReasoningEffort(value: unknown): value is ReasoningEffort { return typeof value === 'string' && ['off', 'low', 'high', 'max'].includes(value); }
export type AgentTaskState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'NEEDS_ATTENTION';

export type AgentProgressItem = {
  seq: number;
  kind: string;
  text: string;
  truncated: boolean;
};

export type AgentTaskSnapshot = {
  taskId: string;
  conversationId?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  state: AgentTaskState;
  workspaceRevision: string;
  writesLocked: boolean;
  progress: AgentProgressItem[];
  changedPaths: string[];
  summary: string | null;
  failureCode: string | null;
  closeReasonCode?: string | null;
};

export type SubmitAgentTaskRequest = {
  attachmentIds?: string[];
  taskId: string;
  prompt: string;
  expectedWorkspaceRevision: string;
  reasoningEffort?: ReasoningEffort;
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
    record.conversationId != null && typeof record.conversationId !== 'string' ||
    record.reasoningEffort != null && !isReasoningEffort(record.reasoningEffort) ||
    record.closeReasonCode != null && typeof record.closeReasonCode !== 'string' ||
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
    reasoningEffort: record.reasoningEffort as ReasoningEffort | null | undefined ?? null,
    conversationId: record.conversationId as string | null | undefined ?? null,
    closeReasonCode: record.closeReasonCode as string | null | undefined ?? null,
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

/** Result-bearing tool completion ID; shared by browser controls and acceptance collection. */
export function buildToolCallId(progressText: string): string | null {
  const match = /^(?:build|application|app_http_get|python_dependencies) ([A-Za-z0-9_-]{1,64})$/.exec(progressText.trim());
  return match === null ? null : match[1]!;
}

/** The owner browser's view of one settled tool call (backend AgentToolCallView). */
export type AgentToolCallResult = {
  toolCallId: string;
  toolName: string;
  data: Record<string, unknown>;
};

export type PythonDependencyData = {
  kind: 'python_dependencies'; operationId: string; action: 'add' | 'remove'; packageName: string;
  group: 'main' | 'test'; state: 'COMMITTED'; changedPaths: string[];
};

export type PythonBuildData = {
  language: 'python'; checkKind: 'syntax' | 'pytest';
  verificationStatus: 'PASS' | 'FAILED' | 'NO_TESTS' | 'SKIPPED' | 'UNKNOWN' | 'NO_SOURCE';
  filesChecked: number | null; errors: { path: string | null; message: string }[];
  testSummary: { tests: number; failures: number; errors: number; skipped: number; reportComplete: boolean } | null;
  exitCode: number | null; sourceRevision: string;
};

/** Only the committed pair of managed files proves a dependency change. */
export function pythonDependencyData(result: AgentToolCallResult): PythonDependencyData | null {
  const d = result.data;
  if (result.toolName !== 'python_dependencies' || d.kind !== 'python_dependencies' || d.state !== 'COMMITTED' ||
      typeof d.operationId !== 'string' || d.operationId.length === 0 ||
      (d.action !== 'add' && d.action !== 'remove') || (d.group !== 'main' && d.group !== 'test') ||
      typeof d.packageName !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(d.packageName) ||
      !Array.isArray(d.changedPaths) || d.changedPaths.length !== 2 ||
      !d.changedPaths.includes('pyproject.toml') || !d.changedPaths.includes('uv.lock')) return null;
  return d as PythonDependencyData;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Missing evidence stays unknown; contradictory evidence never becomes a pass. */
export function pythonBuildData(result: AgentToolCallResult): PythonBuildData | null {
  const d = result.data;
  if (result.toolName !== 'build' || d.language !== 'python' ||
      (d.checkKind !== 'syntax' && d.checkKind !== 'pytest') ||
      typeof d.verificationStatus !== 'string' || !['PASS', 'FAILED', 'NO_TESTS', 'SKIPPED', 'UNKNOWN', 'NO_SOURCE'].includes(d.verificationStatus) ||
      !(d.filesChecked === null || nonnegativeInteger(d.filesChecked)) ||
      !(d.exitCode === null || typeof d.exitCode === 'number' && Number.isSafeInteger(d.exitCode)) ||
      typeof d.sourceRevision !== 'string' || d.sourceRevision.length === 0 || !Array.isArray(d.errors) ||
      !d.errors.every(value => {
        const error = asRecord(value);
        return error !== null && nullableString(error.path) && typeof error.message === 'string';
      })) return null;
  const summary = d.testSummary === null ? null : asRecord(d.testSummary);
  if (d.testSummary !== null && (summary === null ||
      ![summary.tests, summary.failures, summary.errors, summary.skipped].every(nonnegativeInteger) ||
      typeof summary.reportComplete !== 'boolean')) return null;
  const s = summary as PythonBuildData['testSummary'];
  if (s !== null && s.failures + s.errors + s.skipped > s.tests) return null;
  if (d.checkKind === 'syntax' && s !== null || d.checkKind === 'pytest' && d.filesChecked !== null) return null;
  if (d.verificationStatus === 'PASS') {
    if (d.exitCode !== 0 || d.errors.length !== 0 ||
        (d.checkKind === 'syntax' ? !nonnegativeInteger(d.filesChecked) || d.filesChecked === 0
          : s === null || !s.reportComplete || s.tests <= s.skipped || s.failures !== 0 || s.errors !== 0)) return null;
  }
  if (d.verificationStatus === 'SKIPPED' &&
      (d.checkKind !== 'pytest' || d.exitCode !== 0 || s === null || !s.reportComplete || s.tests === 0 || s.skipped !== s.tests)) return null;
  if (d.verificationStatus === 'NO_TESTS' && (d.checkKind !== 'pytest' || s !== null && s.tests !== 0)) return null;
  if (d.verificationStatus === 'NO_SOURCE' && (d.checkKind !== 'syntax' || d.filesChecked !== 0 || d.errors.length !== 0)) return null;
  return d as PythonBuildData;
}

export type ApplicationRunView = {
  id: string; state: string; requestedWorkspaceRevision: string;
  firstReadyAt: string | null; expiresAt: string | null; finishedAt: string | null;
  exitCode: number | null; terminationReason: string | null;
};

export type ApplicationData = {
  kind: 'application'; action: 'start' | 'stop' | 'status' | 'logs';
  run: ApplicationRunView | null; activeRunId: string | null; stoppedConfirmed: boolean;
  logs: { text: string; firstSeq: number | null; lastSeq: number | null; truncated: boolean; complete: boolean } | null;
};

export type AppHttpGetData = {
  kind: 'app_http_get'; runId: string; path: string; statusCode: number | null;
  contentType: string | null; body: string; truncated: boolean;
  error: { code: string; message: string } | null;
};

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export function applicationData(result: AgentToolCallResult): ApplicationData | null {
  const d = result.data;
  if (result.toolName !== 'application' || d.kind !== 'application' ||
      !['start', 'stop', 'status', 'logs'].includes(String(d.action)) ||
      !nullableString(d.activeRunId) || typeof d.stoppedConfirmed !== 'boolean') return null;
  if (d.run !== null) {
    const run = asRecord(d.run);
    if (!run || typeof run.id !== 'string' || typeof run.state !== 'string' || typeof run.requestedWorkspaceRevision !== 'string' ||
        !nullableString(run.firstReadyAt) || !nullableString(run.expiresAt) || !nullableString(run.finishedAt) ||
        !nullableNumber(run.exitCode) || !nullableString(run.terminationReason)) return null;
  }
  if (d.logs !== null) {
    const logs = asRecord(d.logs);
    if (!logs || typeof logs.text !== 'string' || !nullableNumber(logs.firstSeq) || !nullableNumber(logs.lastSeq) ||
        typeof logs.truncated !== 'boolean' || typeof logs.complete !== 'boolean') return null;
  }
  return d as unknown as ApplicationData;
}

export function appHttpGetData(result: AgentToolCallResult): AppHttpGetData | null {
  const d = result.data;
  if (result.toolName !== 'app_http_get' || d.kind !== 'app_http_get' || typeof d.runId !== 'string' || typeof d.path !== 'string' ||
      !nullableNumber(d.statusCode) || !nullableString(d.contentType) || typeof d.body !== 'string' || typeof d.truncated !== 'boolean') return null;
  if (d.error !== null) {
    const error = asRecord(d.error);
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  }
  return d as unknown as AppHttpGetData;
}

/** A rejected application call has no Run snapshot and is returned as an error only. */
export function applicationError(result: AgentToolCallResult): { code: string; message: string } | null {
  if (result.toolName !== 'application') return null;
  const error = asRecord(result.data.error);
  return error !== null && typeof error.code === 'string' && typeof error.message === 'string'
    ? { code: error.code, message: error.message } : null;
}

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
