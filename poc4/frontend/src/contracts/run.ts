import { parseWorkspaceRevision, type WorkspaceRevision } from './file';
import type { RuntimeTemplateId } from './project';

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
  | 'STARTUP_TIME_LIMIT_EXCEEDED'
  | 'APPLICATION_EXITED'
  | 'START_FAILED'
  | 'RECOVERY_FAILED';

export type RunResources = {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralStorageBytes: number;
};

export type RunExecutionKind = 'TASK' | 'SERVICE';

/** The fixed display commands of the internal template enum; snapshots carry one of them. */
export const JAVA_CONSOLE_COMMAND = 'mvn -q -DskipTests compile exec:java';
export const JAVA_SPRING_BOOT_COMMAND = 'mvn -q -DskipTests spring-boot:run';
export const PYTHON_CONSOLE_COMMAND = 'python -u main.py';
export const PYTHON_FASTAPI_COMMAND = 'python -u -m uvicorn app.main:app';

export type RunCommand =
  | typeof JAVA_CONSOLE_COMMAND
  | typeof JAVA_SPRING_BOOT_COMMAND
  | typeof PYTHON_CONSOLE_COMMAND
  | typeof PYTHON_FASTAPI_COMMAND;

/** The pinned toolchain of this stage; the launcher images and backend agree on it. */
export const PYTHON_RUN_VERSION = '3.13';
export const PYTHON_RUN_PACKAGE_MANAGER = 'uv';

/** Historical Java runtime node; rows written before the template contract carry no language. */
export type LegacyJavaRunRuntime = { javaMajor: 17; mavenMajor: 3 };

/** New-format runtime nodes carry the language discriminator and never mix languages. */
export type JavaRunRuntime = { language: 'java'; javaMajor: 17; mavenMajor: 3 };
export type PythonRunRuntime = {
  language: 'python';
  pythonVersion: typeof PYTHON_RUN_VERSION;
  packageManager: typeof PYTHON_RUN_PACKAGE_MANAGER;
};
export type RunRuntime = JavaRunRuntime | PythonRunRuntime;
/** Runtime node of a parsed snapshot: legacy Java rows omit the language discriminator. */
export type RunPolicyRuntime = RunRuntime | LegacyJavaRunRuntime;

type RunPolicyBase = {
  command: RunCommand;
  runtime: RunPolicyRuntime;
  resources: {
    requests: RunResources;
    limits: RunResources;
  };
};

/**
 * TASK keeps the single overall timeout deadline. Payloads without execution fields are
 * legacy TASK runs; the optional numeric fields are echoed only when the server sends
 * them. New-format rows name their console template; legacy rows omit templateId.
 */
export type TaskRunPolicy = RunPolicyBase & {
  templateId?: 'java-console' | 'python-console';
  timeoutSeconds: number;
  executionKind?: 'TASK';
  startupTimeoutSeconds?: number;
  serviceLifetimeSeconds?: number;
};

/**
 * SERVICE (bounded web session) derives the Job backstop from startupTimeoutSeconds plus the
 * immutable serviceLifetimeSeconds that starts at first verified readiness. Legacy SERVICE
 * rows keep the historical console command; new-format rows name their web template.
 */
export type ServiceRunPolicy = RunPolicyBase & {
  templateId?: 'java-spring-boot-web' | 'python-fastapi-web';
  executionKind: 'SERVICE';
  timeoutSeconds: number;
  startupTimeoutSeconds: number;
  serviceLifetimeSeconds: number;
};

export type RunPolicy = TaskRunPolicy | ServiceRunPolicy;

/**
 * Toolbar display for the no-run state, derived from the project's current template.
 * A selected Run always displays its own policy instead of this preview.
 */
export type RunTemplateDisplay = {
  command: RunCommand;
  runtimeLabel: string;
  timeoutSeconds: number;
};

const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;

