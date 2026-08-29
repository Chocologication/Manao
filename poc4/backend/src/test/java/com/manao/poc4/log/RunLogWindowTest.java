package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

class RunLogWindowTest {
    private static String repeat(char c, int count) {
        return String.valueOf(c).repeat(Math.max(0, count));
    }

    @Test
    void appendAssignsMonotonicPositiveSeqsAndTracksWindowMeta() {
        RunLogWindow window = new RunLogWindow();
        RunLogWindow.AppendResult first = window.append(1, "line one\n");
        RunLogWindow.AppendResult second = window.append(2, "line two\n");

        assertThat(first.chunk().seq()).isEqualTo(1);
        assertThat(second.chunk().seq()).isEqualTo(2);
        RunLogWindow.WindowMeta meta = window.meta();
        assertThat(meta.firstAvailableSeq()).isEqualTo(1);
        assertThat(meta.lastAvailableSeq()).isEqualTo(2);
        assertThat(meta.retainedBytes()).isEqualTo("line one\n".getBytes(StandardCharsets.UTF_8).length
            + "line two\n".getBytes(StandardCharsets.UTF_8).length);
        assertThat(meta.truncated()).isFalse();
        assertThat(meta.evictedBytes()).isZero();
    }

    @Test
    void byteLengthReflectsUtf8NotCharacters() {
        RunLogWindow window = new RunLogWindow();
        String unicode = "é中\u00e9"; // 2 + 3 + 2 UTF-8 bytes
        RunLogWindow.AppendResult result = window.append(1, unicode);
        assertThat(result.chunk().byteLength()).isEqualTo(unicode.getBytes(StandardCharsets.UTF_8).length);
        assertThat(result.chunk().byteLength()).isNotEqualTo(unicode.length());
    }

    @Test
    void rejectsDuplicateAndOutOfOrderSeqs() {
        RunLogWindow window = new RunLogWindow();
        window.append(1, "one\n");
        assertThatThrownBy(() -> window.append(1, "dup\n")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> window.append(3, "skip\n")).isInstanceOf(IllegalArgumentException.class);
        assertThat(window.append(2, "two\n").chunk().seq()).isEqualTo(2);
    }

    @Test
    void rejectsChunksBeyondTheUtf8Limit() {
        RunLogWindow window = new RunLogWindow();
        String tooLarge = repeat('a', RunLogWindow.MAX_CHUNK_BYTES + 1);
        assertThatThrownBy(() -> window.append(1, tooLarge)).isInstanceOf(IllegalArgumentException.class);
        window.append(1, repeat('a', RunLogWindow.MAX_CHUNK_BYTES));
        assertThat(window.meta().lastAvailableSeq()).isEqualTo(1);
    }

    @Test
    void evictsOldestChunksBeyondFiveMebibytesAndTracksEviction() {
        RunLogWindow window = new RunLogWindow();
        String chunk = repeat('a', 64 * 1024); // 64 KiB per chunk
        for (long seq = 1; seq <= 90; seq++) { // 90 * 64 KiB > 5 MiB
            window.append(seq, chunk);
        }
        RunLogWindow.WindowMeta meta = window.meta();
        assertThat(meta.retainedBytes()).isLessThanOrEqualTo(RunLogWindow.MAX_RETAINED_BYTES);
        assertThat(meta.truncated()).isTrue();
        assertThat(meta.evictedBytes()).isGreaterThan(0);
        long expectedEvicted = 90 * (64 * 1024L) - meta.retainedBytes();
        assertThat(meta.evictedBytes()).isEqualTo(expectedEvicted);
        List<RunLogWindow.Chunk> chunks = window.chunksAfter(0);
        assertThat(chunks.get(0).seq()).isEqualTo(meta.firstAvailableSeq());
        assertThat(chunks.get(chunks.size() - 1).seq()).isEqualTo(meta.lastAvailableSeq());
        // Eviction always removes from the oldest side.
        assertThat(meta.firstAvailableSeq()).isGreaterThan(1);
    }

    @Test
    void replayCursorDetectsGapDeduplicatesAndResumesAtFirstAvailableSeq() {
        RunLogWindow window = new RunLogWindow();
        for (long seq = 1; seq <= 90; seq++) {
            window.append(seq, repeat('a', 64 * 1024));
        }
        RunLogWindow.WindowMeta meta = window.meta();
        // Client far behind the window: replay resumes at firstAvailableSeq and reports the gap.
        LogReplayCursor.ReplayPlan plan = LogReplayCursor.plan(1L, meta);
        assertThat(plan.gap()).isTrue();
        assertThat(plan.startSeq()).isEqualTo(meta.firstAvailableSeq());
        // Client inside the window: replay starts after the last seen seq, no gap.
        LogReplayCursor.ReplayPlan inside = LogReplayCursor.plan(meta.firstAvailableSeq() + 5, meta);
        assertThat(inside.gap()).isFalse();
        assertThat(inside.startSeq()).isEqualTo(meta.firstAvailableSeq() + 5 + 1);
        // Client ahead of the window: nothing to replay.
        assertThat(LogReplayCursor.plan(meta.lastAvailableSeq() + 1, meta).startSeq()).isNull();
        // Dedup across reconnect/live overlap.
        LogReplayCursor cursor = LogReplayCursor.forConnection();
        assertThat(cursor.accept(7)).isTrue();
        assertThat(cursor.accept(7)).isFalse();
        assertThat(cursor.accept(6)).isFalse();
        assertThat(cursor.accept(8)).isTrue();
    }

    @Test
    void emptyWindowHasNullSeqBoundsAndZeroBytes() {
        RunLogWindow window = new RunLogWindow();
        RunLogWindow.WindowMeta meta = window.meta();
        assertThat(meta.firstAvailableSeq()).isNull();
        assertThat(meta.lastAvailableSeq()).isNull();
        assertThat(meta.retainedBytes()).isZero();
        assertThat(meta.truncated()).isFalse();
        assertThat(meta.evictedBytes()).isZero();
        assertThat(window.chunksAfter(0)).isEmpty();
    }
}
