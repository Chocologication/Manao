import type { ApiErrorCode } from '../contracts/api';
import {
  MAX_LOG_CHUNK_UTF8_BYTES,
  MAX_LOG_RETAINED_BYTES,
  parseLogChunk,
  parseLogWindowMeta,
  type LogChunk,
  type LogWindowMeta,
} from '../contracts/log';
import {
  isRunLockingState,
  isRunTerminalState,
  parseRunId,
  parseRunSummary,
  parseStartRunRequest,
  type RunId,
  type RunState,
  type RunSummary,
  type RunTerminationReason,
  type StartRunRequest,
} from '../contracts/run';
import {
  createMockEntry,
  deleteMockEntry,
  getMockFile,
  getWorkspaceRevision,
  saveMockFile,
} from './fileFixtures';
import { createLargeLogChunks } from './largeLogPayload';
import {
  clonePoc4RunPolicy,
  GAP_DUP_TEXT,
  GAP_SKIPPED_TEXT,
  GAP_VISIBLE_TEXT,
  SEED_LOG_MARKER,
  SEED_LOG_TEXT,
  utf8ByteLength,
} from './runFixtures';

export const MOCK_RUN_START_DELAY_MS = 25;
export const MOCK_RUN_DELAYED_START_MS = 250;
export const MOCK_RUN_RECOVERY_DELAY_MS = 25;
export const MOCK_RUN_TERMINAL_DELAY_MS = 50;
export const MOCK_RUN_STOP_DELAY_MS = 25;
export const MOCK_RUN_HEARTBEAT_INTERVAL_MS = 10_000;
export const MOCK_LARGE_LOG_BROWSER_CHUNK_DELAY_MS = 120;
export const MOCK_LARGE_LOG_VIRTUAL_CHUNK_DELAY_MS = 60_000;
export const MOCK_GAP_LIVE_DELAY_MS = 800;
export const MOCK_RUN_PERSISTENCE_KEY = 'ensoai.mock.run-scenario.v1';
export const MOCK_RUN_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunScenario =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'recovery'
  | 'delayed-start'
  | 'gap'
  | 'disconnect'
  | 'large-log'
  | 'reload-change';

export type MockRunErrorCode = Extract<
  ApiErrorCode,
  | 'VALIDATION_ERROR'
  | 'WORKSPACE_REVISION_CONFLICT'
  | 'RUN_ALREADY_ACTIVE'
  | 'RUN_STATE_CONFLICT'
  | 'RUN_NOT_FOUND'
>;

export type MockRunMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MockRunErrorCode };

export type MockRunSubscriberEvent =
  | {
      type: 'log.append';
      projectId: string;
      run: RunSummary;
      chunk: LogChunk;
      window: LogWindowMeta;
    }
  | { type: 'run.state'; projectId: string; run: RunSummary }
  | { type: 'log.complete'; projectId: string; run: RunSummary; lastSeq: number | null }
  | { type: 'stream.heartbeat'; projectId: string; runId: RunId; serverTime: string };

export type MockRunPersistNotifyPhase = 'persist' | 'notify';

export type MockRunBeforeTransitionEvent = {
  projectId: string;
  runId: RunId;
  from: RunState;
  to: RunState;
};

export type MockRunTransition = {
  state: RunState;
  terminationReason?: RunTerminationReason | null;
  exitCode?: number | null;
};

const RUN_SCENARIOS: ReadonlySet<RunScenario> = new Set([
  'success',
  'failure',
  'timeout',
  'recovery',
  'delayed-start',
  'gap',
  'disconnect',
  'large-log',
  'reload-change',
]);

const ALLOWED_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  STARTING: new Set(['RUNNING', 'STOPPING', 'RECOVERING', 'FAILED']),
  RUNNING: new Set(['STOPPING', 'RECOVERING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT']),
  STOPPING: new Set(['CANCELLED', 'FAILED', 'RECOVERING']),
  RECOVERING: new Set([
    'STARTING',
    'RUNNING',
    'STOPPING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
  ]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
};

type RunClock = {
  kind: 'browser' | 'virtual';
  now(): number;
  schedule(delayMs: number, fn: () => void): number;
  cancel(handle: number): void;
  cancelAll(): void;
  advance(ms: number): void;
};

type MockRunRecord = {
  seq: number;
  projectId: string;
  summary: RunSummary;
  chunks: LogChunk[];
  truncated: boolean;
  evictedBytes: number;
  lastAssignedSeq: number;
  timerHandles: number[];
};

