import { parseIsoTimestamp, parseRunSummary, type RunId, type RunSummary } from './run';

export const MAX_LOG_RETAINED_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_CHUNK_UTF8_BYTES = 64 * 1024;
const MAX_LOG_FRAME_JSON_OVERHEAD_BYTES = 256 * 1024;
export const MAX_LOG_FRAME_UTF8_BYTES = MAX_LOG_RETAINED_BYTES + MAX_LOG_FRAME_JSON_OVERHEAD_BYTES;

export type LogParseContext = {
  projectId: string;
  runId: RunId;
};

export type LogChunk = {
  seq: number;
  text: string;
  byteLength: number;
  persistedAt: string;
};

export type LogWindowMeta = {
  firstAvailableSeq: number | null;
  lastAvailableSeq: number | null;
  retainedBytes: number;
  truncated: boolean;
  evictedBytes: number;
};

export type LogClientFrame = {
  type: 'log.subscribe';
  lastSeq: number | null;
};

export type LogStreamErrorCode =
  | 'TICKET_EXPIRED'
  | 'TICKET_USED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RUN_NOT_FOUND'
  | 'PROTOCOL_ERROR'
  | 'STREAM_UNAVAILABLE';

export type LogServerFrame =
  | { type: 'log.replay'; chunks: LogChunk[]; window: LogWindowMeta }
  | { type: 'log.append'; chunk: LogChunk; window: LogWindowMeta }
  | { type: 'run.state'; run: RunSummary }
  | { type: 'log.complete'; lastSeq: number | null }
  | { type: 'stream.heartbeat'; serverTime: string }
  | { type: 'stream.error'; code: LogStreamErrorCode; retryable: boolean };

const INVALID_LOG_FRAME = 'Invalid log frame';
const encoder = new TextEncoder();
const LOG_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  'TICKET_EXPIRED',
  'TICKET_USED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RUN_NOT_FOUND',
  'PROTOCOL_ERROR',
  'STREAM_UNAVAILABLE',
]);

function invalidLogFrame(): never {
  throw new Error(INVALID_LOG_FRAME);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidLogFrame();
  }
  return value as Record<string, unknown>;
}

function parsePositiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalidLogFrame();
  }
  return value;
}

function parseNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidLogFrame();
  }
  return value;
}

function parseNullablePositiveSeq(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return parsePositiveSafeInteger(value);
}

function parseIso(value: unknown): string {
  try {
    return parseIsoTimestamp(value);
  } catch {
    invalidLogFrame();
  }
}

