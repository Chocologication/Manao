import { parseWorkspaceRevision, type WorkspaceRevision } from './file';

declare const runIdBrand: unique symbol;
declare const logTicketBrand: unique symbol;

export type RunId = string & { readonly [runIdBrand]: true };
export type LogTicket = string & { readonly [logTicketBrand]: true };

export type RunState =
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'RECOVERING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export type RunTerminationReason =
  | 'BUILD_SUCCEEDED'
  | 'BUILD_FAILED'
  | 'USER_STOPPED'
  | 'TIME_LIMIT_EXCEEDED'
  | 'START_FAILED'
  | 'RECOVERY_FAILED';

export type RunResources = {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralStorageBytes: number;
};

export type RunPolicy = {
  command: 'mvn clean test';
  runtime: { javaMajor: 17; mavenMajor: 3 };
  timeoutSeconds: number;
  resources: {
    requests: RunResources;
    limits: RunResources;
  };
};

export type RunSummary = {
  id: RunId;
  state: RunState;
  requestedWorkspaceRevision: WorkspaceRevision;
  policy: RunPolicy;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  terminationReason: RunTerminationReason | null;
  exitCode: number | null;
  logTruncated: boolean;
  logEvictedBytes: number;
  lastLogSeq: number | null;
};

export type ActiveRunResponse = { run: RunSummary | null };
export type RunListResponse = { items: RunSummary[]; nextCursor: string | null };
export type StartRunRequest = { expectedWorkspaceRevision: WorkspaceRevision };
export type LogTicketResponse = { ticket: LogTicket; expiresAt: string };

const INVALID_RUN_RESPONSE = 'Invalid run response';
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_RUN_TIMEOUT_SECONDS = 1800;
const MAX_RUN_CPU_MILLIS = 8000;
const MAX_RUN_MEMORY_BYTES = 17_179_869_184;
const MAX_RUN_EPHEMERAL_STORAGE_BYTES = 10_737_418_240;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const LOCKING_STATES: ReadonlySet<RunState> = new Set([
  'STARTING',
  'RUNNING',
  'STOPPING',
  'RECOVERING',
]);

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

const TERMINAL_REASONS: Record<
  Extract<RunState, 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'>,
  readonly RunTerminationReason[]
> = {
  SUCCEEDED: ['BUILD_SUCCEEDED'],
  FAILED: ['BUILD_FAILED', 'START_FAILED', 'RECOVERY_FAILED'],
  CANCELLED: ['USER_STOPPED'],
  TIMED_OUT: ['TIME_LIMIT_EXCEEDED'],
};

const BROWSER_POLICY_FIELDS = ['command', 'image', 'resources', 'env'] as const;

function invalidRunResponse(): never {
  throw new Error(INVALID_RUN_RESPONSE);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidRunResponse();
  }
  return value as Record<string, unknown>;
}

function parseOpaqueId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_OPAQUE_ID_LENGTH) {
    invalidRunResponse();
  }
  return value;
}

export function parseRunId(value: unknown): RunId {
  return parseOpaqueId(value) as RunId;
}

export function parseLogTicket(value: unknown): LogTicket {
  return parseOpaqueId(value) as LogTicket;
}

export function isRunLockingState(
  state: RunState,
): state is Extract<RunState, 'STARTING' | 'RUNNING' | 'STOPPING' | 'RECOVERING'> {
  return LOCKING_STATES.has(state);
}

export function isRunTerminalState(
  state: RunState,
): state is Extract<RunState, 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'> {
  return TERMINAL_STATES.has(state);
}

function parseRevision(value: unknown): WorkspaceRevision {
  try {
    return parseWorkspaceRevision(value);
  } catch {
    invalidRunResponse();
  }
}

export function parseIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    invalidRunResponse();
  }
  if (!Number.isFinite(Date.parse(value))) {
    invalidRunResponse();
  }
  return value;
}

function parseNullableIsoTimestamp(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return parseIsoTimestamp(value);
}

function parseSafeInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalidRunResponse();
  }
  return value;
}