type PersistedActive = {
  projectId: string;
  summary: RunSummary;
  seedChunks: LogChunk[];
};

type PersistedMockRunV1 = {
  version: 1;
  scenario: RunScenario;
  nextRunSeq: number;
  actives: PersistedActive[];
};

function fail(code: MockRunErrorCode): { ok: false; code: MockRunErrorCode } {
  return { ok: false, code };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function createBrowserClock(): RunClock {
  let nextHandle = 1;
  const nativeByHandle = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    kind: 'browser',
    now: () => Date.now(),
    schedule(delayMs, fn) {
      const handle = nextHandle;
      nextHandle += 1;
      const native = globalThis.setTimeout(() => {
        nativeByHandle.delete(handle);
        fn();
      }, delayMs);
      nativeByHandle.set(handle, native);
      return handle;
    },
    cancel(handle) {
      const native = nativeByHandle.get(handle);
      if (native === undefined) {
        return;
      }
      nativeByHandle.delete(handle);
      globalThis.clearTimeout(native);
    },
    cancelAll() {
      for (const native of nativeByHandle.values()) {
        globalThis.clearTimeout(native);
      }
      nativeByHandle.clear();
    },
    advance() {
      throw new Error('Browser mock run clock cannot advance');
    },
  };
}

function createVirtualClock(epochMs: number): RunClock {
  let nowMs = epochMs;
  let nextId = 1;
  const timers: Array<{ id: number; fireAt: number; fn: () => void }> = [];
  return {
    kind: 'virtual',
    now: () => nowMs,
    schedule(delayMs, fn) {
      const id = nextId;
      nextId += 1;
      timers.push({ id, fireAt: nowMs + delayMs, fn });
      return id;
    },
    cancel(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    },
    cancelAll() {
      timers.length = 0;
    },
    advance(ms) {
      const target = nowMs + ms;
      while (true) {
        let nextIndex = -1;
        let nextFire = Number.POSITIVE_INFINITY;
        for (let index = 0; index < timers.length; index += 1) {
          const timer = timers[index];
          if (timer !== undefined && timer.fireAt <= target && timer.fireAt < nextFire) {
            nextIndex = index;
            nextFire = timer.fireAt;
          }
        }
        if (nextIndex < 0) {
          nowMs = target;
          return;
        }
        const timer = timers[nextIndex];
        if (timer === undefined) {
          nowMs = target;
          return;
        }
        timers.splice(nextIndex, 1);
        nowMs = timer.fireAt;
        timer.fn();
      }
    },
  };
}

let clock: RunClock = createBrowserClock();
let runScenario: RunScenario = 'success';
let nextRunSeq = 0;
let records = new Map<string, MockRunRecord>();
let activeRunIdByProject = new Map<string, string>();
const subscribers = new Set<(event: MockRunSubscriberEvent) => void>();
const beforeTransitionSubscribers = new Set<
  (event: MockRunBeforeTransitionEvent) => void
>();
const transitionsInProgress = new Set<string>();
let beforeTransitionFinalizer: ((event: MockRunBeforeTransitionEvent) => void) | null = null;
let persistNotifyObserver:
  | ((phase: MockRunPersistNotifyPhase, event: MockRunSubscriberEvent) => void)
  | null = null;

function recordKey(projectId: string, runId: string): string {
  return `${projectId}\0${runId}`;
}

function isoNow(): string {
  return new Date(clock.now()).toISOString();
}

function cloneSummary(summary: RunSummary): RunSummary {
  return parseRunSummary(structuredClone(summary));
}

function cloneWindow(window: LogWindowMeta, options: { chunks?: LogChunk[]; appendChunk?: LogChunk } = {}): LogWindowMeta {
  return parseLogWindowMeta(structuredClone(window), options);
}

function deriveWindow(record: Pick<MockRunRecord, 'chunks' | 'truncated' | 'evictedBytes'>): LogWindowMeta {
  const first = record.chunks[0];
  const last = record.chunks[record.chunks.length - 1];
  if (first === undefined || last === undefined) {
    return {
      firstAvailableSeq: null,
      lastAvailableSeq: null,
      retainedBytes: 0,
      truncated: record.truncated,
      evictedBytes: record.evictedBytes,
    };
  }
  return {
    firstAvailableSeq: first.seq,
    lastAvailableSeq: last.seq,
    retainedBytes: record.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    truncated: record.truncated,
    evictedBytes: record.evictedBytes,
  };
}