function bindContext(record: Record<string, unknown>, context: LogParseContext): void {
  if (typeof context.projectId !== 'string' || context.projectId === '') {
    invalidLogFrame();
  }
  if (typeof context.runId !== 'string' || context.runId === '') {
    invalidLogFrame();
  }
  if ('projectId' in record && record.projectId !== context.projectId) {
    invalidLogFrame();
  }
  if ('runId' in record && record.runId !== context.runId) {
    invalidLogFrame();
  }
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function parseLogChunk(value: unknown): LogChunk {
  const record = asRecord(value);
  const seq = parsePositiveSafeInteger(record.seq);
  if (typeof record.text !== 'string') {
    invalidLogFrame();
  }
  const byteLength = parseNonNegativeSafeInteger(record.byteLength);
  const encodedLength = utf8ByteLength(record.text);
  if (encodedLength !== byteLength || encodedLength > MAX_LOG_CHUNK_UTF8_BYTES) {
    invalidLogFrame();
  }
  return {
    seq,
    text: record.text,
    byteLength,
    persistedAt: parseIso(record.persistedAt),
  };
}

function parseWindowSeqBound(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return parsePositiveSafeInteger(value);
}

export function parseLogWindowMeta(
  value: unknown,
  options: { chunks?: LogChunk[]; appendChunk?: LogChunk } = {},
): LogWindowMeta {
  const record = asRecord(value);
  if (typeof record.truncated !== 'boolean') {
    invalidLogFrame();
  }
  const evictedBytes = parseNonNegativeSafeInteger(record.evictedBytes);
  if (!record.truncated && evictedBytes !== 0) {
    invalidLogFrame();
  }
  const retainedBytes = parseNonNegativeSafeInteger(record.retainedBytes);
  if (retainedBytes > MAX_LOG_RETAINED_BYTES) {
    invalidLogFrame();
  }
  const firstAvailableSeq = parseWindowSeqBound(record.firstAvailableSeq);
  const lastAvailableSeq = parseWindowSeqBound(record.lastAvailableSeq);
  if (firstAvailableSeq === null || lastAvailableSeq === null) {
    if (firstAvailableSeq !== lastAvailableSeq) {
      invalidLogFrame();
    }
    if (retainedBytes !== 0) {
      invalidLogFrame();
    }
    if ((options.chunks !== undefined && options.chunks.length > 0) || options.appendChunk !== undefined) {
      invalidLogFrame();
    }
    return {
      firstAvailableSeq: null,
      lastAvailableSeq: null,
      retainedBytes,
      truncated: record.truncated,
      evictedBytes,
    };
  }
  if (firstAvailableSeq > lastAvailableSeq) {
    invalidLogFrame();
  }
  if (options.chunks !== undefined && options.chunks.length > 0) {
    const firstChunkSeq = options.chunks[0]?.seq;
    const lastChunkSeq = options.chunks[options.chunks.length - 1]?.seq;
    if (
      firstChunkSeq === undefined ||
      lastChunkSeq === undefined ||
      firstChunkSeq < firstAvailableSeq ||
      lastChunkSeq > lastAvailableSeq ||
      lastChunkSeq !== lastAvailableSeq
    ) {
      invalidLogFrame();
    }
    const sum = options.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (sum > retainedBytes) {
      invalidLogFrame();
    }
    if (firstChunkSeq === firstAvailableSeq && sum !== retainedBytes) {
      invalidLogFrame();
    }
  }
  if (options.appendChunk !== undefined) {
    if (options.appendChunk.seq < firstAvailableSeq || options.appendChunk.seq > lastAvailableSeq) {
      invalidLogFrame();
    }
    if (firstAvailableSeq === lastAvailableSeq && retainedBytes !== options.appendChunk.byteLength) {
      invalidLogFrame();
    }
  }
  return {
    firstAvailableSeq,
    lastAvailableSeq,
    retainedBytes,
    truncated: record.truncated,
    evictedBytes,
  };
}

function parseReplayChunks(value: unknown): LogChunk[] {
  if (!Array.isArray(value)) {
    invalidLogFrame();
  }
  const chunks = value.map(parseLogChunk);
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    if (previous === undefined || current === undefined || current.seq !== previous.seq + 1) {
      invalidLogFrame();
    }
  }
  return chunks;
}

function parseRunStateFrame(value: unknown, context: LogParseContext): RunSummary {
  try {
    const run = parseRunSummary(value);
    if (run.id !== context.runId) {
      invalidLogFrame();
    }
    return run;
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_LOG_FRAME) {
      throw error;
    }
    invalidLogFrame();
  }
}

function parseStreamErrorCode(value: unknown): LogStreamErrorCode {
  if (typeof value !== 'string' || !LOG_STREAM_ERROR_CODES.has(value)) {
    invalidLogFrame();
  }
  return value as LogStreamErrorCode;
}

export function parseLogClientFrame(value: unknown): LogClientFrame {
  const record = asRecord(value);
  if (record.type !== 'log.subscribe') {
    invalidLogFrame();
  }
  return { type: 'log.subscribe', lastSeq: parseNullablePositiveSeq(record.lastSeq) };
}

export function parseLogServerFrame(value: unknown, context: LogParseContext): LogServerFrame {
  const record = asRecord(value);
  bindContext(record, context);
  if (record.type === 'log.replay') {
    const chunks = parseReplayChunks(record.chunks);
    return { type: 'log.replay', chunks, window: parseLogWindowMeta(record.window, { chunks }) };
  }
  if (record.type === 'log.append') {
    const chunk = parseLogChunk(record.chunk);
    return { type: 'log.append', chunk, window: parseLogWindowMeta(record.window, { appendChunk: chunk }) };
  }
  if (record.type === 'run.state') {
    return { type: 'run.state', run: parseRunStateFrame(record.run, context) };
  }
  if (record.type === 'log.complete') {
    return { type: 'log.complete', lastSeq: parseNullablePositiveSeq(record.lastSeq) };
  }
  if (record.type === 'stream.heartbeat') {
    return { type: 'stream.heartbeat', serverTime: parseIso(record.serverTime) };
  }
  if (record.type === 'stream.error') {
    if (typeof record.retryable !== 'boolean') {
      invalidLogFrame();
    }
    return {
      type: 'stream.error',
      code: parseStreamErrorCode(record.code),
      retryable: record.retryable,
    };
  }
  invalidLogFrame();
}

export function parseLogServerFrameJson(text: string, context: LogParseContext): LogServerFrame {
  if (typeof text !== 'string' || utf8ByteLength(text) > MAX_LOG_FRAME_UTF8_BYTES) {
    invalidLogFrame();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalidLogFrame();
  }
  return parseLogServerFrame(parsed, context);
}
