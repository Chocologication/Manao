package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.log.PodLogGateway;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunControllerTest.StubCoordinator;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RunObservationServiceTest {
    private static final String PROJECT = "prj-1";

    private FakeRunStore store;
    private StubCoordinator coordinator;
    private RecordingGateway gateway;
    private RunObservationService service;

    @BeforeEach
    void setUp() {
        store = new FakeRunStore();
        coordinator = new StubCoordinator();
        gateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(gateway,
            new RunLogService(new EmptyChunkStore()), "manao");
        service = new RunObservationService(store, coordinator, ingestor);
    }

    private String seedRun(String id, RunState state) {
        store.runs.put(id, new RunControllerTest.FakeRun(new RunRecord(id, PROJECT, 5, state,
            "{}", "manao-run-" + id, null, null, null, null, null, 1L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L)));
        return id;
    }

    @Test
    void startingRunBecomesRunningWhenTheApplicationContainerIsUp() {
        String runId = seedRun("run-starting", RunState.STARTING);
        coordinator.factsByRun.put(runId, new JobCoordinator.JobFacts(true, false, false, false, null, "pod-1"));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get(runId).startedAt).isNotNull();
    }

    @Test
    void terminalJobFactsSettleTheRun() {
        String runId = seedRun("run-done", RunState.RUNNING);
        coordinator.factsByRun.put(runId, new JobCoordinator.JobFacts(false, true, false, false, 0, "pod-1"));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.SUCCEEDED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("BUILD_SUCCEEDED");
    }

    @Test
    void attachesLogWatchAndPersistsPodRefWhenRunIsRunning() {
        String runId = seedRun("run-live", RunState.RUNNING);
        coordinator.factsByRun.put(runId, new JobCoordinator.JobFacts(true, false, false, false, null, "manao-run-1-abcde"));

        service.observe();

        assertThat(gateway.watchedPods).containsExactly("manao-run-1-abcde");
        assertThat(gateway.namespaces).containsExactly("manao");
        assertThat(store.runs.get(runId).podRef).isEqualTo("manao-run-1-abcde");
    }

    @Test
    void withoutTheLeaseNothingIsWritten() {
        String runId = seedRun("run-live", RunState.RUNNING);
        coordinator.factsByRun.put(runId, new JobCoordinator.JobFacts(false, true, false, false, 0, "pod-1"));
        store.fencingToken = java.util.OptionalLong.empty();

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name()); // unchanged
    }

    @Test
    void startFailureSettlesTheRunAsStartFailedInsteadOfLocking() {
        store.projects.put(PROJECT, "READY");
        store.projectOwners.put(PROJECT, "alice-id");
        store.revision.put(PROJECT, 12L);
        coordinator.ensureJobFailure = new IllegalStateException("cluster unreachable");
        RunService runService = new RunService(store, coordinator, RunControllerTest.policy());
        RunController controller = new RunController(runService);

        try {
            controller.start(RunControllerTest.auth("alice-id"), PROJECT, new RunController.StartRunRequest("12"));
            throw new AssertionError("expected ApiException");
        } catch (ApiException expected) {
            assertThat(expected.status()).isEqualTo(503);
        }
        // The STARTING run must not keep the project locked.
        assertThat(store.runs.values().stream()
            .allMatch(run -> "FAILED".equals(run.state) && "START_FAILED".equals(run.terminationReason)))
            .isTrue();
        assertThat(store.findActiveRun(PROJECT)).isEmpty();
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