/** The per-template no-run display; it must never default a Python project to Maven. */
export function templateRunDisplay(templateId: RuntimeTemplateId): RunTemplateDisplay {
  switch (templateId) {
    case 'java-console':
      return {
        command: JAVA_CONSOLE_COMMAND,
        runtimeLabel: 'Java 17 · Maven 3',
        timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS,
      };
    case 'java-spring-boot-web':
      return {
        command: JAVA_SPRING_BOOT_COMMAND,
        runtimeLabel: 'Java 17 · Maven 3',
        timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS,
      };
    case 'python-console':
      return {
        command: PYTHON_CONSOLE_COMMAND,
        runtimeLabel: `Python ${PYTHON_RUN_VERSION} · ${PYTHON_RUN_PACKAGE_MANAGER}`,
        timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS,
      };
    case 'python-fastapi-web':
      return {
        command: PYTHON_FASTAPI_COMMAND,
        runtimeLabel: `Python ${PYTHON_RUN_VERSION} · ${PYTHON_RUN_PACKAGE_MANAGER}`,
        timeoutSeconds: DEFAULT_RUN_TIMEOUT_SECONDS,
      };
  }
}

/** Human-readable runtime identity of a parsed policy (toolbar version display). */
export function runRuntimeLabel(runtime: RunPolicyRuntime): string {
  if ('language' in runtime && runtime.language === 'python') {
    return `Python ${runtime.pythonVersion} · ${runtime.packageManager}`;
  }
  return `Java ${runtime.javaMajor} · Maven ${runtime.mavenMajor}`;
}

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
  /** Verified first readiness; only SERVICE runs ever record it. */
  firstReadyAt: string | null;
  /** Immutable lifetime deadline armed at firstReadyAt; never moved or renewed. */
  expiresAt: string | null;
};

export type ActiveRunResponse = { run: RunSummary | null };
export type RunListResponse = { items: RunSummary[]; nextCursor: string | null };
export type StartRunRequest = { expectedWorkspaceRevision: WorkspaceRevision };
export type LogTicketResponse = { ticket: LogTicket; expiresAt: string };

const INVALID_RUN_RESPONSE = 'Invalid run response';
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_RUN_TIMEOUT_SECONDS = 1800;
const SERVICE_LIFETIME_SECONDS = 7200;
const SERVICE_LIFETIME_MS = SERVICE_LIFETIME_SECONDS * 1000;
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
  FAILED: ['BUILD_FAILED', 'START_FAILED', 'RECOVERY_FAILED', 'APPLICATION_EXITED'],
  CANCELLED: ['USER_STOPPED'],
  TIMED_OUT: ['TIME_LIMIT_EXCEEDED', 'STARTUP_TIME_LIMIT_EXCEEDED'],
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

