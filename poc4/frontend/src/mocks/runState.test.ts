import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '../contracts/api';
import { getMockFile, getWorkspaceRevision } from './fileFixtures';
import {
  MAX_LOG_CHUNK_UTF8_BYTES,
  MAX_LOG_RETAINED_BYTES,
  parseLogChunk,
  parseLogWindowMeta,
  type LogWindowMeta,
} from '../contracts/log';
import {
  parseRunListResponse,
  parseRunSummary,
  type RunState,
  type RunSummary,
} from '../contracts/run';
import {
  LARGE_LOG_EVICTED_EARLY_MARKER,
  LARGE_LOG_HEAD_MARKER,
  LARGE_LOG_LATEST_MARKER,
  LARGE_LOG_MIN_GENERATED_BYTES,
  createLargeLogChunks,
} from './largeLogPayload';
import { MAX_SIZE_LOG_CHUNK_TEXT, POC4_RUN_POLICY, SEED_LOG_MARKER, SEED_LOG_TEXT } from './runFixtures';
import {
  advanceMockRunClock,
  appendLogChunk,
  bootRunState,
  getActiveRun,
  getLogWindow,
  getMockRunNowMs,
  getRun,
  getRunScenario,
  hasActiveRun,
  installVirtualRunClock,
  isRunScenario,
  listRuns,
  MOCK_LARGE_LOG_VIRTUAL_CHUNK_DELAY_MS,
  MOCK_RUN_DELAYED_START_MS,
  MOCK_RUN_HEARTBEAT_INTERVAL_MS,
  MOCK_RUN_PERSISTENCE_KEY,
  MOCK_RUN_RECOVERY_DELAY_MS,
  MOCK_RUN_START_DELAY_MS,
  MOCK_RUN_STOP_DELAY_MS,
  MOCK_RUN_TERMINAL_DELAY_MS,
  rehydrateMockRunState,
  resetRunState,
  scheduleMockLogAppend,
  setMockRunPersistNotifyObserver,
  setRunScenario,
  startRun,
  stopRun,
  subscribeMockRunEvents,
  subscribeMockRunBeforeTransition,
  transitionRun,
  type MockRunMutationResult,
} from './runState';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID, resetMockState } from './state';

const EPOCH_MS = Date.parse('2026-08-24T10:00:00.000Z');
const ALICE = ALICE_SEED_PROJECT_ID;
const BOB = BOB_SEED_PROJECT_ID;

function revisionOf(projectId: string): string {
  return getWorkspaceRevision(projectId);
}

