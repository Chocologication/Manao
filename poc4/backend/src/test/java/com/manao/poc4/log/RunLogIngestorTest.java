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

        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        ingestor.ensureWatch("r2", "pod-2", "uid-2");

        assertThat(gateway.watchedPods).containsExactly("pod-1", "pod-2");
        assertThat(gateway.containers).containsExactly("maven", "maven");
        assertThat(gateway.namespaces).containsExactly("manao", "manao");
    }

    @Test
    void blankPodNameOrUidNeverAttaches() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");

        ingestor.ensureWatch("r1", null, "uid-1");
        ingestor.ensureWatch("r1", "   ", "uid-1");
        ingestor.ensureWatch("r1", "pod-1", null);
        ingestor.ensureWatch("r1", "pod-1", "  ");

        assertThat(gateway.watchedPods).isEmpty();
    }

    @Test
    void aRejectedReplacementPodNeverBecomesTheLogSource() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");

        ingestor.ensureWatch("r1", "pod-claimed", "uid-claimed");
        ingestor.ensureWatch("r1", "pod-replacement", "uid-replacement");
        ingestor.ensureWatch("r1", "pod-replacement", null);

        assertThat(gateway.watchedPods).containsExactly("pod-claimed");
    }

    @Test
    void multibyteLongLineIsSplitIntoByteBoundedConsecutiveChunks() {
        RecordingGateway gateway = new RecordingGateway();
        RecordingChunkStore chunks = new RecordingChunkStore(0);
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(chunks), "manao");

        ingestor.ensureWatch("r1", "pod-1", "uid-1");
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

        ingestor.ensureWatch("r1", "pod-1", "uid-1");
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
    void aLostWatchIsMarkedAsAnExplicitGapAndReconnectedToTheSameSourceOnly() {
        RecordingGateway gateway = new RecordingGateway();
        RecordingChunkStore chunks = new RecordingChunkStore(0);
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(chunks), "manao");

        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        gateway.consumer.accept("before the loss");
        gateway.latest().alive = false; // the pump died: lines emitted now are never delivered
        ingestor.ensureWatch("r1", "pod-1", "uid-1"); // the next observation scan

        // The gap is explicitly marked between the lost tail and the re-attached stream.
        var marker = chunks.inserted.stream()
            .filter(chunk -> chunk.text().contains("manao") && chunk.text().contains("lost")).findFirst();
        assertThat(marker).isPresent();
        assertThat(marker.get().seq()).isEqualTo(2);
        // The re-attach is the SAME source only; a replacement pod still never becomes the source.
        assertThat(gateway.watchedPods).containsExactly("pod-1", "pod-1");
        ingestor.ensureWatch("r1", "pod-replacement", "uid-replacement");
        assertThat(gateway.watchedPods).hasSize(2);
    }

    @Test
    void aNewLossAfterAReconnectMarksANewGapButAFailedReconnectDoesNotSpam() {
        RecordingGateway gateway = new RecordingGateway();
        RecordingChunkStore chunks = new RecordingChunkStore(0);
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(chunks), "manao");

        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        gateway.latest().alive = false;
        gateway.failNextAttach = true; // the re-attach itself fails (cluster unreachable)
        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        long markersAfterFailedReconnect = chunks.inserted.stream()
            .filter(chunk -> chunk.text().contains("lost")).count();
        assertThat(markersAfterFailedReconnect).isEqualTo(1);
        assertThat(gateway.watchedPods).containsExactly("pod-1"); // still the one dead watch

        ingestor.ensureWatch("r1", "pod-1", "uid-1"); // the transport recovers
        assertThat(gateway.watchedPods).containsExactly("pod-1", "pod-1");
        assertThat(chunks.inserted.stream().filter(chunk -> chunk.text().contains("lost")).count())
            .isEqualTo(1); // no duplicate marker for the same loss event

        gateway.latest().alive = false; // a new loss after a successful reconnect is a new gap
        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        long markersAfterNewLoss = chunks.inserted.stream()
            .filter(chunk -> chunk.text().contains("lost")).count();
        assertThat(markersAfterNewLoss).isEqualTo(2);
    }

    @Test
    void finishClosesTheWatchSoTheLastBufferedLinesCanDrain() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new RecordingChunkStore(0)), "manao");
        ingestor.ensureWatch("r1", "pod-1", "uid-1");
        ingestor.finish("r1");
        assertThat(gateway.closed).containsExactly("pod-1");
        ingestor.finish("r1");
        assertThat(gateway.closed).containsExactly("pod-1");
    }

    record RecordingChunk(long seq, String text) { }

    static final class RecordingGateway implements PodLogGateway {
        final List<String> watchedPods = new ArrayList<>();
        final List<String> containers = new ArrayList<>();
        final List<String> namespaces = new ArrayList<>();
        final List<String> closed = new ArrayList<>();
        final List<MutableHandle> handles = new ArrayList<>();
        java.util.function.Consumer<String> consumer;
        boolean failNextAttach;

        /** The most recently created watch, so tests can kill the current source. */
        MutableHandle latest() { return handles.get(handles.size() - 1); }

        @Override public LogWatchHandle watchLogs(String namespace, String podName, String container,
                                                  java.util.function.Consumer<String> lineConsumer) {
            if (failNextAttach) {
                failNextAttach = false;
                throw new IllegalStateException("cluster unreachable");
            }
            watchedPods.add(podName);
            containers.add(container);
            namespaces.add(namespace);
            this.consumer = lineConsumer;
            MutableHandle handle = new MutableHandle(podName, closed);
            handles.add(handle);
            return handle;
        }
    }

    static final class MutableHandle implements PodLogGateway.LogWatchHandle {
        final String podName;
        final List<String> closedLog;
        boolean alive = true;

        MutableHandle(String podName, List<String> closedLog) {
            this.podName = podName;
            this.closedLog = closedLog;
        }

        @Override public void close() { closedLog.add(podName); }

        @Override public boolean isAlive() { return alive; }
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