/** Like the nullable variant but tolerates absent legacy keys. */
function parseOptionalIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) {
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
    value !== 'STARTUP_TIME_LIMIT_EXCEEDED' &&
    value !== 'APPLICATION_EXITED' &&
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

/** Requests never exceed limits; the check is part of the snapshot contract. */
function parseRunResourcesNode(
  record: Record<string, unknown>,
): RunPolicyBase['resources'] {
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
  return { requests, limits };
}

type TemplatedPolicySpec =
  | {
      kind: 'TASK';
      templateId: 'java-console' | 'python-console';
      command: RunCommand;
      language: 'java' | 'python';
    }
  | {
      kind: 'SERVICE';
      templateId: 'java-spring-boot-web' | 'python-fastapi-web';
      command: RunCommand;
      language: 'java' | 'python';
    };

/** Mirror of the backend RuntimeTemplate enum; Record forces every id to stay covered. */
const TEMPLATED_POLICIES: Record<RuntimeTemplateId, TemplatedPolicySpec> = {
  'java-console': { kind: 'TASK', templateId: 'java-console', command: JAVA_CONSOLE_COMMAND, language: 'java' },
  'java-spring-boot-web': {
    kind: 'SERVICE',
    templateId: 'java-spring-boot-web',
    command: JAVA_SPRING_BOOT_COMMAND,
    language: 'java',
  },
  'python-console': { kind: 'TASK', templateId: 'python-console', command: PYTHON_CONSOLE_COMMAND, language: 'python' },
  'python-fastapi-web': {
    kind: 'SERVICE',
    templateId: 'python-fastapi-web',
    command: PYTHON_FASTAPI_COMMAND,
    language: 'python',
  },
};

const RUNTIME_TEMPLATE_IDS: ReadonlySet<RuntimeTemplateId> = new Set([
  'java-console',
  'java-spring-boot-web',
  'python-console',
  'python-fastapi-web',
] as const);

/** A java runtime needs both pinned fields, the java language and no python fields. */
function parseJavaRunRuntime(value: unknown): JavaRunRuntime {
  const runtime = asRecord(value);
  if (runtime.language !== 'java' || runtime.javaMajor !== 17 || runtime.mavenMajor !== 3) {
    invalidRunResponse();
  }
  if ('pythonVersion' in runtime || 'packageManager' in runtime) {
    invalidRunResponse();
  }
  return { language: 'java', javaMajor: 17, mavenMajor: 3 };
}

/** A python runtime needs both pinned fields, the python language and no java fields. */
function parsePythonRunRuntime(value: unknown): PythonRunRuntime {
  const runtime = asRecord(value);
  if (
    runtime.language !== 'python' ||
    runtime.pythonVersion !== PYTHON_RUN_VERSION ||
    runtime.packageManager !== PYTHON_RUN_PACKAGE_MANAGER
  ) {
    invalidRunResponse();
  }
  if ('javaMajor' in runtime || 'mavenMajor' in runtime) {
    invalidRunResponse();
  }
  return {
    language: 'python',
    pythonVersion: PYTHON_RUN_VERSION,
    packageManager: PYTHON_RUN_PACKAGE_MANAGER,
  };
}

function parseRunPolicy(value: unknown): RunPolicy {
  const record = asRecord(value);
  if ('image' in record || 'env' in record) {
    invalidRunResponse();
  }
  const resources = parseRunResourcesNode(record);
  // New-format rows carry templateId and are consistency-checked against it; rows
  // without templateId stay historical Java runs decided by their execution kind.
  if (record.templateId !== undefined) {
    return parseTemplatedRunPolicy(record, resources);
  }
  return parseLegacyRunPolicy(record, resources);
}

function parseLegacyRunPolicy(
  record: Record<string, unknown>,
  resources: RunPolicyBase['resources'],
): RunPolicy {
  // Template-less rows are historical Java records and nothing else: they keep the
  // historical console command display and must not carry language/python fields.
  if (record.command !== JAVA_CONSOLE_COMMAND) {
    invalidRunResponse();
  }
  const runtime = asRecord(record.runtime);
  if ('language' in runtime || 'pythonVersion' in runtime || 'packageManager' in runtime) {
    invalidRunResponse();
  }
  if (runtime.javaMajor !== 17 || runtime.mavenMajor !== 3) {
    invalidRunResponse();
  }
  // An explicit annotation keeps the runtime literal types that object-literal
  // inference would otherwise widen to string/number.
  const base: RunPolicyBase = {
    command: JAVA_CONSOLE_COMMAND,
    runtime: { javaMajor: 17, mavenMajor: 3 },
    resources,
  };
  const executionKind = record.executionKind === undefined ? 'TASK' : record.executionKind;
  if (executionKind === 'SERVICE') {
    return {
      ...base,
      executionKind: 'SERVICE',
      timeoutSeconds: parseSafeInteger(record.timeoutSeconds, 1, MAX_RUN_TIMEOUT_SECONDS),
      startupTimeoutSeconds: parseSafeInteger(
        record.startupTimeoutSeconds,
        1,
        MAX_RUN_TIMEOUT_SECONDS,
      ),
      serviceLifetimeSeconds: parseServiceLifetimeSeconds(record.serviceLifetimeSeconds),
    };
  }
  if (executionKind !== 'TASK') {
    invalidRunResponse();
  }
  const policy: TaskRunPolicy = {
    ...base,
    timeoutSeconds: parseSafeInteger(record.timeoutSeconds, 1, MAX_RUN_TIMEOUT_SECONDS),
  };
  // Echo the execution fields only when present so legacy payloads keep their exact shape.
  if (record.executionKind !== undefined) {
    policy.executionKind = 'TASK';
  }
  if (record.startupTimeoutSeconds !== undefined) {
    policy.startupTimeoutSeconds = parseSafeInteger(
      record.startupTimeoutSeconds,
      0,
      MAX_RUN_TIMEOUT_SECONDS,
    );
  }
  if (record.serviceLifetimeSeconds !== undefined) {
    policy.serviceLifetimeSeconds = parseSafeInteger(record.serviceLifetimeSeconds, 0, 0);
  }
  return policy;
}

/**
 * New-format rows agree with their template on language, execution kind and display
 * command; unknown or conflicting data is rejected instead of falling back to Java.
 */
function parseTemplatedRunPolicy(
  record: Record<string, unknown>,
  resources: RunPolicyBase['resources'],
): RunPolicy {
  const templateId = record.templateId;
  if (typeof templateId !== 'string' || !RUNTIME_TEMPLATE_IDS.has(templateId as RuntimeTemplateId)) {
    invalidRunResponse();
  }
  const spec = TEMPLATED_POLICIES[templateId as RuntimeTemplateId];
  if (record.command !== spec.command) {
    invalidRunResponse();
  }
  const runtime =
    spec.language === 'java' ? parseJavaRunRuntime(record.runtime) : parsePythonRunRuntime(record.runtime);
  // The template fixes the execution kind; a present-but-different kind is a conflict.
  if (record.executionKind !== undefined && record.executionKind !== spec.kind) {
    invalidRunResponse();
  }
  if (spec.kind === 'SERVICE') {
    return {
      templateId: spec.templateId,
      command: spec.command,
      runtime,
      resources,
      executionKind: 'SERVICE',
      timeoutSeconds: parseSafeInteger(record.timeoutSeconds, 1, MAX_RUN_TIMEOUT_SECONDS),
      startupTimeoutSeconds: parseSafeInteger(
        record.startupTimeoutSeconds,
        1,
        MAX_RUN_TIMEOUT_SECONDS,
      ),
      serviceLifetimeSeconds: parseServiceLifetimeSeconds(record.serviceLifetimeSeconds),
    };
  }
  const policy: TaskRunPolicy = {
    templateId: spec.templateId,
    command: spec.command,
    runtime,
    resources,
    timeoutSeconds: parseSafeInteger(record.timeoutSeconds, 1, MAX_RUN_TIMEOUT_SECONDS),
  };
  // Echo the execution fields only when present so payloads keep their exact shape.
  if (record.executionKind !== undefined) {
    policy.executionKind = 'TASK';
  }
  if (record.startupTimeoutSeconds !== undefined) {
    policy.startupTimeoutSeconds = parseSafeInteger(
      record.startupTimeoutSeconds,
      0,
      MAX_RUN_TIMEOUT_SECONDS,
    );
  }
  if (record.serviceLifetimeSeconds !== undefined) {
    policy.serviceLifetimeSeconds = parseSafeInteger(record.serviceLifetimeSeconds, 0, 0);
  }
  return policy;
}

function parseServiceLifetimeSeconds(value: unknown): number {
  const seconds = parseSafeInteger(value, 1, SERVICE_LIFETIME_SECONDS);
  if (seconds !== SERVICE_LIFETIME_SECONDS) {
    invalidRunResponse();
  }
  return seconds;
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
  firstReadyAt: string | null;
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
    if (run.state === 'STARTING' && run.firstReadyAt !== null) {
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

/**
 * Verified readiness lifetime invariants: only SERVICE runs carry firstReadyAt/expiresAt, the
 * pair is indivisible, readiness cannot precede creation and the window is the fixed lifetime.
 */
function assertLifetimeInvariants(run: {
  policy: RunPolicy;
  createdAt: string;
  firstReadyAt: string | null;
  expiresAt: string | null;
}): void {
  if (run.policy.executionKind !== 'SERVICE') {
    if (run.firstReadyAt !== null || run.expiresAt !== null) {
      invalidRunResponse();
    }
    return;
  }
  if ((run.firstReadyAt === null) !== (run.expiresAt === null)) {
    invalidRunResponse();
  }
  if (run.firstReadyAt === null || run.expiresAt === null) {
    return;
  }
  const readyMs = Date.parse(run.firstReadyAt);
  if (readyMs < Date.parse(run.createdAt)) {
    invalidRunResponse();
  }
  if (Date.parse(run.expiresAt) - readyMs !== SERVICE_LIFETIME_MS) {
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
    firstReadyAt: parseOptionalIsoTimestamp(record.firstReadyAt),
    expiresAt: parseOptionalIsoTimestamp(record.expiresAt),
  };
  assertStateInvariants(summary);
  assertLifetimeInvariants(summary);
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

export type RunAvailability = 'STARTING' | 'READY' | 'UNAVAILABLE';

/**
 * Endpoint availability derived only from the verified readiness lifetime. TASK runs never
 * record a verified firstReadyAt, so they resolve to STARTING or UNAVAILABLE; the lifetime
 * display uses this for SERVICE runs and never renews or counts down before readiness.
 */
export function resolveRunAvailability(run: RunSummary, nowMs: number): RunAvailability {
  if (run.firstReadyAt === null || run.expiresAt === null) {
    return isRunTerminalState(run.state) ? 'UNAVAILABLE' : 'STARTING';
  }
  return nowMs < Date.parse(run.expiresAt) ? 'READY' : 'UNAVAILABLE';
}
