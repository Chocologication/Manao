import { describe, expect, it } from 'vitest';
import { parseWorkspaceRevision } from './file';
import {
  parseActiveRunResponse,
  parseLogTicketResponse,
  parseRunId,
  parseRunListResponse,
  parseRunSummary,
  parseStartRunRequest,
  parseStartRunResponse,
  type RunPolicy,
  type RunState,
  type RunSummary,
  type RunTerminationReason,
} from './run';

const CREATED_AT = '2026-08-24T10:00:00.000Z';
const STARTED_AT = '2026-08-24T10:00:01.000Z';
const FINISHED_AT = '2026-08-24T10:05:00.000Z';

const POLICY: RunPolicy = {
  command: 'mvn clean test',
  runtime: { javaMajor: 17, mavenMajor: 3 },
  timeoutSeconds: 1800,
  resources: {
    requests: {
      cpuMillis: 2000,
      memoryBytes: 2_147_483_648,
      ephemeralStorageBytes: 1_073_741_824,
    },
    limits: {
      cpuMillis: 4000,
      memoryBytes: 4_294_967_296,
      ephemeralStorageBytes: 2_147_483_648,
    },
  },
};

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    state: 'STARTING',
    requestedWorkspaceRevision: 'rev-1',
    policy: POLICY,
    createdAt: CREATED_AT,
    startedAt: null,
    finishedAt: null,
    terminationReason: null,
    exitCode: null,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: null,
    ...overrides,
  };
}

const VALID_BY_STATE: Record<RunState, Record<string, unknown>> = {
  STARTING: summary(),
  RUNNING: summary({
    state: 'RUNNING',
    startedAt: STARTED_AT,
    lastLogSeq: 4,
  }),
  STOPPING: summary({
    state: 'STOPPING',
    startedAt: STARTED_AT,
    lastLogSeq: 4,
  }),
  RECOVERING: summary({
    state: 'RECOVERING',
    startedAt: STARTED_AT,
    lastLogSeq: 4,
  }),
  SUCCEEDED: summary({
    state: 'SUCCEEDED',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    terminationReason: 'BUILD_SUCCEEDED',
    exitCode: 0,
    lastLogSeq: 12,
  }),
  FAILED: summary({
    state: 'FAILED',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    terminationReason: 'BUILD_FAILED',
    exitCode: 1,
    lastLogSeq: 12,
  }),
  CANCELLED: summary({
    state: 'CANCELLED',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    terminationReason: 'USER_STOPPED',
    exitCode: null,
    lastLogSeq: 8,
  }),
  TIMED_OUT: summary({
    state: 'TIMED_OUT',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    terminationReason: 'TIME_LIMIT_EXCEEDED',
    exitCode: null,
    lastLogSeq: 20,
  }),
};

describe('run identifiers', () => {
  it('accepts a non-empty opaque run id', () => {
    expect(parseRunId('run/opaque')).toBe('run/opaque');
    expect(parseRunId('x'.repeat(256))).toBe('x'.repeat(256));
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(257)],
    ['non-string', 1],
  ])('rejects %s run id', (_label, value) => {
    expect(() => parseRunId(value)).toThrow('Invalid run response');
  });
});

describe('run summary states', () => {
  it.each(Object.keys(VALID_BY_STATE) as RunState[])('parses %s', (state) => {
    expect(parseRunSummary(VALID_BY_STATE[state])).toEqual(VALID_BY_STATE[state]);
  });

  it('allows STOPPING and RECOVERING with null startedAt from STARTING', () => {
    expect(
      parseRunSummary(summary({ state: 'STOPPING', startedAt: null })).startedAt,
    ).toBeNull();
    expect(
      parseRunSummary(summary({ state: 'RECOVERING', startedAt: null })).startedAt,
    ).toBeNull();
  });

  it('parses FAILED with START_FAILED and RECOVERY_FAILED reasons', () => {
    expect(
      parseRunSummary(
        summary({
          state: 'FAILED',
          startedAt: null,
          finishedAt: FINISHED_AT,
          terminationReason: 'START_FAILED',
          exitCode: null,
        }),
      ).terminationReason,
    ).toBe('START_FAILED');
    expect(
      parseRunSummary(
        summary({
          state: 'FAILED',
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          terminationReason: 'RECOVERY_FAILED',
          exitCode: null,
        }),
      ).terminationReason,
    ).toBe('RECOVERY_FAILED');
  });

  it('rejects unknown states instead of mapping them to editable', () => {
    expect(() => parseRunSummary(summary({ state: 'QUEUED' }))).toThrow('Invalid run response');
    expect(() => parseRunSummary(summary({ state: 'EDITABLE' }))).toThrow('Invalid run response');
  });
});

