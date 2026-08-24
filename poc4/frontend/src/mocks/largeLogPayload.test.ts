import { describe, expect, it } from 'vitest';
import { MAX_LOG_CHUNK_UTF8_BYTES, MAX_LOG_RETAINED_BYTES } from '../contracts/log';
import {
  LARGE_LOG_CHUNK_INDEX_PREFIX,
  LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS,
  LARGE_LOG_EVICTED_EARLY_MARKER,
  LARGE_LOG_HEAD_MARKER,
  LARGE_LOG_LATEST_MARKER,
  LARGE_LOG_MIN_GENERATED_BYTES,
  createLargeLogChunks,
  utf8ByteLength,
} from './largeLogPayload';

describe('createLargeLogChunks', () => {
  it('emits real UTF-8 bytes over 6 MiB in unique <=64 KiB chunks with head/evicted/latest markers', () => {
    const chunks = createLargeLogChunks();
    expect(chunks.length).toBeGreaterThan(LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS);
    expect(LARGE_LOG_MIN_GENERATED_BYTES).toBe(MAX_LOG_RETAINED_BYTES + 1024 * 1024);

    let total = 0;
    const indexes = new Set<string>();
    for (const [index, text] of chunks.entries()) {
      expect(typeof text).toBe('string');
      const bytes = utf8ByteLength(text);
      expect(bytes).toBe(text.length);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(MAX_LOG_CHUNK_UTF8_BYTES);
      total += bytes;
      const marker = `${LARGE_LOG_CHUNK_INDEX_PREFIX}${String(index).padStart(6, '0')}`;
      expect(text.startsWith(`${marker}\n`)).toBe(true);
      expect(indexes.has(marker)).toBe(false);
      indexes.add(marker);
    }

    expect(total).toBeGreaterThanOrEqual(LARGE_LOG_MIN_GENERATED_BYTES);
    expect(chunks[0]).toContain(LARGE_LOG_HEAD_MARKER);
    expect(chunks[1]).toContain(LARGE_LOG_EVICTED_EARLY_MARKER);
    expect(chunks[chunks.length - 1]).toContain(LARGE_LOG_LATEST_MARKER);
    expect(chunks[0]).not.toContain(LARGE_LOG_LATEST_MARKER);
    expect(chunks[chunks.length - 1]).not.toContain(LARGE_LOG_HEAD_MARKER);
    expect(chunks[chunks.length - 1]).not.toContain(LARGE_LOG_EVICTED_EARLY_MARKER);
    expect(chunks.slice(2, -1).some((text) => text.includes(LARGE_LOG_HEAD_MARKER))).toBe(false);
  });
});