function findRecord(projectId: string, runId: string): MockRunRecord | null {
  return records.get(recordKey(projectId, runId)) ?? null;
}

function cancelRecordTimers(record: MockRunRecord): void {
  for (const handle of record.timerHandles) {
    clock.cancel(handle);
  }
  record.timerHandles = [];
}

function scheduleOn(record: MockRunRecord, delayMs: number, fn: () => void): void {
  const handle = clock.schedule(delayMs, fn);
  record.timerHandles.push(handle);
}

function readStorage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
}

function clearPersistence(): void {
  readStorage()?.removeItem(MOCK_RUN_PERSISTENCE_KEY);
}

function seedChunksOf(record: MockRunRecord): LogChunk[] {
  return record.chunks.filter((chunk) => chunk.text.includes(SEED_LOG_MARKER));
}

function compactActive(record: MockRunRecord): PersistedActive {
  const seedChunks = seedChunksOf(record);
  const seedWindow = deriveWindow({
    chunks: seedChunks,
    truncated: false,
    evictedBytes: 0,
  });
  return {
    projectId: record.projectId,
    summary: parseRunSummary({
      ...structuredClone(record.summary),
      logTruncated: false,
      logEvictedBytes: 0,
      lastLogSeq: seedWindow.lastAvailableSeq,
    }),
    seedChunks: seedChunks.map((chunk) => parseLogChunk(structuredClone(chunk))),
  };
}

function persistCompact(): void {
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  const actives: PersistedActive[] = [];
  for (const [projectId, runId] of activeRunIdByProject) {
    const record = findRecord(projectId, runId);
    if (record === null || !isRunLockingState(record.summary.state)) {
      continue;
    }
    actives.push(compactActive(record));
  }
  const payload: PersistedMockRunV1 = {
    version: 1,
    scenario: runScenario,
    nextRunSeq,
    actives,
  };
  storage.setItem(MOCK_RUN_PERSISTENCE_KEY, JSON.stringify(payload));
}

function emitPersisted(event: MockRunSubscriberEvent): void {
  persistCompact();
  persistNotifyObserver?.('persist', event);
  for (const listener of subscribers) {
    listener(event);
  }
  persistNotifyObserver?.('notify', event);
}

function emitVolatile(event: MockRunSubscriberEvent): void {
  for (const listener of subscribers) {
    listener(event);
  }
}

function evictOldest(record: MockRunRecord): void {
  let retained = record.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  while (retained > MAX_LOG_RETAINED_BYTES && record.chunks.length > 0) {
    const oldest = record.chunks.shift();
    if (oldest === undefined) {
      break;
    }
    retained -= oldest.byteLength;
    record.evictedBytes += oldest.byteLength;
    record.truncated = true;
  }
}

function syncSummaryLogs(record: MockRunRecord): void {
  const window = deriveWindow(record);
  record.summary = parseRunSummary({
    ...structuredClone(record.summary),
    logTruncated: window.truncated,
    logEvictedBytes: window.evictedBytes,
    lastLogSeq: window.lastAvailableSeq,
  });
}

function applyAppend(record: MockRunRecord, text: string): LogChunk {
  const chunk = parseLogChunk({
    seq: record.lastAssignedSeq + 1,
    text,
    byteLength: utf8ByteLength(text),
    persistedAt: isoNow(),
  });
  record.chunks.push(chunk);
  record.lastAssignedSeq = chunk.seq;
  evictOldest(record);
  syncSummaryLogs(record);
  return chunk;
}

function hasSeed(record: MockRunRecord): boolean {
  return record.chunks.some((chunk) => chunk.text.includes(SEED_LOG_MARKER));
}

function defaultTerminalFields(
  from: RunState,
  next: MockRunTransition,
): { terminationReason: RunTerminationReason | null; exitCode: number | null } {
  if (!isRunTerminalState(next.state)) {
    return { terminationReason: null, exitCode: null };
  }
  if (next.state === 'SUCCEEDED') {
    return {
      terminationReason: next.terminationReason ?? 'BUILD_SUCCEEDED',
      exitCode: next.exitCode ?? 0,
    };
  }
  if (next.state === 'CANCELLED') {
    return {
      terminationReason: next.terminationReason ?? 'USER_STOPPED',
      exitCode: next.exitCode ?? null,
    };
  }
  if (next.state === 'TIMED_OUT') {
    return {
      terminationReason: next.terminationReason ?? 'TIME_LIMIT_EXCEEDED',
      exitCode: next.exitCode ?? null,
    };
  }
  if (next.terminationReason !== undefined) {
    return { terminationReason: next.terminationReason, exitCode: next.exitCode ?? null };
  }
  if (from === 'STARTING') {
    return { terminationReason: 'START_FAILED', exitCode: next.exitCode ?? null };
  }
  if (from === 'RECOVERING') {
    return { terminationReason: 'RECOVERY_FAILED', exitCode: next.exitCode ?? null };
  }
  return { terminationReason: 'BUILD_FAILED', exitCode: next.exitCode ?? 1 };
}

