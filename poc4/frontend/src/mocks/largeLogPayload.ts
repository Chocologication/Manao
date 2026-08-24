import { MAX_LOG_CHUNK_UTF8_BYTES, MAX_LOG_RETAINED_BYTES } from '../contracts/log';

const utf8 = new TextEncoder();

export const LARGE_LOG_HEAD_MARKER = 'ensoai-stage4-large-log-head';
export const LARGE_LOG_EVICTED_EARLY_MARKER = 'ensoai-stage4-large-log-evicted-early';
export const LARGE_LOG_LATEST_MARKER = 'ensoai-stage4-large-log-latest';
export const LARGE_LOG_CHUNK_INDEX_PREFIX = 'ensoai-stage4-large-log-chunk-';
export const LARGE_LOG_WHILE_DISCONNECTED_MARKER = 'ensoai-stage4-large-log-while-disconnected';
export const LARGE_LOG_WHILE_DISCONNECTED_TEXT = `${LARGE_LOG_WHILE_DISCONNECTED_MARKER}\n`;
export const LARGE_LOG_MIN_GENERATED_BYTES = MAX_LOG_RETAINED_BYTES + 1024 * 1024;
export const LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS = 16;

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

function chunkHeader(index: number, marker: string): string {
  const line = `${LARGE_LOG_CHUNK_INDEX_PREFIX}${String(index).padStart(6, '0')}\n`;
  if (marker.length === 0) {
    return line;
  }
  return `${line}${marker}\n`;
}

function fillChunk(header: string, size: number): string {
  if (header.length > size) {
    throw new Error('large-log chunk header exceeds 64 KiB');
  }
  if (header.length === size) {
    return header;
  }
  return `${header}${'x'.repeat(size - header.length)}`;
}

export function createLargeLogChunks(): string[] {
  const chunks: string[] = [];
  let produced = 0;

  const push = (marker: string, size: number): void => {
    const header = chunkHeader(chunks.length, marker);
    const text = fillChunk(header, size);
    chunks.push(text);
    produced += utf8ByteLength(text);
  };

  push(LARGE_LOG_HEAD_MARKER, MAX_LOG_CHUNK_UTF8_BYTES);
  push(LARGE_LOG_EVICTED_EARLY_MARKER, MAX_LOG_CHUNK_UTF8_BYTES);

  while (produced + MAX_LOG_CHUNK_UTF8_BYTES < LARGE_LOG_MIN_GENERATED_BYTES) {
    push('', MAX_LOG_CHUNK_UTF8_BYTES);
  }

  const latestHeader = chunkHeader(chunks.length, LARGE_LOG_LATEST_MARKER);
  const remaining = LARGE_LOG_MIN_GENERATED_BYTES - produced + 1;
  const lastSize = Math.min(
    MAX_LOG_CHUNK_UTF8_BYTES,
    Math.max(remaining, latestHeader.length),
  );
  push(LARGE_LOG_LATEST_MARKER, lastSize);

  return chunks;
}