describe('run summary invariants', () => {
  it.each([
    ['STARTING with startedAt', summary({ startedAt: STARTED_AT })],
    ['STARTING with finishedAt', summary({ finishedAt: FINISHED_AT })],
    ['STARTING with terminationReason', summary({ terminationReason: 'START_FAILED' })],
    ['STARTING with exitCode', summary({ exitCode: 1 })],
    [
      'RUNNING without startedAt',
      summary({ state: 'RUNNING', startedAt: null }),
    ],
    [
      'RUNNING with finishedAt',
      summary({ state: 'RUNNING', startedAt: STARTED_AT, finishedAt: FINISHED_AT }),
    ],
    [
      'RUNNING with terminationReason',
      summary({
        state: 'RUNNING',
        startedAt: STARTED_AT,
        terminationReason: 'BUILD_FAILED',
      }),
    ],
    [
      'STOPPING with finishedAt',
      summary({ state: 'STOPPING', startedAt: STARTED_AT, finishedAt: FINISHED_AT }),
    ],
    [
      'terminal without finishedAt',
      summary({
        state: 'SUCCEEDED',
        startedAt: STARTED_AT,
        finishedAt: null,
        terminationReason: 'BUILD_SUCCEEDED',
        exitCode: 0,
      }),
    ],
    [
      'SUCCEEDED without exit 0',
      summary({
        state: 'SUCCEEDED',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        terminationReason: 'BUILD_SUCCEEDED',
        exitCode: 1,
      }),
    ],
    [
      'SUCCEEDED with mismatched reason',
      summary({
        state: 'SUCCEEDED',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        terminationReason: 'BUILD_FAILED',
        exitCode: 0,
      }),
    ],
    [
      'CANCELLED with mismatched reason',
      summary({
        state: 'CANCELLED',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        terminationReason: 'BUILD_FAILED',
        exitCode: null,
      }),
    ],
    [
      'TIMED_OUT with mismatched reason',
      summary({
        state: 'TIMED_OUT',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        terminationReason: 'USER_STOPPED',
        exitCode: null,
      }),
    ],
    [
      'FAILED with user-stopped reason',
      summary({
        state: 'FAILED',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        terminationReason: 'USER_STOPPED',
        exitCode: 1,
      }),
    ],
    ['invalid createdAt', summary({ createdAt: 'not-iso' })],
    ['invalid startedAt', summary({ state: 'RUNNING', startedAt: 'yesterday' })],
    [
      'startedAt before createdAt',
      summary({ state: 'RUNNING', startedAt: '2026-08-24T09:59:59.000Z' }),
    ],
    [
      'finishedAt before startedAt',
      summary({
        state: 'SUCCEEDED',
        startedAt: STARTED_AT,
        finishedAt: CREATED_AT,
        terminationReason: 'BUILD_SUCCEEDED',
        exitCode: 0,
      }),
    ],
    ['negative evicted bytes', summary({ logEvictedBytes: -1 })],
    ['unsafe evicted bytes', summary({ logEvictedBytes: Number.MAX_SAFE_INTEGER + 1 })],
    ['negative lastLogSeq', summary({ lastLogSeq: -1 })],
    ['truncated false with evicted bytes', summary({ logTruncated: false, logEvictedBytes: 12 })],
    ['non-boolean truncated', summary({ logTruncated: 'false' })],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseRunSummary(payload)).toThrow('Invalid run response');
  });

  it('accepts truncated true with evicted bytes', () => {
    expect(
      parseRunSummary(summary({ logTruncated: true, logEvictedBytes: 12 })),
    ).toMatchObject({ logTruncated: true, logEvictedBytes: 12 });
  });
});