function terminalForScenario(
  scenario: RunScenario,
): { state: RunState; terminationReason: RunTerminationReason; exitCode: number | null } | null {
  switch (scenario) {
    case 'success':
    case 'reload-change':
    case 'delayed-start':
    case 'recovery':
      return { state: 'SUCCEEDED', terminationReason: 'BUILD_SUCCEEDED', exitCode: 0 };
    case 'failure':
      return { state: 'FAILED', terminationReason: 'BUILD_FAILED', exitCode: 1 };
    case 'timeout':
      return { state: 'TIMED_OUT', terminationReason: 'TIME_LIMIT_EXCEEDED', exitCode: null };
    default:
      return null;
  }
}

function largeLogChunkDelayMs(): number {
  return clock.kind === 'virtual'
    ? MOCK_LARGE_LOG_VIRTUAL_CHUNK_DELAY_MS
    : MOCK_LARGE_LOG_BROWSER_CHUNK_DELAY_MS;
}

function scheduleLargeLogStream(record: MockRunRecord): void {
  const chunks = createLargeLogChunks();
  let index = 0;
  const pump = (): void => {
    const current = findRecord(record.projectId, record.summary.id);
    if (current === null || isRunTerminalState(current.summary.state)) {
      return;
    }
    if (index >= chunks.length) {
      applyTransition(current, { state: 'SUCCEEDED' }, { scheduleNext: false });
      return;
    }
    const text = chunks[index];
    if (text === undefined) {
      applyTransition(current, { state: 'SUCCEEDED' }, { scheduleNext: false });
      return;
    }
    index += 1;
    appendLogChunk(current.projectId, current.summary.id, text);
    const next = findRecord(record.projectId, record.summary.id);
    if (next === null || isRunTerminalState(next.summary.state)) {
      return;
    }
    scheduleOn(next, largeLogChunkDelayMs(), pump);
  };
  scheduleOn(record, largeLogChunkDelayMs(), pump);
}

function scheduleHeartbeat(record: MockRunRecord): void {
  scheduleOn(record, MOCK_RUN_HEARTBEAT_INTERVAL_MS, () => {
    const current = findRecord(record.projectId, record.summary.id);
    if (current === null || !isRunLockingState(current.summary.state)) {
      return;
    }
    emitVolatile({
      type: 'stream.heartbeat',
      projectId: current.projectId,
      runId: current.summary.id,
      serverTime: isoNow(),
    });
    scheduleHeartbeat(current);
  });
}

function scheduleScenarioFollowUp(record: MockRunRecord): void {
  if (!isRunLockingState(record.summary.state)) {
    return;
  }
  scheduleHeartbeat(record);
  if (record.summary.state === 'STARTING') {
    const delay =
      runScenario === 'delayed-start' ? MOCK_RUN_DELAYED_START_MS : MOCK_RUN_START_DELAY_MS;
    const nextState: RunState = runScenario === 'recovery' ? 'RECOVERING' : 'RUNNING';
    scheduleOn(record, delay, () => {
      const current = findRecord(record.projectId, record.summary.id);
      if (current === null) {
        return;
      }
      applyTransition(current, { state: nextState }, { scheduleNext: true });
    });
    return;
  }
  if (record.summary.state === 'RECOVERING') {
    scheduleOn(record, MOCK_RUN_RECOVERY_DELAY_MS, () => {
      const current = findRecord(record.projectId, record.summary.id);
      if (current === null) {
        return;
      }
      applyTransition(current, { state: 'RUNNING' }, { scheduleNext: true });
    });
    return;
  }
  if (record.summary.state === 'RUNNING') {
    if (runScenario === 'large-log') {
      scheduleLargeLogStream(record);
      return;
    }
    if (clock.kind === 'browser' && runScenario === 'gap') {
      scheduleOn(record, MOCK_GAP_LIVE_DELAY_MS, () => {
        const current = findRecord(record.projectId, record.summary.id);
        if (current === null || isRunTerminalState(current.summary.state)) {
          return;
        }
        appendLogChunk(current.projectId, current.summary.id, GAP_DUP_TEXT);
        appendLogChunk(current.projectId, current.summary.id, GAP_SKIPPED_TEXT);
        appendLogChunk(current.projectId, current.summary.id, GAP_VISIBLE_TEXT);
      });
      return;
    }
    const terminal = terminalForScenario(runScenario);
    if (terminal !== null) {
      scheduleOn(record, MOCK_RUN_TERMINAL_DELAY_MS, () => {
        const current = findRecord(record.projectId, record.summary.id);
        if (current === null) {
          return;
        }
        applyTransition(current, terminal, { scheduleNext: false });
      });
    }
    return;
  }
  if (record.summary.state === 'STOPPING') {
    scheduleOn(record, MOCK_RUN_STOP_DELAY_MS, () => {
      const current = findRecord(record.projectId, record.summary.id);
      if (current === null) {
        return;
      }
      applyTransition(current, { state: 'CANCELLED' }, { scheduleNext: false });
    });
  }
}

