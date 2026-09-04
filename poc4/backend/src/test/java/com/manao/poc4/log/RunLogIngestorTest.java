package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

class RunLogIngestorTest {

    @Test
    void ensureWatchAttachesOncePerRunAgainstTheInternalNamespace() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");

        ingestor.ensureWatch("r1", "pod-1");
        ingestor.ensureWatch("r1", "pod-1");
        ingestor.ensureWatch("r2", "pod-2");

        assertThat(gateway.watchedPods).containsExactly("pod-1", "pod-2");
        assertThat(gateway.namespaces).containsExactly("manao", "manao");
    }

    @Test
    void blankPodNameNeverAttaches() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");

        ingestor.ensureWatch("r1", null);
        ingestor.ensureWatch("r1", "   ");

        assertThat(gateway.watchedPods).isEmpty();
    }

    @Test
    void multibyteLongLineIsSplitIntoByteBoundedConsecutiveChunks() {
        RecordingGateway gateway = new RecordingGateway();
        RecordingChunkStore chunks = new RecordingChunkStore(0);
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(chunks), "manao");

        ingestor.ensureWatch("r1", "pod-1");
        String line = "中".repeat(30000); // 90,000 UTF-8 bytes
        gateway.consumer.accept(line);

        assertThat(chunks.inserted).hasSize(2);
        assertThat(chunks.inserted.get(0).seq()).isEqualTo(1);
        assertThat(chunks.inserted.get(1).seq()).isEqualTo(2);
        for (RecordingChunk chunk : chunks.inserted) {
            assertThat(chunk.text().getBytes(StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(RunLogWindow.MAX_CHUNK_BYTES);
        }
        assertThat(chunks.inserted.get(0).text() + chunks.inserted.get(1).text()).isEqualTo(line + "\n");
    }

    @Test
    void reattachSkipsPersistedChunksNotWholeLines() {
        RecordingGateway gateway = new RecordingGateway();
        RecordingChunkStore chunks = new RecordingChunkStore(3); // chunks 1..3 already persisted
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(chunks), "manao");

        ingestor.ensureWatch("r1", "pod-1");
        String first = "a".repeat(70000);        // 2 chunks (seqs 1-2)
        String second = "c".repeat(70000);       // 2 chunks (seqs 3-4): the first is already persisted
        gateway.consumer.accept(first);
        gateway.consumer.accept(second);

        String secondFirstPiece = Utf8ChunkSplitter.split(second, RunLogWindow.MAX_CHUNK_BYTES).get(0);
        assertThat(chunks.inserted).hasSize(1);
        assertThat(chunks.inserted.get(0).seq()).isEqualTo(4);
        assertThat(chunks.inserted.get(0).text()).isEqualTo(second.substring(secondFirstPiece.length()) + "\n");
    }

    @Test
    void finishClosesTheWatchSoTheLastBufferedLinesCanDrain() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");
        ingestor.ensureWatch("r1", "pod-1");
        ingestor.finish("r1");
        assertThat(gateway.closed).containsExactly("pod-1");
        ingestor.finish("r1");
        assertThat(gateway.closed).containsExactly("pod-1");
    }

    record RecordingChunk(long seq, String text) { }

    static final class RecordingGateway implements PodLogGateway {
        final List<String> watchedPods = new ArrayList<>();
        final List<String> namespaces = new ArrayList<>();
        final List<String> closed = new ArrayList<>();
        java.util.function.Consumer<String> consumer;

        @Override public LogWatchHandle watchLogs(String namespace, String podName, java.util.function.Consumer<String> lineConsumer) {
            watchedPods.add(podName);
            namespaces.add(namespace);
            this.consumer = lineConsumer;
            return () -> closed.add(podName);
        }
    }

    static final class RecordingChunkStore implements RunLogService.ChunkStore {
        final long lastSeq;
        final List<RecordingChunk> inserted = new ArrayList<>();

        RecordingChunkStore(long lastSeq) { this.lastSeq = lastSeq; }

        @Override public void insertChunk(String runId, RunLogWindow.Chunk chunk) {
            inserted.add(new RecordingChunk(chunk.seq(), chunk.text()));
        }
        @Override public List<RunLogWindow.Chunk> loadChunks(String runId) { return List.of(); }
        @Override public void deleteBefore(String runId, long seqExclusive) { }
        @Override public OptionalLong lastSeq(String runId) { return OptionalLong.of(lastSeq); }
    }
}