function parsePositiveSafeInteger(value: unknown): number {
  return parseSafeInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function parseNonNegativeSafeInteger(value: unknown): number {
  return parseSafeInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function parseRunState(value: unknown): RunState {
  if (typeof value !== 'string' || (!LOCKING_STATES.has(value as RunState) && !TERMINAL_STATES.has(value as RunState))) {
    invalidRunResponse();
  }
  return value as RunState;
}

function parseTerminationReason(value: unknown): RunTerminationReason | null {
  if (value === null) {
    return null;
  }
  if (
    value !== 'BUILD_SUCCEEDED' &&
    value !== 'BUILD_FAILED' &&
    value !== 'USER_STOPPED' &&
    value !== 'TIME_LIMIT_EXCEEDED' &&
    value !== 'START_FAILED' &&
    value !== 'RECOVERY_FAILED'
  ) {
    invalidRunResponse();
  }
  return value;
}

function parseNullableExitCode(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalidRunResponse();
  }
  return value;
}

function parseLastLogSeq(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return parsePositiveSafeInteger(value);
}

function parseRunResources(value: unknown): RunResources {
  const record = asRecord(value);
  return {
    cpuMillis: parseSafeInteger(record.cpuMillis, 1, MAX_RUN_CPU_MILLIS),
    memoryBytes: parseSafeInteger(record.memoryBytes, 1, MAX_RUN_MEMORY_BYTES),
    ephemeralStorageBytes: parseSafeInteger(
      record.ephemeralStorageBytes,
      1,
      MAX_RUN_EPHEMERAL_STORAGE_BYTES,
    ),
  };
}

function parseRunPolicy(value: unknown): RunPolicy {
  const record = asRecord(value);
  if ('image' in record || 'env' in record) {
    invalidRunResponse();
  }
  if (record.command !== 'mvn clean test') {
    invalidRunResponse();
  }
  const runtime = asRecord(record.runtime);
  if (runtime.javaMajor !== 17 || runtime.mavenMajor !== 3) {
    invalidRunResponse();
  }
  const timeoutSeconds = parseSafeInteger(record.timeoutSeconds, 1, MAX_RUN_TIMEOUT_SECONDS);
  const resources = asRecord(record.resources);
  const requests = parseRunResources(resources.requests);
  const limits = parseRunResources(resources.limits);
  if (
    requests.cpuMillis > limits.cpuMillis ||
    requests.memoryBytes > limits.memoryBytes ||
    requests.ephemeralStorageBytes > limits.ephemeralStorageBytes
  ) {
    invalidRunResponse();
  }
  return {
    command: 'mvn clean test',
    runtime: { javaMajor: 17, mavenMajor: 3 },
    timeoutSeconds,
    resources: { requests, limits },
  };
}

function rejectBrowserPolicyFields(record: Record<string, unknown>): void {
  for (const field of BROWSER_POLICY_FIELDS) {
    if (field in record) {
      invalidRunResponse();
    }
  }
}

function assertTimestampOrder(
  createdAt: string,
  startedAt: string | null,
  finishedAt: string | null,
): void {
  const createdMs = Date.parse(createdAt);
  if (startedAt !== null && createdMs > Date.parse(startedAt)) {
    invalidRunResponse();
  }
  if (finishedAt !== null) {
    const startMs = startedAt === null ? createdMs : Date.parse(startedAt);
    if (startMs > Date.parse(finishedAt)) {
      invalidRunResponse();
    }
  }
}

function assertStateInvariants(run: {
  state: RunState;
  startedAt: string | null;
  finishedAt: string | null;
  terminationReason: RunTerminationReason | null;
  exitCode: number | null;
}): void {
  if (isRunLockingState(run.state)) {
    if (run.finishedAt !== null || run.terminationReason !== null || run.exitCode !== null) {
      invalidRunResponse();
    }
    if (run.state === 'STARTING' && run.startedAt !== null) {
      invalidRunResponse();
    }
    if (run.state === 'RUNNING' && run.startedAt === null) {
      invalidRunResponse();
    }
    return;
  }
  if (!isRunTerminalState(run.state) || run.finishedAt === null || run.terminationReason === null) {
    invalidRunResponse();
  }
  const allowed = TERMINAL_REASONS[run.state];
  if (!allowed.includes(run.terminationReason)) {
    invalidRunResponse();
  }
  if (run.state === 'SUCCEEDED' && run.exitCode !== 0) {
    invalidRunResponse();
  }
}

export function parseRunSummary(value: unknown): RunSummary {
  const record = asRecord(value);
  rejectBrowserPolicyFields(record);
  const state = parseRunState(record.state);
  if (typeof record.logTruncated !== 'boolean') {
    invalidRunResponse();
  }
  const logEvictedBytes = parseNonNegativeSafeInteger(record.logEvictedBytes);
  if (!record.logTruncated && logEvictedBytes !== 0) {
    invalidRunResponse();
  }
  const createdAt = parseIsoTimestamp(record.createdAt);
  const startedAt = parseNullableIsoTimestamp(record.startedAt);
  const finishedAt = parseNullableIsoTimestamp(record.finishedAt);
  assertTimestampOrder(createdAt, startedAt, finishedAt);
  const summary = {
    id: parseRunId(record.id),
    state,
    requestedWorkspaceRevision: parseRevision(record.requestedWorkspaceRevision),
    policy: parseRunPolicy(record.policy),
    createdAt,
    startedAt,
    finishedAt,
    terminationReason: parseTerminationReason(record.terminationReason),
    exitCode: parseNullableExitCode(record.exitCode),
    logTruncated: record.logTruncated,
    logEvictedBytes,
    lastLogSeq: parseLastLogSeq(record.lastLogSeq),
  };
  assertStateInvariants(summary);
  return summary;
}

export function parseStartRunRequest(value: unknown): StartRunRequest {
  const record = asRecord(value);
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'expectedWorkspaceRevision') {
    invalidRunResponse();
  }
  return { expectedWorkspaceRevision: parseRevision(record.expectedWorkspaceRevision) };
}

