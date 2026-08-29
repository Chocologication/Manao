package com.manao.poc4.log;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Per-Run log retention window: chunks are kept newest-first bounded to 5 MiB, eviction always
 * removes from the oldest side, and the cumulative evicted byte count is tracked for the
 * browser's truncated marker.
 */
public final class RunLogWindow {
    public static final long MAX_RETAINED_BYTES = 5L * 1024 * 1024;
    public static final int MAX_CHUNK_BYTES = 64 * 1024;

    private final ArrayDeque<Chunk> chunks = new ArrayDeque<>();
    private long retainedBytes;
    private long evictedBytes;
    private long lastSeq;

    public record Chunk(long seq, String text, int byteLength, Instant persistedAt) { }

    public record WindowMeta(Long firstAvailableSeq, Long lastAvailableSeq, long retainedBytes,
                             boolean truncated, long evictedBytes) { }

    public record AppendResult(Chunk chunk, WindowMeta meta) { }

    public synchronized AppendResult append(long seq, String text) {
        if (seq != lastSeq + 1) {
            throw new IllegalArgumentException("log seq must be exactly lastSeq + 1, got " + seq + " after " + lastSeq);
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException("log chunk exceeds the 64 KiB UTF-8 limit");
        }
        Chunk chunk = new Chunk(seq, text, bytes.length, Instant.now());
        chunks.addLast(chunk);
        retainedBytes += chunk.byteLength();
        lastSeq = seq;
        evictOldest();
        return new AppendResult(chunk, meta());
    }

    public synchronized WindowMeta meta() {
        Long first = chunks.isEmpty() ? null : chunks.peekFirst().seq();
        Long last = chunks.isEmpty() ? null : chunks.peekLast().seq();
        return new WindowMeta(first, last, retainedBytes, evictedBytes > 0, evictedBytes);
    }

    /** Chunks with seq strictly greater than the given value, ascending. */
    public synchronized List<Chunk> chunksAfter(long seqExclusive) {
        List<Chunk> result = new ArrayList<>();
        for (Chunk chunk : chunks) {
            if (chunk.seq() > seqExclusive) result.add(chunk);
        }
        return List.copyOf(result);
    }

    private void evictOldest() {
        while (retainedBytes > MAX_RETAINED_BYTES && chunks.size() > 1) {
            Chunk oldest = chunks.removeFirst();
            retainedBytes -= oldest.byteLength();
            evictedBytes += oldest.byteLength();
        }
    }
}
