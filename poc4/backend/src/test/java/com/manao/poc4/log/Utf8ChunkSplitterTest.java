package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class Utf8ChunkSplitterTest {

    @Test
    void splitsAsciiExactly() {
        assertThat(Utf8ChunkSplitter.split("a".repeat(100), 64))
            .containsExactly("a".repeat(64), "a".repeat(36));
    }

    @Test
    void neverSplitsMultibyteCodePoints() {
        String line = "中".repeat(100); // 3 bytes each
        for (String piece : Utf8ChunkSplitter.split(line, 64)) {
            assertThat(piece.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(64);
            assertThat(piece).doesNotEndWith("\uFFFD");
        }
    }

    @Test
    void neverSplitsSurrogatePairs() {
        String line = "😀".repeat(50); // 4 bytes each
        for (String piece : Utf8ChunkSplitter.split(line, 64)) {
            assertThat(piece.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(64);
            assertThat(piece.length() % 2).isZero();
        }
    }

    @Test
    void keepsNewlinesInsidePieces() {
        assertThat(Utf8ChunkSplitter.split("ab\nc", 3)).containsExactly("ab\n", "c");
    }
}