function expectOk<T>(result: MockRunMutationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}`);
  }
  return result.value;
}

function expectFail(result: { ok: boolean; code?: ApiErrorCode }, code: ApiErrorCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected failure');
  }
  expect(result.code).toBe(code);
}

function startBody(projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { expectedWorkspaceRevision: revisionOf(projectId), ...extra };
}

function startOk(projectId = ALICE): RunSummary {
  return expectOk(startRun(projectId, startBody(projectId))).run;
}

function parsed(run: RunSummary): RunSummary {
  return parseRunSummary(run);
}

function snapshot(projectId: string, runId: string): {
  run: RunSummary | null;
  window: { chunks: ReturnType<typeof parseLogChunk>[]; window: LogWindowMeta } | null;
  revision: string;
} {
  const run = getRun(projectId, runId);
  return {
    run: run === null ? null : parsed(run),
    window: getLogWindow(projectId, runId),
    revision: revisionOf(projectId),
  };
}

beforeEach(() => {
  resetMockState();
  installVirtualRunClock(EPOCH_MS);
});

describe('run scenario typing', () => {
  it.each([
    'success',
    'failure',
    'timeout',
    'recovery',
    'delayed-start',
    'gap',
    'disconnect',
    'large-log',
    'reload-change',
  ] as const)('accepts %s', (scenario) => {
    expect(isRunScenario(scenario)).toBe(true);
    setRunScenario(scenario);
    expect(getRunScenario()).toBe(scenario);
  });

  it('rejects unknown scenario names', () => {
    expect(isRunScenario('normal')).toBe(false);
    expect(isRunScenario('SUCCESS')).toBe(false);
  });
});

describe('start payload and server-owned policy', () => {
  it('creates STARTING with frozen POC4 policy and only expectedWorkspaceRevision', () => {
    const run = startOk();
    expect(parsed(run)).toMatchObject({
      state: 'STARTING',
      requestedWorkspaceRevision: revisionOf(ALICE),
      policy: POC4_RUN_POLICY,
      startedAt: null,
      finishedAt: null,
      terminationReason: null,
      exitCode: null,
      logTruncated: false,
      logEvictedBytes: 0,
      lastLogSeq: null,
      createdAt: new Date(EPOCH_MS).toISOString(),
    });
    expect(run.policy.command).toBe('mvn clean test');
    expect(hasActiveRun(ALICE)).toBe(true);
    expect(getActiveRun(ALICE)?.id).toBe(run.id);
    expect(run.id).not.toMatch(/job-|pod-|pvc-|namespace|serviceAccount/i);
  });

  it.each(['command', 'image', 'resources', 'env'] as const)(
    'rejects extra %s on start and leaves state unchanged',
    (field) => {
      const extras: Record<string, unknown> = {
        command: 'mvn clean test',
        image: 'maven:3.9',
        resources: { cpuMillis: 1 },
        env: { FOO: 'bar' },
      };
      expectFail(startRun(ALICE, startBody(ALICE, { [field]: extras[field] })), 'VALIDATION_ERROR');
      expect(getActiveRun(ALICE)).toBeNull();
      expect(revisionOf(ALICE)).toBe('mock-rev-0001');
    },
  );

  it('rejects a missing or non-object start body', () => {
    expectFail(startRun(ALICE, null), 'VALIDATION_ERROR');
    expectFail(startRun(ALICE, { expectedWorkspaceRevision: '' }), 'VALIDATION_ERROR');
    expect(getActiveRun(ALICE)).toBeNull();
  });
});

describe('state machine', () => {
  it('allows one active Run per project and independent projects', () => {
    const alice = startOk(ALICE);
    expectFail(startRun(ALICE, startBody(ALICE)), 'RUN_ALREADY_ACTIVE');
    expect(getActiveRun(ALICE)?.id).toBe(alice.id);

    const bob = startOk(BOB);
    expect(getActiveRun(BOB)?.id).toBe(bob.id);
    expect(alice.id).not.toBe(bob.id);
    expect(hasActiveRun(ALICE)).toBe(true);
    expect(hasActiveRun(BOB)).toBe(true);
  });

  it('requires the current workspace revision', () => {
    expectFail(
      startRun(ALICE, { expectedWorkspaceRevision: 'mock-rev-9999' }),
      'WORKSPACE_REVISION_CONFLICT',
    );
    expect(getActiveRun(ALICE)).toBeNull();
    expect(revisionOf(ALICE)).toBe('mock-rev-0001');
  });

  it('keeps terminal runs in history and never returns them as active', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
    const finished = parsed(getRun(ALICE, run.id) as RunSummary);
    expect(finished.state).toBe('SUCCEEDED');
    expect(getActiveRun(ALICE)).toBeNull();
    expect(hasActiveRun(ALICE)).toBe(false);
    const listed = parseRunListResponse(listRuns(ALICE));
    expect(listed.items.map((item) => item.id)).toEqual([run.id]);
    expect(listed.items[0]?.state).toBe('SUCCEEDED');
  });

  it('supports STOPPING from STARTING with null startedAt, then CANCELLED', () => {
    const run = startOk();
    const stopping = expectOk(stopRun(ALICE, run.id)).run;
    expect(parsed(stopping)).toMatchObject({
      state: 'STOPPING',
      startedAt: null,
      finishedAt: null,
      terminationReason: null,
    });
    const again = expectOk(stopRun(ALICE, run.id)).run;
    expect(again.state).toBe('STOPPING');
    expect(again.createdAt).toBe(stopping.createdAt);
    advanceMockRunClock(MOCK_RUN_STOP_DELAY_MS);
    const cancelled = parsed(getRun(ALICE, run.id) as RunSummary);
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.terminationReason).toBe('USER_STOPPED');
    expect(cancelled.startedAt).toBeNull();
    expect(expectOk(stopRun(ALICE, run.id)).run.state).toBe('CANCELLED');
    expect(getActiveRun(ALICE)).toBeNull();
  });

  it('is idempotent once STOPPING and does not require a second stop delay', () => {
    const run = startOk();
    expectOk(stopRun(ALICE, run.id));
    expectOk(stopRun(ALICE, run.id));
    advanceMockRunClock(MOCK_RUN_STOP_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('CANCELLED');
  });

  it('returns RUN_NOT_FOUND for an unknown run without mutating the active run', () => {
    const run = startOk();
    const before = snapshot(ALICE, run.id);
    expectFail(stopRun(ALICE, 'run-missing'), 'RUN_NOT_FOUND');
    expect(snapshot(ALICE, run.id)).toEqual(before);
  });

  it.each([
    ['STARTING', 'SUCCEEDED'],
    ['STARTING', 'CANCELLED'],
    ['STARTING', 'TIMED_OUT'],
    ['RUNNING', 'STARTING'],
    ['SUCCEEDED', 'RUNNING'],
  ] as const)('rejects invalid %s -> %s and leaves run, log and revision unchanged', (from, to) => {
    const run = startOk();
    if (from === 'RUNNING' || from === 'SUCCEEDED') {
      expectOk(transitionRun(ALICE, run.id, { state: 'RUNNING' }));
    }
    if (from === 'SUCCEEDED') {
      expectOk(transitionRun(ALICE, run.id, { state: 'SUCCEEDED' }));
    }
    const before = snapshot(ALICE, run.id);
    expectFail(transitionRun(ALICE, run.id, { state: to }), 'RUN_STATE_CONFLICT');
    expect(snapshot(ALICE, run.id)).toEqual(before);
  });

  it('allows STARTING -> FAILED with START_FAILED', () => {
    const run = startOk();
    const failed = expectOk(
      transitionRun(ALICE, run.id, { state: 'FAILED', terminationReason: 'START_FAILED' }),
    ).run;
    expect(parsed(failed)).toMatchObject({
      state: 'FAILED',
      terminationReason: 'START_FAILED',
      startedAt: null,
    });
    expect(getActiveRun(ALICE)).toBeNull();
  });
});

describe('Run transition lifecycle isolation', () => {
  it('does not propagate an external before-transition observer exception', () => {
    const run = startOk();
    expectOk(transitionRun(ALICE, run.id, { state: 'RUNNING' }));
    const unsubscribe = subscribeMockRunBeforeTransition(() => {
      throw new Error('observer failure');
    });
    try {
      let result: ReturnType<typeof transitionRun> | undefined;
      expect(() => {
        result = transitionRun(ALICE, run.id, { state: 'STOPPING' });
      }).not.toThrow();
      expectOk(result as ReturnType<typeof transitionRun>);
      expect(getRun(ALICE, run.id)?.state).toBe('STOPPING');
    } finally {
      unsubscribe();
    }
  });

  it('rejects a reentrant transition for the same Run before the outer commit', () => {
    const run = startOk();
    expectOk(transitionRun(ALICE, run.id, { state: 'RUNNING' }));
    let attempted = false;
    const nested: Array<ReturnType<typeof transitionRun>> = [];
    const unsubscribe = subscribeMockRunBeforeTransition(() => {
      if (attempted) return;
      attempted = true;
      nested.push(transitionRun(ALICE, run.id, { state: 'SUCCEEDED' }));
    });
    try {
      const outer = transitionRun(ALICE, run.id, { state: 'STOPPING' });

      const nestedResult = nested[0];
      if (nestedResult === undefined) throw new Error('reentrant transition was not attempted');
      expectFail(nestedResult, 'RUN_STATE_CONFLICT');
      expectOk(outer);
      expect(getRun(ALICE, run.id)?.state).toBe('STOPPING');
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['reset', resetRunState],
    ['boot', bootRunState],
  ] as const)('clears external before-transition observers on %s', (_label, reset) => {
    let observed = 0;
    const unsubscribe = subscribeMockRunBeforeTransition(() => {
      observed += 1;
    });
    try {
      reset();
      installVirtualRunClock(EPOCH_MS);
      const run = startOk();
      expectOk(transitionRun(ALICE, run.id, { state: 'RUNNING' }));
      expectOk(transitionRun(ALICE, run.id, { state: 'STOPPING' }));
      expect(observed).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe('scenario clock', () => {
  it('drives success STARTING -> RUNNING -> SUCCEEDED without real sleeps', () => {
    const run = startOk();
    expect(getRun(ALICE, run.id)?.state).toBe('STARTING');
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS - 1);
    expect(getRun(ALICE, run.id)?.state).toBe('STARTING');
    advanceMockRunClock(1);
    const running = parsed(getRun(ALICE, run.id) as RunSummary);
    expect(running.state).toBe('RUNNING');
    expect(running.startedAt).toBe(new Date(EPOCH_MS + MOCK_RUN_START_DELAY_MS).toISOString());
    expect(running.lastLogSeq).toBe(1);
    const window = getLogWindow(ALICE, run.id);
    expect(window?.chunks[0]?.text).toContain(SEED_LOG_MARKER);
    parseLogChunk(window?.chunks[0]);
    parseLogWindowMeta(window?.window, { chunks: window?.chunks });
    advanceMockRunClock(MOCK_RUN_TERMINAL_DELAY_MS);
    expect(parsed(getRun(ALICE, run.id) as RunSummary)).toMatchObject({
      state: 'SUCCEEDED',
      terminationReason: 'BUILD_SUCCEEDED',
      exitCode: 0,
    });
  });

  it.each([
    ['failure', 'FAILED', 'BUILD_FAILED', 1],
    ['timeout', 'TIMED_OUT', 'TIME_LIMIT_EXCEEDED', null],
  ] as const)('drives %s to %s', (scenario, state, reason, exitCode) => {
    setRunScenario(scenario);
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
    expect(parsed(getRun(ALICE, run.id) as RunSummary)).toMatchObject({
      state,
      terminationReason: reason,
      exitCode,
    });
    expect(getActiveRun(ALICE)).toBeNull();
  });

  it('drives recovery through RECOVERING then RUNNING', () => {
    setRunScenario('recovery');
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('RECOVERING');
    advanceMockRunClock(MOCK_RUN_RECOVERY_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('RUNNING');
    advanceMockRunClock(MOCK_RUN_TERMINAL_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('SUCCEEDED');
  });

  it('holds STARTING until the delayed-start clock fires', () => {
    setRunScenario('delayed-start');
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('STARTING');
    advanceMockRunClock(MOCK_RUN_DELAYED_START_MS - MOCK_RUN_START_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('RUNNING');
  });

  it('holds gap, disconnect and large-log in RUNNING', () => {
    for (const scenario of ['gap', 'disconnect', 'large-log'] as const) {
      resetMockState();
      installVirtualRunClock(EPOCH_MS);
      setRunScenario(scenario);
      const run = startOk();
      advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
      expect(getRun(ALICE, run.id)?.state).toBe('RUNNING');
    }
  });

  it('emits heartbeat from the injected clock', () => {
    setRunScenario('gap');
    const events: string[] = [];
    subscribeMockRunEvents((event) => {
      if (event.type === 'stream.heartbeat') {
        events.push(event.serverTime);
      }
    });
    startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    advanceMockRunClock(MOCK_RUN_HEARTBEAT_INTERVAL_MS);
    expect(events).toEqual([
      new Date(EPOCH_MS + MOCK_RUN_START_DELAY_MS + MOCK_RUN_HEARTBEAT_INTERVAL_MS).toISOString(),
    ]);
  });

  it('delays append until the scenario clock advances', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expectOk(scheduleMockLogAppend(ALICE, run.id, 40, 'later-line\n'));
    advanceMockRunClock(39);
    expect(getLogWindow(ALICE, run.id)?.chunks.map((chunk) => chunk.text)).toEqual([SEED_LOG_TEXT]);
    advanceMockRunClock(1);
    const window = getLogWindow(ALICE, run.id);
    expect(window?.chunks.map((chunk) => chunk.text)).toEqual([SEED_LOG_TEXT, 'later-line\n']);
    expect(window?.chunks[1]?.seq).toBe(2);
  });
});

describe('persisted log windows', () => {
  it('appends increasing seq with UTF-8 byteLength including Chinese and emoji', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const text = '构建失败 🎉\n';
    const result = expectOk(appendLogChunk(ALICE, run.id, text));
    const chunk = parseLogChunk(result.chunk);
    expect(chunk.seq).toBe(2);
    expect(chunk.byteLength).toBe(new TextEncoder().encode(text).byteLength);
    expect(chunk.byteLength).not.toBe(text.length);
    parseLogWindowMeta(result.window, { appendChunk: chunk });
    expect(parsed(result.run).lastLogSeq).toBe(2);
    expect(parsed(result.run).logEvictedBytes).toBe(0);
  });

  it('rejects a chunk over 64 KiB and leaves the window unchanged', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const before = snapshot(ALICE, run.id);
    expectFail(
      appendLogChunk(ALICE, run.id, `${MAX_SIZE_LOG_CHUNK_TEXT}x`),
      'VALIDATION_ERROR',
    );
    expect(snapshot(ALICE, run.id)).toEqual(before);
  });

  it('evicts oldest whole chunks until retained bytes are at most 5 MiB', () => {
    setRunScenario('large-log');
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const seedBytes = new TextEncoder().encode(SEED_LOG_TEXT).byteLength;
    const overBudget = MAX_LOG_RETAINED_BYTES - seedBytes + MAX_LOG_CHUNK_UTF8_BYTES;
    const chunkCount = Math.ceil(overBudget / MAX_LOG_CHUNK_UTF8_BYTES);
    for (let index = 0; index < chunkCount; index += 1) {
      expectOk(appendLogChunk(ALICE, run.id, MAX_SIZE_LOG_CHUNK_TEXT));
    }
    const window = getLogWindow(ALICE, run.id);
    expect(window).not.toBeNull();
    if (window === null) {
      throw new Error('missing window');
    }
    parseLogWindowMeta(window.window, { chunks: window.chunks });
    expect(window.window.retainedBytes).toBeLessThanOrEqual(MAX_LOG_RETAINED_BYTES);
    expect(window.window.truncated).toBe(true);
    expect(window.window.evictedBytes).toBeGreaterThan(0);
    expect(window.window.firstAvailableSeq).toBeGreaterThan(1);
    const summary = parsed(getRun(ALICE, run.id) as RunSummary);
    expect(summary.logTruncated).toBe(true);
    expect(summary.logEvictedBytes).toBe(window.window.evictedBytes);
    expect(summary.lastLogSeq).toBe(window.window.lastAvailableSeq);
  });

  it('streams a real 6 MiB large-log payload, evicts the head markers, and succeeds', () => {
    setRunScenario('large-log');
    const planned = createLargeLogChunks();
    const generated = planned.reduce(
      (total, text) => total + new TextEncoder().encode(text).byteLength,
      0,
    );
    expect(generated).toBeGreaterThanOrEqual(LARGE_LOG_MIN_GENERATED_BYTES);
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expect(getRun(ALICE, run.id)?.state).toBe('RUNNING');
    advanceMockRunClock(MOCK_LARGE_LOG_VIRTUAL_CHUNK_DELAY_MS * (planned.length + 2));
    const finished = parsed(getRun(ALICE, run.id) as RunSummary);
    expect(finished.state).toBe('SUCCEEDED');
    const window = getLogWindow(ALICE, run.id);
    expect(window).not.toBeNull();
    if (window === null) {
      throw new Error('missing window');
    }
    parseLogWindowMeta(window.window, { chunks: window.chunks });
    expect(window.window.truncated).toBe(true);
    expect(window.window.retainedBytes).toBeLessThanOrEqual(MAX_LOG_RETAINED_BYTES);
    expect(window.window.evictedBytes).toBeGreaterThan(0);
    expect(window.window.retainedBytes + window.window.evictedBytes).toBeGreaterThanOrEqual(
      LARGE_LOG_MIN_GENERATED_BYTES,
    );
    const text = window.chunks.map((chunk) => chunk.text).join('');
    expect(text).toContain(LARGE_LOG_LATEST_MARKER);
    expect(text).not.toContain(LARGE_LOG_HEAD_MARKER);
    expect(text).not.toContain(LARGE_LOG_EVICTED_EARLY_MARKER);
    expect(getActiveRun(ALICE)).toBeNull();
  });

  it('updates persisted window and summary before notifying subscribers', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const phases: string[] = [];
    setMockRunPersistNotifyObserver((phase, event) => {
      if (event.type !== 'log.append') {
        return;
      }
      const window = getLogWindow(ALICE, run.id);
      expect(window?.chunks.some((chunk) => chunk.seq === event.chunk.seq)).toBe(true);
      expect(getRun(ALICE, run.id)?.lastLogSeq).toBe(event.chunk.seq);
      phases.push(phase);
    });
    subscribeMockRunEvents((event) => {
      if (event.type === 'log.append') {
        phases.push('subscriber');
      }
    });
    expectOk(appendLogChunk(ALICE, run.id, 'live\n'));
    expect(phases).toEqual(['persist', 'subscriber', 'notify']);
  });
});

describe('history', () => {
  it('lists unique run ids descending by createdAt with an opaque cursor', () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = startOk();
      ids.push(run.id);
      advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
    }
    const firstPage = parseRunListResponse(listRuns(ALICE, { limit: 2 }));
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toMatch(/job-|pod-|pvc-/i);
    expect(firstPage.items[0]?.id).toBe(ids[2]);
    expect(firstPage.items[1]?.id).toBe(ids[1]);
    expect(Date.parse(firstPage.items[0]?.createdAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(firstPage.items[1]?.createdAt ?? ''),
    );
    const secondPage = parseRunListResponse(
      listRuns(ALICE, { limit: 2, cursor: firstPage.nextCursor }),
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(secondPage.nextCursor).toBeNull();
    const combined = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(combined).size).toBe(3);
  });

  it('excludes runs older than seven mock-clock days and paginates the remainder', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const old = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
    expect(getRun(ALICE, old.id)?.state).toMatch(/SUCCEEDED|FAILED|CANCELLED|TIMED_OUT/);

    advanceMockRunClock(sevenDaysMs + 1);
    const recentIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = startOk();
      recentIds.push(run.id);
      advanceMockRunClock(MOCK_RUN_START_DELAY_MS + MOCK_RUN_TERMINAL_DELAY_MS);
    }

    const firstPage = parseRunListResponse(listRuns(ALICE, { limit: 2 }));
    expect(firstPage.items.map((item) => item.id)).toEqual([recentIds[2], recentIds[1]]);
    expect(firstPage.items.some((item) => item.id === old.id)).toBe(false);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = parseRunListResponse(
      listRuns(ALICE, { limit: 2, cursor: firstPage.nextCursor }),
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([recentIds[0]]);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].some((item) => item.id === old.id)).toBe(false);
    expect(getRun(ALICE, old.id)?.id).toBe(old.id);
  });

  it('still lists a run created exactly seven days ago until the mock clock moves past retention', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const run = startOk();
    advanceMockRunClock(sevenDaysMs);
    expect(getMockRunNowMs() - Date.parse(run.createdAt)).toBe(sevenDaysMs);
    expect(parseRunListResponse(listRuns(ALICE)).items.map((item) => item.id)).toContain(run.id);
    advanceMockRunClock(1);
    expect(parseRunListResponse(listRuns(ALICE)).items.map((item) => item.id)).not.toContain(run.id);
  });
});

describe('mock-only browser recovery contract (not backend restart or MySQL)', () => {
  it('persists compact scenario, active summary and seed log only', () => {
    setRunScenario('success');
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expectOk(appendLogChunk(ALICE, run.id, 'ephemeral-live\n'));
    const raw = sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY);
    expect(raw).toEqual(expect.any(String));
    expect(raw).not.toMatch(/tok-|demo-pass|Bearer|ephemeral-live/);
    expect(raw).toContain(SEED_LOG_MARKER);
    expect(raw).toContain('success');
    const parsedBlob = JSON.parse(raw ?? '{}') as { actives?: unknown[] };
    expect(Array.isArray(parsedBlob.actives)).toBe(true);
  });

  // Browser recovery contract only: mock sessionStorage must not keep the >5 MiB stress payload.
  it('does not write the large-log stress payload to sessionStorage', () => {
    setRunScenario('large-log');
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    for (let index = 0; index < 4; index += 1) {
      expectOk(appendLogChunk(ALICE, run.id, MAX_SIZE_LOG_CHUNK_TEXT));
    }
    const raw = sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY) ?? '';
    expect(raw.length).toBeLessThan(8 * 1024);
    expect(raw.length).toBeLessThan(5 * 1024 * 1024);
    expect(raw.includes(MAX_SIZE_LOG_CHUNK_TEXT)).toBe(false);
    expect(getLogWindow(ALICE, run.id)?.window.retainedBytes).toBeGreaterThan(64 * 1024);
  });

  // Proves the browser recovery contract via ensoai.mock.run-scenario.v1, not backend restart/MySQL.
  it('rehydrates active Run and seed replay cursor from mock sessionStorage, not backend restart or MySQL', () => {
    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const raw = sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY);
    expect(raw).toEqual(expect.any(String));
    resetMockState();
    expect(getActiveRun(ALICE)).toBeNull();
    expect(sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY)).toBeNull();
    sessionStorage.setItem(MOCK_RUN_PERSISTENCE_KEY, raw ?? '');
    rehydrateMockRunState();
    installVirtualRunClock(getMockRunNowMs() || EPOCH_MS);
    const restored = parsed(getActiveRun(ALICE) as RunSummary);
    expect(restored.id).toBe(run.id);
    expect(restored.state).toBe('RUNNING');
    const window = getLogWindow(ALICE, run.id);
    expect(window?.chunks[0]?.text).toContain(SEED_LOG_MARKER);
    parseLogWindowMeta(window?.window, { chunks: window?.chunks });
  });

  it('resetMockState clears run state, scenario, subscribers, clock and the persistence key', () => {
    setRunScenario('timeout');
    const run = startOk();
    let notified = 0;
    subscribeMockRunEvents(() => {
      notified += 1;
    });
    expect(sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY)).not.toBeNull();
    resetMockState();
    expect(getRunScenario()).toBe('success');
    expect(getActiveRun(ALICE)).toBeNull();
    expect(getRun(ALICE, run.id)).toBeNull();
    expect(sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY)).toBeNull();
    installVirtualRunClock(EPOCH_MS);
    const next = startOk();
    expectOk(appendLogChunk(ALICE, next.id, 'after-reset\n'));
    expect(notified).toBe(0);
  });
});

describe('reload-change simulated Job side effects', () => {
  it('mutates workspace files and revision before exposing the terminal run.state', () => {
    setRunScenario('reload-change');
    const beforeRevision = revisionOf(ALICE);
    const readmeBefore = getMockFile(ALICE, 'README.md')?.textContent ?? '';
    const seen: Array<{ state: string; revision: string; deleted: boolean; created: boolean }> = [];
    subscribeMockRunEvents((event) => {
      if (event.type !== 'run.state') {
        return;
      }
      seen.push({
        state: event.run.state,
        revision: revisionOf(ALICE),
        deleted: getMockFile(ALICE, 'src/test/java/demo/AppTest.java') === null,
        created: getMockFile(ALICE, 'docs/run-output.md') !== null,
      });
    });

    const run = startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expect(getActiveRun(ALICE)?.state).toBe('RUNNING');
    expect(revisionOf(ALICE)).toBe(beforeRevision);
    advanceMockRunClock(MOCK_RUN_TERMINAL_DELAY_MS);

    const terminal = snapshot(ALICE, run.id);
    expect(terminal.run?.state).toBe('SUCCEEDED');
    expect(terminal.revision).toBe('mock-rev-0004');
    expect(terminal.revision).not.toBe(beforeRevision);
    expect(getMockFile(ALICE, 'README.md')?.textContent).toBe(
      `${readmeBefore}\nensoai-stage4-reload-change\n`,
    );
    expect(getMockFile(ALICE, 'docs/run-output.md')).not.toBeNull();
    expect(getMockFile(ALICE, 'src/test/java/demo/AppTest.java')).toBeNull();
    const exposed = seen.find((event) => event.state === 'SUCCEEDED');
    expect(exposed).toEqual({
      state: 'SUCCEEDED',
      revision: 'mock-rev-0004',
      deleted: true,
      created: true,
    });
  });
});

describe('clock isolation', () => {
  it('does not use wall-clock sleeps for STARTING to RUNNING', () => {
    const started = Date.now();
    startOk();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    expect(Date.now() - started).toBeLessThan(50);
    expect(getActiveRun(ALICE)?.state).toBe('RUNNING' satisfies RunState);
  });
});
