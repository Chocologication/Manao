package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

class RunLogIngestorTest {

    @Test
    void ensureWatchAttachesOncePerRunAgainstTheInternalNamespace() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new EmptyChunkStore()), "manao");

        ingestor.ensureWatch("r1", "pod-1");
        ingestor.ensureWatch("r1", "pod-1");
        ingestor.ensureWatch("r2", "pod-2");

        assertThat(gateway.watchedPods).containsExactly("pod-1", "pod-2");
        assertThat(gateway.namespaces).containsExactly("manao", "manao");
    }

    @Test
    void blankPodNameNeverAttaches() {
        RecordingGateway gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway, new RunLogService(new EmptyChunkStore()), "manao");

        ingestor.ensureWatch("r1", null);
        ingestor.ensureWatch("r1", "   ");

        assertThat(gateway.watchedPods).isEmpty();
    }

    static final class RecordingGateway implements PodLogGateway {
        final List<String> watchedPods = new ArrayList<>();
        final List<String> namespaces = new ArrayList<>();

        @Override public LogWatchHandle watchLogs(String namespace, String podName, java.util.function.Consumer<String> lineConsumer) {
            watchedPods.add(podName);
            namespaces.add(namespace);
            return () -> { };
        }
    }

    static final class EmptyChunkStore implements RunLogService.ChunkStore {
        @Override public void insertChunk(String runId, RunLogWindow.Chunk chunk) { }
        @Override public List<RunLogWindow.Chunk> loadChunks(String runId) { return List.of(); }
        @Override public void deleteBefore(String runId, long seqExclusive) { }
        @Override public OptionalLong lastSeq(String runId) { return OptionalLong.empty(); }
    }
}
