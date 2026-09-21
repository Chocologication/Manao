package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.log.PodLogGateway;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunControllerTest.FakeRun;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunControllerTest.RecordingEndpoints;
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
    private static final Instant READY = Instant.parse("2026-09-21T10:05:00Z");
    private static final Instant EXPIRES = READY.plusSeconds(7200);

    private FakeRunStore store;
    private StubCoordinator coordinator;
    private RecordingGateway gateway;
    private RecordingEndpoints endpoints;
    private RunObservationService service;
    private final java.util.List<String> completed = new ArrayList<>();

    @BeforeEach
    void setUp() {
        store = new FakeRunStore();
        coordinator = new StubCoordinator();
        gateway = new RecordingGateway();
        endpoints = new RecordingEndpoints();
        RunLogIngestor ingestor = new RunLogIngestor(gateway,
            new RunLogService(new EmptyChunkStore()), "manao");
        completed.clear();
        service = new RunObservationService(store, coordinator, ingestor, completed::add, endpoints);
    }

    private String seedRun(String id, RunState state) {
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state,
            "{}", "manao-run-" + id, null, null, null, null, null, 1L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L)));
        return id;
    }

    private String seedServiceRun(String id, RunState state) {
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state,
            RunControllerTest.servicePolicy().toJson(), "manao-run-" + id, null, null, null, null, null, 1L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L)));
        return id;
    }

    private static JobCoordinator.JobFacts facts(boolean running, boolean succeeded, boolean failed,
                                                 boolean deadlineExceeded, Integer exitCode, String podName,
                                                 String podUid, boolean ready, boolean terminated) {
        return new JobCoordinator.JobFacts(running, succeeded, failed, deadlineExceeded, exitCode,
            podName, podUid, ready, terminated);
    }

    @Test
    void startingRunBecomesRunningWhenTheApplicationContainerIsUp() {
        String runId = seedRun("run-starting", RunState.STARTING);
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-1", "uid-1", false, false));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get(runId).startedAt).isNotNull();
    }

    @Test
    void terminalJobFactsSettleTheRun() {
        String runId = seedRun("run-done", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(false, true, false, false, 0, "pod-1", "uid-1", false, true));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.SUCCEEDED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("BUILD_SUCCEEDED");
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void failedJobSettlesWithNonZeroExitCodeAndDoesNotRemainActive() {
        String runId = seedRun("run-failed", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(false, false, true, false, 17, "pod-failed", "uid-1", false, true));

        service.observe();
        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("BUILD_FAILED");
        assertThat(store.runs.get(runId).exitCode).isEqualTo(17);
        assertThat(store.findActiveRun(PROJECT)).isEmpty();
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void deadlineExceededClassifiesBeforeAnOrdinaryJobFailure() {
        String runId = seedRun("run-deadline", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(false, false, true, true, 143, "pod-1", "uid-1", false, true));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.TIMED_OUT.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("TIME_LIMIT_EXCEEDED");
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void webApplicationThatExitsWithZeroStillFailsAsApplicationExited() {
        String runId = seedServiceRun("run-web-exit0", RunState.RUNNING);
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(false, true, false, false, 0, "pod-web", "uid-web", false, true),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
                + "\npodUid=uid-web\nstate=EXITED\nreason=APPLICATION_EXITED\n")));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("APPLICATION_EXITED");
        assertThat(store.runs.get(runId).exitCode).isZero();
        assertThat(store.findActiveRun(PROJECT)).isEmpty();
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void webStartupTimeoutSettlesAsStartupTimeLimitExceeded() {
        String runId = seedServiceRun("run-web-startup", RunState.STARTING);
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(false, false, true, false, 126, "pod-web", "uid-web", false, true),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
                + "\npodUid=uid-web\nstate=STARTUP_TIMED_OUT\nreason=STARTUP_TIME_LIMIT_EXCEEDED\n")));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.TIMED_OUT.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("STARTUP_TIME_LIMIT_EXCEEDED");
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void webLifetimeExpirySettlesAsTimeLimitExceeded() {
        String runId = seedServiceRun("run-web-expiry", RunState.RUNNING);
        store.runs.get(runId).firstReadyAt = READY;
        store.runs.get(runId).expiresAt = EXPIRES;
        store.runs.get(runId).executionPodUid = "uid-web";
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(false, false, true, false, 124, "pod-web", "uid-web", false, true),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
                + "\npodUid=uid-web\nstate=TIMED_OUT\nfirstReadyAt=2026-09-21T10:05:00Z\n"
                + "expiresAt=2026-09-21T12:05:00Z\nreason=TIME_LIMIT_EXCEEDED\n")));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.TIMED_OUT.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("TIME_LIMIT_EXCEEDED");
        assertThat(store.runs.get(runId).firstReadyAt).isEqualTo(READY);
        assertThat(store.runs.get(runId).expiresAt).isEqualTo(EXPIRES);
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void readyServiceReceiptRecordsTheFixedLifetimeOnceAndRoutesTheClaimedPod() {
        String runId = seedServiceRun("run-web-ready", RunState.RUNNING);
        String receipt = "protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
            + "\npodUid=uid-web\nstate=READY\nfirstReadyAt=2026-09-21T10:05:00Z\n"
            + "expiresAt=2026-09-21T12:05:00Z\nreason=\n";
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(true, false, false, false, null, "pod-web", "uid-web", true, false),
            RunExecutionReceipt.parse(receipt)));

        service.observe();
        service.observe();

        assertThat(store.runs.get(runId).firstReadyAt).isEqualTo(READY);
        assertThat(store.runs.get(runId).expiresAt).isEqualTo(EXPIRES);
        assertThat(store.runs.get(runId).executionPodUid).isEqualTo("uid-web");
        // The lifetime is recorded exactly once; every scan re-asserts the same routing.
        assertThat(store.recordFirstReadyCalls).containsExactly(runId);
        assertThat(endpoints.routed).isNotEmpty()
            .allSatisfy(route -> assertThat(route).isEqualTo(PROJECT + "|" + runId + "|uid-web"));
    }

    @Test
    void repeatedReadyReceiptsNeverMoveTheRecordedLifetime() {
        String runId = seedServiceRun("run-web-repeat", RunState.RUNNING);
        String receipt = "protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
            + "\npodUid=uid-web\nstate=READY\nfirstReadyAt=2026-09-21T10:05:00Z\n"
            + "expiresAt=2026-09-21T12:05:00Z\nreason=\n";
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(true, false, false, false, null, "pod-web", "uid-web", true, false),
            RunExecutionReceipt.parse(receipt)));

        service.observe();
        Instant firstReady = store.runs.get(runId).firstReadyAt;
        Instant firstExpires = store.runs.get(runId).expiresAt;
        service.observe();
        service.observe();

        assertThat(store.runs.get(runId).firstReadyAt).isEqualTo(firstReady).isEqualTo(READY);
        assertThat(store.runs.get(runId).expiresAt).isEqualTo(firstExpires).isEqualTo(EXPIRES);
        assertThat(Duration.between(store.runs.get(runId).firstReadyAt, store.runs.get(runId).expiresAt))
            .isEqualTo(Duration.ofSeconds(7200));
    }

    @Test
    void aWebRunWhoseClaimWasDeniedByAReplacementPodIsNeverSettledFromTheDenial() {
        // The claimed pod keeps running; a replacement container reported DENIED somewhere else.
        // Observation only ever sees the claimed pod's facts and never settles from DENIED.
        String runId = seedServiceRun("run-web-denied", RunState.RUNNING);
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(true, false, false, false, null, "pod-web", "uid-web", false, false),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
                + "\npodUid=uid-web\nstate=DENIED\nreason=RUN_ALREADY_CLAIMED\n")));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.findActiveRun(PROJECT)).isPresent();
        assertThat(completed).isEmpty();
    }

    @Test
    void theLogSourceNeverSwitchesToAReplacementPod() {
        RecordingGateway directGateway = new RecordingGateway();
        RunLogIngestor ingestor = new RunLogIngestor(directGateway,
            new RunLogService(new EmptyChunkStore()), "manao");
        RunObservationService bound = new RunObservationService(store, coordinator, ingestor,
            completed::add, endpoints);
        String runId = seedServiceRun("run-web-logs", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-web", "uid-web", false, false));
        bound.observe();
        assertThat(directGateway.watchedPods).containsExactly("pod-web");

        // A denied replacement Pod tries to attach (as it never could through observation):
        // the source stays bound to the claimed pod.
        ingestor.ensureWatch(runId, "pod-replacement", "uid-other");
        ingestor.ensureWatch(runId, "pod-replacement", null);
        bound.observe();

        assertThat(directGateway.watchedPods).containsExactly("pod-web");
        assertThat(store.runs.get(runId).podRef).isEqualTo("pod-web");
    }

    @Test
    void stoppingRunSettlesCancelledOnlyWhenJobAndPodsAreGone() {
        String runId = seedServiceRun("run-web-stopping", RunState.STOPPING);
        // While the Job delete still propagates, the run keeps its STOPPING lock.
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-web", "uid-web", false, false));
        service.observe();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.STOPPING.name());

        // Job gone and no active matching pods: the stop is confirmed complete.
        coordinator.factsByRun.remove(runId);
        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.MISSING);
        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.CANCELLED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("USER_STOPPED");
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void stoppingRunWithAnExpiredApplicationSettlesTimedOutFromTheReceipt() {
        String runId = seedServiceRun("run-web-stop-timeout", RunState.STOPPING);
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(false, false, true, false, 124, "pod-web", "uid-web", false, true),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=" + runId
                + "\npodUid=uid-web\nstate=TIMED_OUT\nfirstReadyAt=2026-09-21T10:05:00Z\n"
                + "expiresAt=2026-09-21T12:05:00Z\nreason=TIME_LIMIT_EXCEEDED\n")));

        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.TIMED_OUT.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("TIME_LIMIT_EXCEEDED");
    }

    @Test
    void identityMismatchAndUnknownKeepTheRunExactlyWhereItIs() {
        String runId = seedRun("run-mismatch", RunState.RUNNING);
        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.IDENTITY_MISMATCH);
        service.observe();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(completed).isEmpty();

        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.UNKNOWN);
        service.observe();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(gateway.watchedPods).isEmpty();
    }

    @Test
    void terminalSettlementFinishesTheLogWatchAfterTheLastPersist() {
        String runId = seedRun("run-live-complete", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-1", "uid-1", false, false));
        service.observe();
        assertThat(gateway.watchedPods).containsExactly("pod-1");

        coordinator.factsByRun.put(runId, facts(false, true, false, false, 0, "pod-1", "uid-1", false, true));
        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.SUCCEEDED.name());
        assertThat(completed).containsExactly(runId);
        assertThat(gateway.closedPods).containsExactly("pod-1");
    }

    @Test
    void attachesLogWatchAndPersistsPodRefWhenRunIsRunning() {
        String runId = seedRun("run-live", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "manao-run-1-abcde", "uid-1", false, false));

        service.observe();

        assertThat(gateway.watchedPods).containsExactly("manao-run-1-abcde");
        assertThat(gateway.containers).containsExactly("maven");
        assertThat(gateway.namespaces).containsExactly("manao");
        assertThat(store.runs.get(runId).podRef).isEqualTo("manao-run-1-abcde");
    }

    @Test
    void deletingProjectDoesNotAttachALateWatch() {
        String runId = seedRun("run-deleting", RunState.RUNNING);
        store.projects.put(PROJECT, "DELETING");
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-late", "uid-1", false, false));

        service.observe();

        assertThat(gateway.watchedPods).isEmpty();
        assertThat(store.runs.get(runId).podRef).isNull();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
    }

    @Test
    void withoutTheLeaseNothingIsWritten() {
        String runId = seedRun("run-live", RunState.RUNNING);
        coordinator.factsByRun.put(runId, facts(false, true, false, false, 0, "pod-1", "uid-1", false, true));
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

    @Test
    void uncertainKubernetesWriteOutcomeRecoversByJobIdentityInsteadOfASecondExecution() {
        store.projects.put(PROJECT, "READY");
        store.projectOwners.put(PROJECT, "alice-id");
        store.revision.put(PROJECT, 12L);
        coordinator.ensureJobFailure = new IllegalStateException("write timeout");
        coordinator.fallbackKind = JobCoordinator.ObservationKind.FOUND;
        RunService runService = new RunService(store, coordinator, RunControllerTest.policy());
        RunController controller = new RunController(runService);
        try {
            controller.start(RunControllerTest.auth("alice-id"), PROJECT, new RunController.StartRunRequest("12"));
            throw new AssertionError("expected ApiException");
        } catch (ApiException expected) {
            assertThat(expected.status()).isEqualTo(503);
        }
        // The apply may have landed despite the timeout: the identity check must say FOUND.
        String runId = store.runs.keySet().iterator().next();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RECOVERING.name());
        coordinator.observationsByRun.put(runId, new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            facts(true, false, false, false, null, "pod-1", "uid-1", false, false), null));

        service.observe();

        // The one execution is adopted as live, never recreated or settled as start-failed.
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get(runId).startedAt).isNotNull();
        assertThat(coordinator.ensureJobCalls).isEmpty();
    }

    @Test
    void aRecoveringRunWithAStopIntentSettlesCancelledInsteadOfStartFailedWhenTheJobIsGone() {
        String runId = seedServiceRun("run-web-rec-gone", RunState.STOPPING);
        store.runs.get(runId).terminationIntent = "USER_STOPPED";
        // The recovery scan runs while the cluster cannot be judged and leaves the run RECOVERING.
        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.UNKNOWN);
        new com.manao.poc4.run.RunRecoveryService(store, coordinator).recoverRuns();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RECOVERING.name());

        // Observation takes over and finds the run definitively gone.
        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.MISSING);
        service.observe();

        assertThat(store.runs.get(runId).state).isEqualTo(RunState.CANCELLED.name());
        assertThat(store.runs.get(runId).terminationReason).isEqualTo("USER_STOPPED");
        assertThat(completed).containsExactly(runId);
    }

    @Test
    void aRecoveringRunWithAStopIntentIsReStoppedInsteadOfResurrectedToRunning() {
        String runId = seedServiceRun("run-web-rec-live", RunState.STOPPING);
        store.runs.get(runId).terminationIntent = "USER_STOPPED";
        coordinator.observationKinds.put(runId, JobCoordinator.ObservationKind.UNKNOWN);
        new com.manao.poc4.run.RunRecoveryService(store, coordinator).recoverRuns();
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.RECOVERING.name());

        // The application container is still running when observation takes over.
        coordinator.observationKinds.remove(runId);
        coordinator.factsByRun.put(runId, facts(true, false, false, false, null, "pod-web", "uid-web", false, false));
        int stopCallsBefore = coordinator.stopCalls.size();

        service.observe();

        // The stop is re-driven; the run returns to STOPPING and is never resurrected to RUNNING.
        assertThat(store.runs.get(runId).state).isEqualTo(RunState.STOPPING.name());
        assertThat(store.runs.get(runId).terminationIntent).isEqualTo("USER_STOPPED");
        assertThat(coordinator.stopCalls).hasSize(stopCallsBefore + 1);
        assertThat(completed).isEmpty();
    }

    static final class RecordingGateway implements PodLogGateway {
        final List<String> watchedPods = new ArrayList<>();
        final List<String> containers = new ArrayList<>();
        final List<String> namespaces = new ArrayList<>();
        final List<String> closedPods = new ArrayList<>();

        @Override public LogWatchHandle watchLogs(String namespace, String podName, String container,
                                                  java.util.function.Consumer<String> lineConsumer) {
            watchedPods.add(podName);
            containers.add(container);
            namespaces.add(namespace);
            return new LogWatchHandle() {
                @Override public void close() { closedPods.add(podName); }

                @Override public boolean isAlive() { return true; }
            };
        }
    }

    static final class EmptyChunkStore implements RunLogService.ChunkStore {
        @Override public void insertChunk(String runId, RunLogWindow.Chunk chunk) { }
        @Override public List<RunLogWindow.Chunk> loadChunks(String runId) { return List.of(); }
        @Override public void deleteBefore(String runId, long seqExclusive) { }
        @Override public OptionalLong lastSeq(String runId) { return OptionalLong.empty(); }
    }
}