function applySimulatedJobWorkspaceSideEffects(projectId: string): void {
  // Simulated Job side effect, not Kubernetes.
  const readme = getMockFile(projectId, 'README.md');
  if (readme?.textContent != null) {
    saveMockFile(projectId, 'README.md', `${readme.textContent}\nensoai-stage4-reload-change\n`);
  }
  if (getMockFile(projectId, 'docs/run-output.md') === null) {
    createMockEntry(projectId, 'file', 'docs/run-output.md');
  }
  if (getMockFile(projectId, 'src/test/java/demo/AppTest.java') !== null) {
    deleteMockEntry(projectId, 'src/test/java/demo/AppTest.java');
  }
}

function applyTransition(
  record: MockRunRecord,
  next: MockRunTransition,
  options: { scheduleNext: boolean },
): MockRunMutationResult<{ run: RunSummary }> {
  const key = recordKey(record.projectId, record.summary.id);
  if (transitionsInProgress.has(key)) {
    return fail('RUN_STATE_CONFLICT');
  }
  transitionsInProgress.add(key);
  try {
    return applyTransitionOnce(record, next, options);
  } finally {
    transitionsInProgress.delete(key);
  }
}

function applyTransitionOnce(
  record: MockRunRecord,
  next: MockRunTransition,
  options: { scheduleNext: boolean },
): MockRunMutationResult<{ run: RunSummary }> {
  const from = record.summary.state;
  if (!ALLOWED_TRANSITIONS[from].has(next.state)) {
    return fail('RUN_STATE_CONFLICT');
  }
  const terminal = defaultTerminalFields(from, next);
  let startedAt = record.summary.startedAt;
  if (next.state === 'RUNNING' && startedAt === null) {
    startedAt = isoNow();
  }
  let finishedAt = record.summary.finishedAt;
  if (isRunTerminalState(next.state) && finishedAt === null) {
    finishedAt = isoNow();
  }
  let summary: RunSummary;
  try {
    summary = parseRunSummary({
      ...structuredClone(record.summary),
      state: next.state,
      startedAt,
      finishedAt: isRunTerminalState(next.state) ? finishedAt : null,
      terminationReason: isRunTerminalState(next.state) ? terminal.terminationReason : null,
      exitCode: isRunTerminalState(next.state) ? terminal.exitCode : null,
    });
  } catch {
    return fail('RUN_STATE_CONFLICT');
  }
  if (from === 'RUNNING' && summary.state !== 'RUNNING') {
    const event: MockRunBeforeTransitionEvent = {
      projectId: record.projectId,
      runId: record.summary.id,
      from,
      to: summary.state,
    };
    try {
      beforeTransitionFinalizer?.(event);
    } catch {
      return fail('RUN_STATE_CONFLICT');
    }
    for (const listener of beforeTransitionSubscribers) {
      try {
        listener(event);
      } catch {
        // External observers cannot veto or corrupt the authoritative transition.
      }
    }
    if (
      findRecord(record.projectId, record.summary.id) !== record ||
      record.summary.state !== from
    ) {
      return fail('RUN_STATE_CONFLICT');
    }
  }
  if (isRunTerminalState(summary.state) && getRunScenario() === 'reload-change') {
    applySimulatedJobWorkspaceSideEffects(record.projectId);
  }
  cancelRecordTimers(record);
  record.summary = summary;
  if (isRunTerminalState(summary.state)) {
    activeRunIdByProject.delete(record.projectId);
  } else {
    activeRunIdByProject.set(record.projectId, summary.id);
  }
  let seedChunk: LogChunk | null = null;
  if (summary.state === 'RUNNING' && !hasSeed(record)) {
    seedChunk = applyAppend(record, SEED_LOG_TEXT);
  }
  emitPersisted({
    type: 'run.state',
    projectId: record.projectId,
    run: cloneSummary(record.summary),
  });
  if (seedChunk !== null) {
    const window = cloneWindow(deriveWindow(record), { appendChunk: seedChunk });
    emitPersisted({
      type: 'log.append',
      projectId: record.projectId,
      run: cloneSummary(record.summary),
      chunk: seedChunk,
      window,
    });
  }
  if (isRunTerminalState(record.summary.state)) {
    emitVolatile({
      type: 'log.complete',
      projectId: record.projectId,
      run: cloneSummary(record.summary),
      lastSeq: record.summary.lastLogSeq,
    });
  }
  if (options.scheduleNext) {
    scheduleScenarioFollowUp(record);
  } else if (isRunLockingState(record.summary.state)) {
    scheduleHeartbeat(record);
  }
  return ok({ run: cloneSummary(record.summary) });
}

