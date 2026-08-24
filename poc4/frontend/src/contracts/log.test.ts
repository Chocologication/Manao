import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_CHUNK_UTF8_BYTES,
  MAX_LOG_FRAME_UTF8_BYTES,
  MAX_LOG_RETAINED_BYTES,
  parseLogClientFrame,
  parseLogServerFrame,
  parseLogServerFrameJson,
  type LogParseContext,
  type LogWindowMeta,
} from './log';
import { parseRunId, type RunSummary } from './run';

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

describe('log client frames', () => {
  it('parses subscribe with null or positive lastSeq', () => {
    expect(parseLogClientFrame({ type: 'log.subscribe', lastSeq: null })).toEqual({
      type: 'log.subscribe',
      lastSeq: null,
    });
    expect(parseLogClientFrame({ type: 'log.subscribe', lastSeq: 12 })).toEqual({
      type: 'log.subscribe',
      lastSeq: 12,
    });
  });

  it.each([
    ['zero lastSeq', { type: 'log.subscribe', lastSeq: 0 }],
    ['negative lastSeq', { type: 'log.subscribe', lastSeq: -1 }],
    ['terminal resize', { type: 'terminal.resize', cols: 80, rows: 24 }],
    ['unknown type', { type: 'log.unsubscribe', lastSeq: null }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseLogClientFrame(payload)).toThrow('Invalid log frame');
  });
});

