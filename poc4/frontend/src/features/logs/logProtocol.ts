import {
  parseLogClientFrame,
  parseLogServerFrameJson,
  type LogChunk,
  type LogParseContext,
  type LogStreamErrorCode,
  type LogWindowMeta,
} from '../../contracts/log';
import type { RunSummary } from '../../contracts/run';

export const LOG_WS_PATH = '/api/v1/ws/run-logs';
export const LOG_HEARTBEAT_WATCHDOG_MS = 30_000;
export const LOG_RECONNECT_BACKOFF_MS = [0, 500, 1_000, 2_000, 5_000] as const;

export const LOG_WS_CLOSE_CODE = {
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  TICKET_EXPIRED: 4408,
  TICKET_USED: 4409,
  SERVER_FAILURE: 1011,
} as const;

export type LogProtocolCursor = {
  lastAppliedSeq: number | null;
  generation: number;
};

export type LogCloseAction = 'unauthenticated' | 'forbidden' | 'retry' | 'stop';

export type LogProtocolDecision =
  | { kind: 'stale' }
  | { kind: 'invalid' }
  | { kind: 'duplicate' }
  | { kind: 'gap' }
  | { kind: 'heartbeat'; serverTime: string }
  | { kind: 'complete'; lastSeq: number | null }
  | { kind: 'run-state'; run: RunSummary }
  | { kind: 'error'; code: LogStreamErrorCode; retryable: boolean }
  | { kind: 'apply'; chunks: LogChunk[]; window: LogWindowMeta; lastAppliedSeq: number | null };

export function encodeLogSubscribe(lastSeq: number | null): string {
  return JSON.stringify(parseLogClientFrame({ type: 'log.subscribe', lastSeq }));
}

export function reconnectDelayMs(
  attempt: number,
  options: { jitter?: boolean; random?: () => number } = {},
): number {
  const lastIndex = LOG_RECONNECT_BACKOFF_MS.length - 1;
  const index = Math.min(Math.max(attempt, 0), lastIndex);
  const base = LOG_RECONNECT_BACKOFF_MS[index] ?? 5_000;
  if (options.jitter === false || base === 0) {
    return base;
  }
  const random = options.random ?? Math.random;
  return Math.round(base * (0.5 + random()));
}

export function interpretCloseCode(
  code: number,
  _reason?: string,
  options: { streamComplete?: boolean } = {},
): LogCloseAction {
  if (code === LOG_WS_CLOSE_CODE.UNAUTHENTICATED) {
    return 'unauthenticated';
  }
  if (code === LOG_WS_CLOSE_CODE.FORBIDDEN) {
    return 'forbidden';
  }
  if (code === 1000 && options.streamComplete === true) {
    return 'stop';
  }
  return 'retry';
}

function newChunksAfterCursor(chunks: readonly LogChunk[], lastAppliedSeq: number | null): LogChunk[] {
  if (lastAppliedSeq === null) {
    return [...chunks];
  }
  return chunks.filter((item) => item.seq > lastAppliedSeq);
}

function hasValidTruncationProof(
  lastAppliedSeq: number | null,
  nextSeq: number,
  window: LogWindowMeta,
): boolean {
  if (lastAppliedSeq === null) {
    return window.firstAvailableSeq === nextSeq;
  }
  if (nextSeq === lastAppliedSeq + 1) {
    return true;
  }
  return (
    window.truncated === true &&
    window.firstAvailableSeq !== null &&
    window.firstAvailableSeq > lastAppliedSeq &&
    nextSeq === window.firstAvailableSeq
  );
}

function decideChunkSequence(
  chunks: readonly LogChunk[],
  window: LogWindowMeta,
  lastAppliedSeq: number | null,
): Extract<LogProtocolDecision, { kind: 'apply' | 'duplicate' | 'gap' }> {
  const fresh = newChunksAfterCursor(chunks, lastAppliedSeq);
  if (fresh.length === 0) {
    if (chunks.length > 0 && lastAppliedSeq !== null) {
      return { kind: 'duplicate' };
    }
    return { kind: 'apply', chunks: [], window, lastAppliedSeq };
  }
  const nextSeq = fresh[0]?.seq;
  if (nextSeq === undefined || !hasValidTruncationProof(lastAppliedSeq, nextSeq, window)) {
    return { kind: 'gap' };
  }
  const lastChunkSeq = fresh[fresh.length - 1]?.seq;
  return {
    kind: 'apply',
    chunks: fresh,
    window,
    lastAppliedSeq: lastChunkSeq ?? lastAppliedSeq,
  };
}

export function interpretLogServerJson(
  text: string,
  context: LogParseContext,
  options: LogProtocolCursor & { frameGeneration: number },
): LogProtocolDecision {
  if (options.frameGeneration !== options.generation) {
    return { kind: 'stale' };
  }
  try {
    const frame = parseLogServerFrameJson(text, context);
    if (frame.type === 'stream.heartbeat') {
      return { kind: 'heartbeat', serverTime: frame.serverTime };
    }
    if (frame.type === 'log.complete') {
      return { kind: 'complete', lastSeq: frame.lastSeq };
    }
    if (frame.type === 'run.state') {
      return { kind: 'run-state', run: frame.run };
    }
    if (frame.type === 'stream.error') {
      return { kind: 'error', code: frame.code, retryable: frame.retryable };
    }
    if (frame.type === 'log.replay') {
      return decideChunkSequence(frame.chunks, frame.window, options.lastAppliedSeq);
    }
    const appendDecision = decideChunkSequence([frame.chunk], frame.window, options.lastAppliedSeq);
    if (appendDecision.kind === 'apply' && appendDecision.chunks.length === 0) {
      return { kind: 'duplicate' };
    }
    return appendDecision;
  } catch {
    return { kind: 'invalid' };
  }
}