function clearRunMemory(): void {
  for (const record of records.values()) {
    cancelRecordTimers(record);
  }
  records = new Map();
  activeRunIdByProject = new Map();
  nextRunSeq = 0;
  runScenario = 'success';
}

function restoreDefaultClock(): void {
  clock.cancelAll();
  clock = createBrowserClock();
}

function compareRuns(left: MockRunRecord, right: MockRunRecord): number {
  const created = Date.parse(right.summary.createdAt) - Date.parse(left.summary.createdAt);
  if (created !== 0) {
    return created;
  }
  return right.seq - left.seq;
}

function encodeHistoryCursor(createdAt: string, id: string): string {
  return `v1.${btoa(`${createdAt}|${id}`)}`;
}

function decodeHistoryCursor(cursor: string): { createdAt: string; id: string } | null {
  if (!cursor.startsWith('v1.')) {
    return null;
  }
  try {
    const raw = atob(cursor.slice(3));
    const separator = raw.indexOf('|');
    if (separator <= 0) {
      return null;
    }
    return { createdAt: raw.slice(0, separator), id: raw.slice(separator + 1) };
  } catch {
    return null;
  }
}

function asPersistedPayload(value: unknown): PersistedMockRunV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isRunScenario(record.scenario) || typeof record.nextRunSeq !== 'number') {
    return null;
  }
  if (!Array.isArray(record.actives)) {
    return null;
  }
  const actives: PersistedActive[] = [];
  for (const item of record.actives) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const active = item as Record<string, unknown>;
    if (typeof active.projectId !== 'string' || active.projectId === '') {
      return null;
    }
    if (!Array.isArray(active.seedChunks)) {
      return null;
    }
    try {
      const summary = parseRunSummary(active.summary);
      if (!isRunLockingState(summary.state)) {
        return null;
      }
      const seedChunks = active.seedChunks.map((chunk) => parseLogChunk(chunk));
      actives.push({ projectId: active.projectId, summary, seedChunks });
    } catch {
      return null;
    }
  }
  return {
    version: 1,
    scenario: record.scenario,
    nextRunSeq: record.nextRunSeq,
    actives,
  };
}

function restoreActive(active: PersistedActive): void {
  const last = active.seedChunks[active.seedChunks.length - 1];
  const record: MockRunRecord = {
    seq: nextRunSeq + 1,
    projectId: active.projectId,
    summary: cloneSummary(active.summary),
    chunks: active.seedChunks.map((chunk) => parseLogChunk(structuredClone(chunk))),
    truncated: false,
    evictedBytes: 0,
    lastAssignedSeq: last?.seq ?? 0,
    timerHandles: [],
  };
  syncSummaryLogs(record);
  records.set(recordKey(active.projectId, record.summary.id), record);
  activeRunIdByProject.set(active.projectId, record.summary.id);
}

export function isRunScenario(value: unknown): value is RunScenario {
  return typeof value === 'string' && RUN_SCENARIOS.has(value as RunScenario);
}