describe('run policy', () => {
  it.each([
    ['wrong command', { ...POLICY, command: 'mvn -q test' }],
    ['browser-supplied image', { ...POLICY, image: 'maven:3.9' }],
    ['browser-supplied env', { ...POLICY, env: { CI: 'true' } }],
    ['timeout zero', { ...POLICY, timeoutSeconds: 0 }],
    ['timeout above 1800', { ...POLICY, timeoutSeconds: 1801 }],
    ['unsafe timeout', { ...POLICY, timeoutSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong java major', { ...POLICY, runtime: { javaMajor: 21, mavenMajor: 3 } }],
    ['wrong maven major', { ...POLICY, runtime: { javaMajor: 17, mavenMajor: 4 } }],
    [
      'request cpu above limit',
      {
        ...POLICY,
        resources: {
          requests: { ...POLICY.resources.requests, cpuMillis: 5000 },
          limits: POLICY.resources.limits,
        },
      },
    ],
    [
      'cpu limit above 8000',
      {
        ...POLICY,
        resources: {
          requests: POLICY.resources.requests,
          limits: { ...POLICY.resources.limits, cpuMillis: 8001 },
        },
      },
    ],
    [
      'memory limit above 16Gi',
      {
        ...POLICY,
        resources: {
          requests: POLICY.resources.requests,
          limits: { ...POLICY.resources.limits, memoryBytes: 17_179_869_185 },
        },
      },
    ],
    [
      'ephemeral limit above 10Gi',
      {
        ...POLICY,
        resources: {
          requests: POLICY.resources.requests,
          limits: { ...POLICY.resources.limits, ephemeralStorageBytes: 10_737_418_241 },
        },
      },
    ],
    [
      'zero request',
      {
        ...POLICY,
        resources: {
          requests: { ...POLICY.resources.requests, cpuMillis: 0 },
          limits: POLICY.resources.limits,
        },
      },
    ],
  ])('rejects policy with %s', (_label, policy) => {
    expect(() => parseRunSummary(summary({ policy }))).toThrow('Invalid run response');
  });
});

describe('start-related payloads', () => {
  it('accepts a start body with only expectedWorkspaceRevision', () => {
    expect(
      parseStartRunRequest({ expectedWorkspaceRevision: 'rev-1' }),
    ).toEqual({ expectedWorkspaceRevision: parseWorkspaceRevision('rev-1') });
  });

  it.each([
    ['command', { expectedWorkspaceRevision: 'rev-1', command: 'mvn clean test' }],
    ['image', { expectedWorkspaceRevision: 'rev-1', image: 'maven:3.9' }],
    ['resources', { expectedWorkspaceRevision: 'rev-1', resources: POLICY.resources }],
    ['env', { expectedWorkspaceRevision: 'rev-1', env: { MAVEN_OPTS: '-Xmx1g' } }],
    ['extra unknown field', { expectedWorkspaceRevision: 'rev-1', mavenArgs: '-q' }],
    ['missing revision', {}],
  ])('rejects start request with %s', (_label, payload) => {
    expect(() => parseStartRunRequest(payload)).toThrow('Invalid run response');
  });

  it.each([
    ['command', { ...VALID_BY_STATE.STARTING, command: 'bash' }],
    ['image', { ...VALID_BY_STATE.STARTING, image: 'maven:3.9' }],
    ['resources', { ...VALID_BY_STATE.STARTING, resources: POLICY.resources }],
    ['env', { ...VALID_BY_STATE.STARTING, env: { CI: '1' } }],
  ])('rejects start response with extra %s', (_label, payload) => {
    expect(() => parseStartRunResponse(payload)).toThrow('Invalid run response');
    expect(() => parseRunSummary(payload)).toThrow('Invalid run response');
  });
});

describe('active run response', () => {
  it('accepts a locking run or null', () => {
    expect(parseActiveRunResponse({ run: VALID_BY_STATE.RUNNING })).toEqual({
      run: VALID_BY_STATE.RUNNING,
    });
    expect(parseActiveRunResponse({ run: null })).toEqual({ run: null });
  });

  it.each([
    ['SUCCEEDED', VALID_BY_STATE.SUCCEEDED],
    ['FAILED', VALID_BY_STATE.FAILED],
    ['CANCELLED', VALID_BY_STATE.CANCELLED],
    ['TIMED_OUT', VALID_BY_STATE.TIMED_OUT],
  ])('rejects terminal %s as active', (_label, run) => {
    expect(() => parseActiveRunResponse({ run })).toThrow('Invalid run response');
  });
});

describe('run list response', () => {
  it('accepts descending unique history and an opaque cursor', () => {
    const newer = summary({ id: 'run-2', createdAt: '2026-08-24T11:00:00.000Z' });
    const older = summary({ id: 'run-1', createdAt: CREATED_AT });
    expect(
      parseRunListResponse({ items: [newer, older], nextCursor: 'opaque/cursor+value=' }),
    ).toEqual({ items: [newer, older], nextCursor: 'opaque/cursor+value=' });
    expect(parseRunListResponse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('rejects the full list when one item is invalid', () => {
    const payload = {
      items: [VALID_BY_STATE.RUNNING, summary({ state: 'RUNNING', startedAt: null })],
      nextCursor: null,
    };
    expect(() => parseRunListResponse(payload)).toThrow('Invalid run response');
  });

  it.each([
    [
      'duplicate history ids',
      {
        items: [
          summary({ id: 'run-1', createdAt: '2026-08-24T11:00:00.000Z' }),
          summary({ id: 'run-1', createdAt: CREATED_AT }),
        ],
        nextCursor: null,
      },
    ],
    [
      'wrong sort',
      {
        items: [
          summary({ id: 'run-1', createdAt: CREATED_AT }),
          summary({ id: 'run-2', createdAt: '2026-08-24T11:00:00.000Z' }),
        ],
        nextCursor: null,
      },
    ],
    ['malformed cursor number', { items: [], nextCursor: 12 }],
    ['malformed empty cursor', { items: [], nextCursor: '' }],
    ['malformed cursor object', { items: [], nextCursor: { token: 'x' } }],
  ])('rejects list with %s', (_label, payload) => {
    expect(() => parseRunListResponse(payload)).toThrow('Invalid run response');
  });
});

describe('log ticket response', () => {
  it('parses an opaque ticket and expiry', () => {
    expect(
      parseLogTicketResponse({
        ticket: 'ticket-opaque',
        expiresAt: '2026-08-24T10:00:30.000Z',
      }),
    ).toEqual({
      ticket: 'ticket-opaque',
      expiresAt: '2026-08-24T10:00:30.000Z',
    });
  });

  it.each([
    ['empty ticket', { ticket: '', expiresAt: '2026-08-24T10:00:30.000Z' }],
    ['invalid expiry', { ticket: 'ticket-opaque', expiresAt: 'soon' }],
    ['websocket url', { ticket: 't', expiresAt: FINISHED_AT, url: 'wss://evil.example/ws' }],
  ])('rejects ticket response with %s', (_label, payload) => {
    expect(() => parseLogTicketResponse(payload)).toThrow('Invalid run response');
  });
});

describe('branded run types', () => {
  it('keeps run ids branded at the type level', () => {
    const run = parseRunSummary(VALID_BY_STATE.RUNNING) as RunSummary;
    expect(run.id).toBe('run-1');
    expect(run.state).toBe('RUNNING');
    const reason: RunTerminationReason | null = parseRunSummary(VALID_BY_STATE.SUCCEEDED)
      .terminationReason;
    expect(reason).toBe('BUILD_SUCCEEDED');
    if (false) {
      // @ts-expect-error raw strings are not branded run ids
      const _id: typeof run.id = 'run-1';
      void _id;
    }
  });
});