describe('log server frames', () => {
  it('parses replay, append, run.state, complete, heartbeat and error', () => {
    const chunks = [chunk(1, 'hello '), chunk(2, '你好🌍')];
    const window = windowFromChunks(chunks);
    expect(
      parseLogServerFrame({ type: 'log.replay', chunks, window }, CONTEXT),
    ).toEqual({ type: 'log.replay', chunks, window });
    expect(
      parseLogServerFrame({ type: 'log.append', chunk: chunks[1], window }, CONTEXT),
    ).toEqual({ type: 'log.append', chunk: chunks[1], window });
    expect(
      parseLogServerFrame({ type: 'run.state', run: RUNNING }, CONTEXT),
    ).toEqual({ type: 'run.state', run: RUNNING });
    expect(
      parseLogServerFrame({ type: 'log.complete', lastSeq: 2 }, CONTEXT),
    ).toEqual({ type: 'log.complete', lastSeq: 2 });
    expect(
      parseLogServerFrame({ type: 'stream.heartbeat', serverTime: SERVER_TIME }, CONTEXT),
    ).toEqual({ type: 'stream.heartbeat', serverTime: SERVER_TIME });
    expect(
      parseLogServerFrame(
        { type: 'stream.error', code: 'STREAM_UNAVAILABLE', retryable: true },
        CONTEXT,
      ),
    ).toEqual({ type: 'stream.error', code: 'STREAM_UNAVAILABLE', retryable: true });
  });

  it('accepts exact UTF-8 byteLength for Chinese and emoji text', () => {
    const text = '构建失败 😅';
    const item = chunk(1, text);
    expect(item.byteLength).toBe(utf8Bytes(text));
    expect(item.byteLength).not.toBe(text.length);
    expect(
      parseLogServerFrame(
        { type: 'log.append', chunk: item, window: windowFromChunks([item]) },
        CONTEXT,
      ),
    ).toMatchObject({ chunk: item });
  });

  it('rejects a claimed byteLength that does not match UTF-8', () => {
    const text = '你好🌍';
    const item = { seq: 1, text, byteLength: text.length, persistedAt: PERSISTED_AT };
    expect(() =>
      parseLogServerFrame(
        { type: 'log.append', chunk: item, window: windowFromChunks([item]) },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it('rejects duplicate and out-of-order replay chunks for the full frame', () => {
    const first = chunk(1, 'a');
    const second = chunk(2, 'b');
    expect(() =>
      parseLogServerFrame(
        {
          type: 'log.replay',
          chunks: [first, first],
          window: windowFromChunks([first, first]),
        },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
    expect(() =>
      parseLogServerFrame(
        {
          type: 'log.replay',
          chunks: [second, first],
          window: {
            firstAvailableSeq: 1,
            lastAvailableSeq: 2,
            retainedBytes: first.byteLength + second.byteLength,
            truncated: false,
            evictedBytes: 0,
          },
        },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
    expect(() =>
      parseLogServerFrame(
        {
          type: 'log.replay',
          chunks: [first, chunk(3, 'c')],
          window: {
            firstAvailableSeq: 1,
            lastAvailableSeq: 3,
            retainedBytes: utf8Bytes('a') + utf8Bytes('c'),
            truncated: false,
            evictedBytes: 0,
          },
        },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it('rejects one invalid replay item without returning the rest', () => {
    const good = chunk(1, 'ok');
    const bad = { ...chunk(2, '你好'), byteLength: 2 };
    expect(() =>
      parseLogServerFrame(
        {
          type: 'log.replay',
          chunks: [good, bad],
          window: windowFromChunks([good, bad]),
        },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it.each([
    [
      'first after last',
      { firstAvailableSeq: 4, lastAvailableSeq: 2, retainedBytes: 0, truncated: false, evictedBytes: 0 },
    ],
    [
      'half-null bounds',
      { firstAvailableSeq: 1, lastAvailableSeq: null, retainedBytes: 0, truncated: false, evictedBytes: 0 },
    ],
    [
      'negative eviction',
      { firstAvailableSeq: 1, lastAvailableSeq: 1, retainedBytes: 1, truncated: false, evictedBytes: -1 },
    ],
  ])('rejects invalid window bounds: %s', (_label, window) => {
    const item = chunk(3, 'x');
    expect(() =>
      parseLogServerFrame({ type: 'log.append', chunk: item, window }, CONTEXT),
    ).toThrow('Invalid log frame');
  });

  it('rejects retained bytes over 5 MiB', () => {
    const text = 'x'.repeat(MAX_LOG_CHUNK_UTF8_BYTES);
    const chunkCount = MAX_LOG_RETAINED_BYTES / MAX_LOG_CHUNK_UTF8_BYTES + 1;
    const chunks = Array.from({ length: chunkCount }, (_, index) => chunk(index + 1, text));
    expect(() =>
      parseLogServerFrame(
        { type: 'log.replay', chunks, window: windowFromChunks(chunks) },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it('accepts truncated windows with or without eviction bytes', () => {
    const item = chunk(3, 'x');
    const base = {
      firstAvailableSeq: 3,
      lastAvailableSeq: 3,
      retainedBytes: item.byteLength,
    };
    expect(
      parseLogServerFrame(
        {
          type: 'log.append',
          chunk: item,
          window: { ...base, truncated: true, evictedBytes: 0 },
        },
        CONTEXT,
      ),
    ).toMatchObject({ window: { truncated: true, evictedBytes: 0 } });
    expect(
      parseLogServerFrame(
        {
          type: 'log.append',
          chunk: item,
          window: { ...base, truncated: true, evictedBytes: 4096 },
        },
        CONTEXT,
      ),
    ).toMatchObject({ window: { truncated: true, evictedBytes: 4096 } });
  });

  it('parses a lastSeq gap replay as a suffix of the retained window', () => {
    const retained = [chunk(3, 'aaa'), chunk(4, 'bbbb'), chunk(5, 'ccccc')];
    const window = {
      firstAvailableSeq: 3,
      lastAvailableSeq: 5,
      retainedBytes: retained.reduce((sum, item) => sum + item.byteLength, 0),
      truncated: true,
      evictedBytes: 2048,
    };
    const gap = [retained[1], retained[2]];
    expect(
      parseLogServerFrame({ type: 'log.replay', chunks: gap, window }, CONTEXT),
    ).toEqual({ type: 'log.replay', chunks: gap, window });
  });

  it('rejects a gap replay that does not reach lastAvailableSeq', () => {
    const first = chunk(3, 'aaa');
    const middle = chunk(4, 'bbbb');
    const last = chunk(5, 'ccccc');
    const window = {
      firstAvailableSeq: 3,
      lastAvailableSeq: 5,
      retainedBytes: first.byteLength + middle.byteLength + last.byteLength,
      truncated: true,
      evictedBytes: 2048,
    };
    expect(() =>
      parseLogServerFrame({ type: 'log.replay', chunks: [middle], window }, CONTEXT),
    ).toThrow('Invalid log frame');
  });

  it('accepts a retained window of exactly 5 MiB', () => {
    const text = 'x'.repeat(MAX_LOG_CHUNK_UTF8_BYTES);
    const chunkCount = MAX_LOG_RETAINED_BYTES / MAX_LOG_CHUNK_UTF8_BYTES;
    const chunks = Array.from({ length: chunkCount }, (_, index) => chunk(index + 1, text));
    const parsed = parseLogServerFrame(
      { type: 'log.replay', chunks, window: windowFromChunks(chunks) },
      CONTEXT,
    );
    expect(parsed.type).toBe('log.replay');
    if (parsed.type === 'log.replay') {
      expect(parsed.window.retainedBytes).toBe(MAX_LOG_RETAINED_BYTES);
      expect(parsed.chunks).toHaveLength(chunkCount);
    }
  });

  it('rejects an oversized chunk above 64 KiB UTF-8', () => {
    const item = chunk(1, 'x'.repeat(MAX_LOG_CHUNK_UTF8_BYTES + 1));
    expect(() =>
      parseLogServerFrame(
        { type: 'log.append', chunk: item, window: windowFromChunks([item]) },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it('rejects mismatched project or run context', () => {
    expect(() =>
      parseLogServerFrame({ type: 'run.state', run: RUNNING }, { projectId: 'prj-1', runId: parseRunId('run-other') }),
    ).toThrow('Invalid log frame');
    expect(() =>
      parseLogServerFrame(
        { type: 'run.state', run: RUNNING, projectId: 'prj-other' },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
    expect(() =>
      parseLogServerFrame(
        {
          type: 'log.append',
          chunk: chunk(1, 'a'),
          window: windowFromChunks([chunk(1, 'a')]),
          runId: 'run-other',
        },
        CONTEXT,
      ),
    ).toThrow('Invalid log frame');
  });

  it.each([
    ['unknown type', { type: 'log.metrics' }],
    ['terminal frame', { type: 'terminal.exit', exitCode: 0 }],
    ['malformed json object', { type: 'log.complete' }],
    ['non-object', 'log.append'],
    ['unknown error code', { type: 'stream.error', code: 'BOOM', retryable: false }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseLogServerFrame(payload, CONTEXT)).toThrow('Invalid log frame');
  });

  it('parses JSON frames and rejects invalid or oversized JSON', () => {
    const item = chunk(1, 'ok');
    const frame = { type: 'log.append', chunk: item, window: windowFromChunks([item]) };
    expect(parseLogServerFrameJson(JSON.stringify(frame), CONTEXT)).toEqual(frame);
    expect(() => parseLogServerFrameJson('{', CONTEXT)).toThrow('Invalid log frame');
    expect(() =>
      parseLogServerFrameJson('x'.repeat(MAX_LOG_FRAME_UTF8_BYTES + 1), CONTEXT),
    ).toThrow('Invalid log frame');
  });

  it('parses JSON for a full 5 MiB retained-window replay', () => {
    const text = 'x'.repeat(MAX_LOG_CHUNK_UTF8_BYTES);
    const chunkCount = MAX_LOG_RETAINED_BYTES / MAX_LOG_CHUNK_UTF8_BYTES;
    const chunks = Array.from({ length: chunkCount }, (_, index) => chunk(index + 1, text));
    const frame = { type: 'log.replay', chunks, window: windowFromChunks(chunks) };
    const json = JSON.stringify(frame);
    expect(utf8Bytes(json)).toBeGreaterThan(MAX_LOG_RETAINED_BYTES);
    expect(utf8Bytes(json)).toBeLessThanOrEqual(MAX_LOG_FRAME_UTF8_BYTES);
    const parsed = parseLogServerFrameJson(json, CONTEXT);
    expect(parsed.type).toBe('log.replay');
    if (parsed.type === 'log.replay') {
      expect(parsed.window.retainedBytes).toBe(MAX_LOG_RETAINED_BYTES);
      expect(parsed.chunks).toHaveLength(chunkCount);
    }
  });
});