export function setRunScenario(scenario: RunScenario): void {
  runScenario = scenario;
  persistCompact();
}

export function getRunScenario(): RunScenario {
  return runScenario;
}

export function installVirtualRunClock(epochMs: number): void {
  clock.cancelAll();
  clock = createVirtualClock(epochMs);
}

export function advanceMockRunClock(ms: number): void {
  clock.advance(ms);
}

export function getMockRunNowMs(): number {
  return clock.now();
}

export function isMockRunTransitionInProgress(projectId: string, runId: string): boolean {
  return transitionsInProgress.has(recordKey(projectId, runId));
}

export function subscribeMockRunEvents(listener: (event: MockRunSubscriberEvent) => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function subscribeMockRunBeforeTransition(
  listener: (event: MockRunBeforeTransitionEvent) => void,
): () => void {
  beforeTransitionSubscribers.add(listener);
  return () => {
    beforeTransitionSubscribers.delete(listener);
  };
}

export function registerMockRunBeforeTransitionFinalizer(
  finalizer: (event: MockRunBeforeTransitionEvent) => void,
): void {
  beforeTransitionFinalizer = finalizer;
}

export function setMockRunPersistNotifyObserver(
  observer: ((phase: MockRunPersistNotifyPhase, event: MockRunSubscriberEvent) => void) | null,
): void {
  persistNotifyObserver = observer;
}

export function hasActiveRun(projectId: string): boolean {
  return getActiveRun(projectId) !== null;
}

export function getActiveRun(projectId: string): RunSummary | null {
  const runId = activeRunIdByProject.get(projectId);
  if (runId === undefined) {
    return null;
  }
  const record = findRecord(projectId, runId);
  if (record === null || !isRunLockingState(record.summary.state)) {
    return null;
  }
  return cloneSummary(record.summary);
}

export function getRun(projectId: string, runId: string): RunSummary | null {
  const record = findRecord(projectId, runId);
  return record === null ? null : cloneSummary(record.summary);
}

export function getLogWindow(
  projectId: string,
  runId: string,
): { chunks: LogChunk[]; window: LogWindowMeta } | null {
  const record = findRecord(projectId, runId);
  if (record === null) {
    return null;
  }
  const chunks = record.chunks.map((chunk) => parseLogChunk(structuredClone(chunk)));
  return { chunks, window: cloneWindow(deriveWindow(record), { chunks }) };
}

export function listRuns(
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {},
): { items: RunSummary[]; nextCursor: string | null } {
  const limit = typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : 20;
  // Stage 4 mock retention only; real scheduled deletion is unverified until Stage 6.
  const cutoffMs = getMockRunNowMs() - MOCK_RUN_HISTORY_RETENTION_MS;
  const sorted = [...records.values()]
    .filter((record) => record.projectId === projectId)
    .filter((record) => {
      const createdMs = Date.parse(record.summary.createdAt);
      return Number.isFinite(createdMs) && createdMs >= cutoffMs;
    })
    .sort(compareRuns);
  let start = 0;
  if (typeof options.cursor === 'string' && options.cursor !== '') {
    const decoded = decodeHistoryCursor(options.cursor);
    if (decoded === null) {
      return { items: [], nextCursor: null };
    }
    const index = sorted.findIndex(
      (record) => record.summary.id === decoded.id && record.summary.createdAt === decoded.createdAt,
    );
    start = index < 0 ? sorted.length : index + 1;
  }
  const page = sorted.slice(start, start + limit);
  const items = page.map((record) => cloneSummary(record.summary));
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < sorted.length && last !== undefined
      ? encodeHistoryCursor(last.summary.createdAt, last.summary.id)
      : null;
  return { items, nextCursor };
}

export function startRun(
  projectId: string,
  body: unknown,
): MockRunMutationResult<{ run: RunSummary }> {
  let request: StartRunRequest;
  try {
    request = parseStartRunRequest(body);
  } catch {
    return fail('VALIDATION_ERROR');
  }
  if (request.expectedWorkspaceRevision !== getWorkspaceRevision(projectId)) {
    return fail('WORKSPACE_REVISION_CONFLICT');
  }
  if (hasActiveRun(projectId)) {
    return fail('RUN_ALREADY_ACTIVE');
  }
  nextRunSeq += 1;
  const summary = parseRunSummary({
    id: `run-${String(nextRunSeq).padStart(6, '0')}`,
    state: 'STARTING',
    requestedWorkspaceRevision: request.expectedWorkspaceRevision,
    policy: clonePoc4RunPolicy(),
    createdAt: isoNow(),
    startedAt: null,
    finishedAt: null,
    terminationReason: null,
    exitCode: null,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: null,
  });
  const record: MockRunRecord = {
    seq: nextRunSeq,
    projectId,
    summary,
    chunks: [],
    truncated: false,
    evictedBytes: 0,
    lastAssignedSeq: 0,
    timerHandles: [],
  };
  records.set(recordKey(projectId, summary.id), record);
  activeRunIdByProject.set(projectId, summary.id);
  emitPersisted({ type: 'run.state', projectId, run: cloneSummary(summary) });
  scheduleScenarioFollowUp(record);
  return ok({ run: cloneSummary(record.summary) });
}

export function stopRun(projectId: string, runId: string): MockRunMutationResult<{ run: RunSummary }> {
  let parsedId: RunId;
  try {
    parsedId = parseRunId(runId);
  } catch {
    return fail('RUN_NOT_FOUND');
  }
  const record = findRecord(projectId, parsedId);
  if (record === null) {
    return fail('RUN_NOT_FOUND');
  }
  if (isRunTerminalState(record.summary.state) || record.summary.state === 'STOPPING') {
    return ok({ run: cloneSummary(record.summary) });
  }
  return applyTransition(record, { state: 'STOPPING' }, { scheduleNext: true });
}

export function transitionRun(
  projectId: string,
  runId: string,
  next: MockRunTransition,
): MockRunMutationResult<{ run: RunSummary }> {
  const record = findRecord(projectId, runId);
  if (record === null) {
    return fail('RUN_NOT_FOUND');
  }
  return applyTransition(record, next, { scheduleNext: false });
}

export function appendLogChunk(
  projectId: string,
  runId: string,
  text: string,
): MockRunMutationResult<{ chunk: LogChunk; window: LogWindowMeta; run: RunSummary }> {
  const record = findRecord(projectId, runId);
  if (record === null) {
    return fail('RUN_NOT_FOUND');
  }
  if (isRunTerminalState(record.summary.state)) {
    return fail('RUN_STATE_CONFLICT');
  }
  if (typeof text !== 'string' || utf8ByteLength(text) > MAX_LOG_CHUNK_UTF8_BYTES) {
    return fail('VALIDATION_ERROR');
  }
  const chunk = applyAppend(record, text);
  const window = cloneWindow(deriveWindow(record), { appendChunk: chunk });
  emitPersisted({
    type: 'log.append',
    projectId,
    run: cloneSummary(record.summary),
    chunk,
    window,
  });
  return ok({ chunk, window, run: cloneSummary(record.summary) });
}

export function scheduleMockLogAppend(
  projectId: string,
  runId: string,
  delayMs: number,
  text: string,
): MockRunMutationResult<Record<string, never>> {
  const record = findRecord(projectId, runId);
  if (record === null) {
    return fail('RUN_NOT_FOUND');
  }
  if (isRunTerminalState(record.summary.state)) {
    return fail('RUN_STATE_CONFLICT');
  }
  scheduleOn(record, delayMs, () => {
    const current = findRecord(projectId, runId);
    if (current === null || isRunTerminalState(current.summary.state)) {
      return;
    }
    appendLogChunk(projectId, runId, text);
  });
  return ok({});
}

export function resetRunState(): void {
  subscribers.clear();
  beforeTransitionSubscribers.clear();
  persistNotifyObserver = null;
  clearRunMemory();
  restoreDefaultClock();
  clearPersistence();
}

export function rehydrateMockRunState(): void {
  const storage = readStorage();
  const raw = storage?.getItem(MOCK_RUN_PERSISTENCE_KEY);
  if (raw === undefined || raw === null || raw === '') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const payload = asPersistedPayload(parsed);
  if (payload === null) {
    return;
  }
  clearRunMemory();
  runScenario = payload.scenario;
  nextRunSeq = payload.nextRunSeq;
  for (const active of payload.actives) {
    restoreActive(active);
  }
}

export function bootRunState(): void {
  subscribers.clear();
  beforeTransitionSubscribers.clear();
  persistNotifyObserver = null;
  clearRunMemory();
  restoreDefaultClock();
  rehydrateMockRunState();
  for (const record of records.values()) {
    if (isRunLockingState(record.summary.state)) {
      scheduleHeartbeat(record);
    }
  }
}
