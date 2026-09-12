package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.run.RunControllerTest.FakeRun;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunControllerTest.StubCoordinator;
import com.manao.poc4.persistence.RunState;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RunRecoveryServiceTest {
    private static final String PROJECT = "prj-1";

    private FakeRunStore store;
    private StubCoordinator coordinator;
    private RunRecoveryService service;

    @BeforeEach
    void setUp() {
        store = new FakeRunStore();
        coordinator = new StubCoordinator();
        service = new RunRecoveryService(store, coordinator);
    }

    private void seedRun(String id, RunState state) {
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state,
            "{}", "manao-run-" + id, null, null, null, null, null, 3L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L)));
    }

    @Test
    void settlesRecoveredRunsFromJobFacts() {
        seedRun("run-success", RunState.RUNNING);
        seedRun("run-failed", RunState.STARTING);
        seedRun("run-timeout", RunState.STOPPING);
        coordinator.factsByRun.put("run-success", new JobCoordinator.JobFacts(false, true, false, false, 0, null));
        coordinator.factsByRun.put("run-failed", new JobCoordinator.JobFacts(false, false, true, false, 1, null));
        coordinator.factsByRun.put("run-timeout", new JobCoordinator.JobFacts(false, false, false, true, null, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).containsExactlyInAnyOrder("run-success", "run-failed", "run-timeout");
        assertThat(store.runs.get("run-success").state).isEqualTo(RunState.SUCCEEDED.name());
        assertThat(store.runs.get("run-success").terminationReason).isEqualTo("BUILD_SUCCEEDED");
        assertThat(store.runs.get("run-success").exitCode).isZero();
        assertThat(store.runs.get("run-failed").state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get("run-failed").terminationReason).isEqualTo("BUILD_FAILED");
        assertThat(store.runs.get("run-timeout").state).isEqualTo(RunState.TIMED_OUT.name());
        assertThat(store.runs.get("run-timeout").terminationReason).isEqualTo("TIME_LIMIT_EXCEEDED");
        assertThat(report.resumed()).isEmpty();
    }

    @Test
    void runningJobResumesAsRunningAfterRecovery() {
        seedRun("run-live", RunState.RUNNING);
        coordinator.factsByRun.put("run-live", new JobCoordinator.JobFacts(true, false, false, false, null, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.resumed()).containsExactly("run-live");
        assertThat(store.runs.get("run-live").state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get("run-live").terminationReason).isNull();
    }

    @Test
    void missingOrMismatchedJobFailsClosed() {
        seedRun("run-orphan", RunState.RUNNING);

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.failedClosed()).containsExactly("run-orphan");
        assertThat(store.runs.get("run-orphan").state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get("run-orphan").terminationReason).isEqualTo("RECOVERY_FAILED");
    }

    @Test
    void deletingProjectIsNotRecoveredOrSettled() {
        seedRun("run-deleting", RunState.RUNNING);
        store.projects.put(PROJECT, "DELETING");
        coordinator.factsByRun.put("run-deleting", new JobCoordinator.JobFacts(false, true, false, false, 0, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.processed()).isEmpty();
        assertThat(report.settled()).isEmpty();
        assertThat(store.runs.get("run-deleting").state).isEqualTo(RunState.RUNNING.name());
    }

    @Test
    void terminalRunsAreNeverTouched() {
        seedRun("run-done", RunState.SUCCEEDED);

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.processed()).isEmpty();
        assertThat(store.runs.get("run-done").state).isEqualTo(RunState.SUCCEEDED.name());
    }

    @Test
    void inconclusiveJobFactsKeepTheRunRecovering() {
        seedRun("run-unclear", RunState.STOPPING);
        coordinator.factsByRun.put("run-unclear", new JobCoordinator.JobFacts(false, false, false, false, null, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).isEmpty();
        assertThat(report.resumed()).isEmpty();
        assertThat(report.failedClosed()).isEmpty();
        assertThat(store.runs.get("run-unclear").state).isEqualTo(RunState.RECOVERING.name());
    }
}