export function parseStartRunResponse(value: unknown): RunSummary {
  return parseRunSummary(value);
}

export function parseActiveRunResponse(value: unknown): ActiveRunResponse {
  const record = asRecord(value);
  if (record.run === null) {
    return { run: null };
  }
  const run = parseRunSummary(record.run);
  if (!isRunLockingState(run.state)) {
    invalidRunResponse();
  }
  return { run };
}

export function parseRunListResponse(value: unknown): RunListResponse {
  const record = asRecord(value);
  if (!Array.isArray(record.items)) {
    invalidRunResponse();
  }
  const items = record.items.map(parseRunSummary);
  const seen = new Set<string>();
  let previousCreatedAt: number | null = null;
  for (const item of items) {
    if (seen.has(item.id)) {
      invalidRunResponse();
    }
    seen.add(item.id);
    const createdMs = Date.parse(item.createdAt);
    if (previousCreatedAt !== null && previousCreatedAt < createdMs) {
      invalidRunResponse();
    }
    previousCreatedAt = createdMs;
  }
  let nextCursor: string | null;
  if (record.nextCursor === null) {
    nextCursor = null;
  } else if (typeof record.nextCursor === 'string' && record.nextCursor !== '') {
    nextCursor = record.nextCursor;
  } else {
    invalidRunResponse();
  }
  return { items, nextCursor };
}

export function parseLogTicketResponse(value: unknown): LogTicketResponse {
  const record = asRecord(value);
  if ('url' in record || 'path' in record || 'host' in record) {
    invalidRunResponse();
  }
  const keys = Object.keys(record);
  if (keys.length !== 2 || !('ticket' in record) || !('expiresAt' in record)) {
    invalidRunResponse();
  }
  return {
    ticket: parseLogTicket(record.ticket),
    expiresAt: parseIsoTimestamp(record.expiresAt),
  };
}

export function parseRunSummaryForId(value: unknown, expectedId: RunId): RunSummary {
  const run = parseRunSummary(value);
  if (run.id !== expectedId) {
    invalidRunResponse();
  }
  return run;
}
