import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_FRAME_UTF8_BYTES,
  parseLogClientFrame,
  type LogParseContext,
  type LogWindowMeta,
} from '../../contracts/log';
import { parseRunId, type RunSummary } from '../../contracts/run';
import {
  encodeLogSubscribe,
  interpretCloseCode,
  interpretLogServerJson,
  LOG_HEARTBEAT_WATCHDOG_MS,
  LOG_RECONNECT_BACKOFF_MS,
  LOG_WS_CLOSE_CODE,
  reconnectDelayMs,
  type LogProtocolCursor,
} from './logProtocol';

const PERSISTED_AT = '2026-08-24T10:00:02.000Z';
const SERVER_TIME = '2026-08-24T10:00:03.000Z';
const CONTEXT: LogParseContext = {
  projectId: 'prj-1',
  runId: parseRunId('run-1'),
};

const POLICY = {
  command: 'mvn clean test' as const,
  runtime: { javaMajor: 17 as const, mavenMajor: 3 as const },
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

const RUNNING: RunSummary = {
  id: parseRunId('run-1'),
  state: 'RUNNING',
  requestedWorkspaceRevision: 'rev-1' as RunSummary['requestedWorkspaceRevision'],
  policy: POLICY,
  createdAt: '2026-08-24T10:00:00.000Z',
  startedAt: '2026-08-24T10:00:01.000Z',
  finishedAt: null,
  terminationReason: null,
  exitCode: null,
  logTruncated: false,
  logEvictedBytes: 0,
  lastLogSeq: 2,
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function chunk(seq: number, text: string, persistedAt = PERSISTED_AT) {
  return { seq, text, byteLength: utf8Bytes(text), persistedAt };
}

function windowFromChunks(
  chunks: Array<{ seq: number; byteLength: number }>,
  extra: Partial<LogWindowMeta> = {},
): LogWindowMeta {
  const retainedBytes = chunks.reduce((sum, item) => sum + item.byteLength, 0);
  return {
    firstAvailableSeq: chunks[0]?.seq ?? null,
    lastAvailableSeq: chunks[chunks.length - 1]?.seq ?? null,
    retainedBytes,
    truncated: false,
    evictedBytes: 0,
    ...extra,
  };
}

function cursor(lastAppliedSeq: number | null, generation = 1): LogProtocolCursor {
  return { lastAppliedSeq, generation };
}

function interpret(
  payload: unknown,
  lastAppliedSeq: number | null,
  extra: { generation?: number; frameGeneration?: number; context?: LogParseContext } = {},
) {
  const generation = extra.generation ?? 1;
  return interpretLogServerJson(JSON.stringify(payload), extra.context ?? CONTEXT, {
    ...cursor(lastAppliedSeq, generation),
    frameGeneration: extra.frameGeneration ?? generation,
  });
}

describe('log subscribe encoding', () => {
  it('encodes subscribe from null or last applied seq', () => {
    expect(parseLogClientFrame(JSON.parse(encodeLogSubscribe(null)))).toEqual({
      type: 'log.subscribe',
      lastSeq: null,
    });
    expect(parseLogClientFrame(JSON.parse(encodeLogSubscribe(12)))).toEqual({
      type: 'log.subscribe',
      lastSeq: 12,
    });
  });
});

describe('reconnect backoff and close codes', () => {
  it('uses 0, 500, 1s, 2s, 5s then remains 5s without jitter', () => {
    expect(LOG_RECONNECT_BACKOFF_MS).toEqual([0, 500, 1_000, 2_000, 5_000]);
    expect(LOG_HEARTBEAT_WATCHDOG_MS).toBe(30_000);
    const delays = [0, 1, 2, 3, 4, 5, 9].map((attempt) =>
      reconnectDelayMs(attempt, { jitter: false }),
    );
    expect(delays).toEqual([0, 500, 1_000, 2_000, 5_000, 5_000, 5_000]);
  });

  it('maps handshake close codes and ignores reason text', () => {
    expect(LOG_WS_CLOSE_CODE).toEqual({
      UNAUTHENTICATED: 4401,
      FORBIDDEN: 4403,
      TICKET_EXPIRED: 4408,
      TICKET_USED: 4409,
      SERVER_FAILURE: 1011,
    });
    expect(interpretCloseCode(4401, 'any free-form reason')).toBe('unauthenticated');
    expect(interpretCloseCode(4403, 'forbidden details')).toBe('forbidden');
    expect(interpretCloseCode(4408, 'expired')).toBe('retry');
    expect(interpretCloseCode(4409, 'used')).toBe('retry');
    expect(interpretCloseCode(1011, 'boom')).toBe('retry');
    expect(interpretCloseCode(1006, 'abnormal')).toBe('retry');
    expect(interpretCloseCode(1000, undefined, { streamComplete: true })).toBe('stop');
    expect(interpretCloseCode(1000, 'done')).toBe('retry');
  });
});

describe('log protocol sequence rules', () => {
  it('applies a replay from null lastSeq', () => {
    const chunks = [chunk(1, 'hello '), chunk(2, '你好🌍')];
    const window = windowFromChunks(chunks);
    expect(interpret({ type: 'log.replay', chunks, window }, null)).toEqual({
      kind: 'apply',
      chunks,
      window,
      lastAppliedSeq: 2,
    });
  });

  it('applies only seqs after last applied seq on replay', () => {
    const chunks = [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')];
    const window = windowFromChunks(chunks);
    expect(interpret({ type: 'log.replay', chunks, window }, 2)).toEqual({
      kind: 'apply',
      chunks: [chunks[2]],
      window,
      lastAppliedSeq: 3,
    });
  });

  it('ignores duplicate append seq <= lastAppliedSeq', () => {
    const item = chunk(2, 'b');
    expect(
      interpret({ type: 'log.append', chunk: item, window: windowFromChunks([item]) }, 2),
    ).toEqual({ kind: 'duplicate' });
    expect(
      interpret({ type: 'log.append', chunk: item, window: windowFromChunks([item]) }, 3),
    ).toEqual({ kind: 'duplicate' });
  });

  it('applies a valid truncation jump when earlier data was evicted', () => {
    const retained = [chunk(8, 'tail-a'), chunk(9, 'tail-b')];
    const window = {
      firstAvailableSeq: 8,
      lastAvailableSeq: 9,
      retainedBytes: retained[0]!.byteLength + retained[1]!.byteLength,
      truncated: true,
      evictedBytes: 4096,
    };
    expect(interpret({ type: 'log.replay', chunks: retained, window }, 3)).toEqual({
      kind: 'apply',
      chunks: retained,
      window,
      lastAppliedSeq: 9,
    });
    expect(
      interpret({ type: 'log.append', chunk: retained[0], window: { ...window, lastAvailableSeq: 8, retainedBytes: retained[0]!.byteLength } }, 3),
    ).toMatchObject({ kind: 'apply', chunks: [retained[0]], lastAppliedSeq: 8 });
  });

  it('returns gap when seq skips without truncation proof', () => {
    const item = chunk(5, 'skip');
    const window = windowFromChunks([item]);
    expect(interpret({ type: 'log.append', chunk: item, window }, 2)).toEqual({ kind: 'gap' });
    expect(
      interpret(
        {
          type: 'log.replay',
          chunks: [item],
          window,
        },
        2,
      ),
    ).toEqual({ kind: 'gap' });
    expect(
      interpret(
        {
          type: 'log.append',
          chunk: item,
          window: { ...window, truncated: true, firstAvailableSeq: 4, lastAvailableSeq: 5 },
        },
        2,
      ),
    ).toEqual({ kind: 'gap' });
  });

  it('rejects malformed JSON, oversized frames, UTF-8 mismatch and wrong Run events all-or-nothing', () => {
    const generation = 4;
    expect(
      interpretLogServerJson('{', CONTEXT, { ...cursor(null, generation), frameGeneration: generation }),
    ).toEqual({ kind: 'invalid' });
    expect(
      interpretLogServerJson('x'.repeat(MAX_LOG_FRAME_UTF8_BYTES + 1), CONTEXT, {
        ...cursor(null, generation),
        frameGeneration: generation,
      }),
    ).toEqual({ kind: 'invalid' });

    const text = '你好🌍';
    const bad = { seq: 1, text, byteLength: text.length, persistedAt: PERSISTED_AT };
    expect(
      interpret(
        { type: 'log.append', chunk: bad, window: windowFromChunks([bad]) },
        null,
      ),
    ).toEqual({ kind: 'invalid' });

    expect(interpret({ type: 'run.state', run: RUNNING }, null, { context: { projectId: 'prj-1', runId: parseRunId('run-other') } })).toEqual(
      { kind: 'invalid' },
    );

    const good = chunk(1, 'ok');
    const mismatch = { ...chunk(2, '你好'), byteLength: 2 };
    expect(
      interpret(
        {
          type: 'log.replay',
          chunks: [good, mismatch],
          window: windowFromChunks([good, mismatch]),
        },
        null,
      ),
    ).toEqual({ kind: 'invalid' });
  });

  it('applies complete and heartbeat without changing the seq cursor', () => {
    expect(interpret({ type: 'log.complete', lastSeq: 2 }, 2)).toEqual({
      kind: 'complete',
      lastSeq: 2,
    });
    expect(interpret({ type: 'log.complete', lastSeq: null }, null)).toEqual({
      kind: 'complete',
      lastSeq: null,
    });
    expect(interpret({ type: 'stream.heartbeat', serverTime: SERVER_TIME }, 4)).toEqual({
      kind: 'heartbeat',
      serverTime: SERVER_TIME,
    });
  });

  it('ignores stale generation frames including invalid payloads', () => {
    expect(
      interpret({ type: 'stream.heartbeat', serverTime: SERVER_TIME }, 1, {
        generation: 3,
        frameGeneration: 2,
      }),
    ).toEqual({ kind: 'stale' });
    expect(
      interpretLogServerJson('{', CONTEXT, { ...cursor(1, 3), frameGeneration: 2 }),
    ).toEqual({ kind: 'stale' });
  });

  it('returns typed stream errors and run.state frames', () => {
    expect(
      interpret({ type: 'stream.error', code: 'STREAM_UNAVAILABLE', retryable: true }, 1),
    ).toEqual({ kind: 'error', code: 'STREAM_UNAVAILABLE', retryable: true });
    expect(interpret({ type: 'stream.error', code: 'FORBIDDEN', retryable: false }, 1)).toEqual({
      kind: 'error',
      code: 'FORBIDDEN',
      retryable: false,
    });
    expect(interpret({ type: 'run.state', run: RUNNING }, 2)).toEqual({
      kind: 'run-state',
      run: RUNNING,
    });
  });

  it('applies empty caught-up replay window metadata without treating it as a gap', () => {
    const window = {
      firstAvailableSeq: 3,
      lastAvailableSeq: 4,
      retainedBytes: 4,
      truncated: true,
      evictedBytes: 10,
    };
    expect(interpret({ type: 'log.replay', chunks: [], window }, 4)).toEqual({
      kind: 'apply',
      chunks: [],
      window,
      lastAppliedSeq: 4,
    });
  });
});
