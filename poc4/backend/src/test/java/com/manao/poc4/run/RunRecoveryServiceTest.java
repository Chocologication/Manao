package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunControllerTest.FakeRun;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunControllerTest.StubCoordinator;
import java.time.Instant;
import java.util.List;
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

    private void seedRun(String id, RunState state, String terminationIntent) {
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state,
            "{}", "manao-run-" + id, null, null, null, null, null, 3L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L, null, null, null, terminationIntent)));
    }

    /** A python-fastapi-web service snapshot, as RunService persists it for a Python web project. */
    private void seedPythonServiceRun(String id, RunState state) {
        seedPythonServiceRun(id, state, null);
    }

    private void seedPythonServiceRun(String id, RunState state, String terminationIntent) {
        RunPolicy base = new RunPolicy(com.manao.poc4.project.RuntimeTemplate.JAVA_CONSOLE.id(),
            new RunPolicy.RuntimeInfo.Java(17, 3),
            com.manao.poc4.project.RuntimeTemplate.JAVA_CONSOLE.displayCommand(), 1800,
            RunPolicy.EXECUTION_KIND_TASK, 1800, 0,
            new RunPolicy.Resources(1000, 1L << 30, 1L << 30),
            new RunPolicy.Resources(8000, 16L << 30, 10L << 30));
        String policyJson = base.forProject(new com.manao.poc4.project.ProjectRuntimeSpec(
            com.manao.poc4.project.RuntimeTemplate.PYTHON_FASTAPI_WEB.id(), false, false,
            List.of())).toJson();
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state, policyJson,
            "manao-run-" + id, null, null, null, null, null, 3L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L, null, null, null, terminationIntent)));
    }

    /** A python-console task snapshot. */
    private void seedPythonTaskRun(String id, RunState state) {
        RunPolicy base = new RunPolicy(com.manao.poc4.project.RuntimeTemplate.JAVA_CONSOLE.id(),
            new RunPolicy.RuntimeInfo.Java(17, 3),
            com.manao.poc4.project.RuntimeTemplate.JAVA_CONSOLE.displayCommand(), 1800,
            RunPolicy.EXECUTION_KIND_TASK, 1800, 0,
            new RunPolicy.Resources(1000, 1L << 30, 1L << 30),
            new RunPolicy.Resources(8000, 16L << 30, 10L << 30));
        String policyJson = base.forProject(new com.manao.poc4.project.ProjectRuntimeSpec(
            com.manao.poc4.project.RuntimeTemplate.PYTHON_CONSOLE.id(), false, false,
            List.of())).toJson();
        store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 5, state, policyJson,
            "manao-run-" + id, null, null, null, null, null, 3L,
            Instant.parse("2026-08-29T11:00:00Z"), 0L)));
    }

    private static JobCoordinator.JobFacts facts(boolean running, boolean succeeded, boolean failed,
                                                 boolean deadlineExceeded, Integer exitCode) {
        return new JobCoordinator.JobFacts(running, succeeded, failed, deadlineExceeded, exitCode,
            null, null, false, running == false && (succeeded || failed || deadlineExceeded));
    }

    @Test
    void settlesRecoveredRunsFromJobFacts() {
        seedRun("run-success", RunState.RUNNING);
        seedRun("run-failed", RunState.STARTING);
        seedRun("run-timeout", RunState.STOPPING);
        coordinator.factsByRun.put("run-success", facts(false, true, false, false, 0));
        coordinator.factsByRun.put("run-failed", facts(false, false, true, false, 1));
        coordinator.factsByRun.put("run-timeout", facts(false, false, false, true, null));

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
        coordinator.factsByRun.put("run-live", facts(true, false, false, false, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.resumed()).containsExactly("run-live");
        assertThat(store.runs.get("run-live").state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get("run-live").terminationReason).isNull();
    }

    @Test
    void missingJobFailsClosedForRunsWithoutAStopIntent() {
        seedRun("run-orphan", RunState.RUNNING);

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.failedClosed()).containsExactly("run-orphan");
        assertThat(store.runs.get("run-orphan").state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get("run-orphan").terminationReason).isEqualTo("RECOVERY_FAILED");
    }

    @Test
    void aStopIntentSurvivesTheRestartAndIsNeverResurrectedIntoRunning() {
        seedRun("run-stopping", RunState.STOPPING, "USER_STOPPED");
        // The application container is still running when the backend comes back.
        coordinator.factsByRun.put("run-stopping", facts(true, false, false, false, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        // The stop is re-driven (Job delete re-issued), the run returns to STOPPING and the
        // observation loop settles it; it is never resumed into RUNNING.
        assertThat(store.runs.get("run-stopping").state).isEqualTo(RunState.STOPPING.name());
        assertThat(store.runs.get("run-stopping").terminationIntent).isEqualTo("USER_STOPPED");
        assertThat(coordinator.stopCalls).containsExactly("manao-run-run-stopping");
        assertThat(report.resumed()).isEmpty();
        assertThat(report.settled()).isEmpty();
    }

    @Test
    void aPersistedStopIntentSettlesCancelledWhenTheJobIsGone() {
        seedRun("run-stopped", RunState.STOPPING, "USER_STOPPED");
        coordinator.observationKinds.put("run-stopped", JobCoordinator.ObservationKind.MISSING);

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).containsExactly("run-stopped");
        assertThat(store.runs.get("run-stopped").state).isEqualTo(RunState.CANCELLED.name());
        assertThat(store.runs.get("run-stopped").terminationReason).isEqualTo("USER_STOPPED");
    }

    @Test
    void unknownOrForbiddenObservationsKeepTheRunRecovering() {
        seedRun("run-unknown", RunState.RUNNING);
        seedRun("run-mismatch", RunState.RUNNING);
        coordinator.observationKinds.put("run-unknown", JobCoordinator.ObservationKind.UNKNOWN);
        coordinator.observationKinds.put("run-mismatch", JobCoordinator.ObservationKind.IDENTITY_MISMATCH);

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).isEmpty();
        assertThat(report.resumed()).isEmpty();
        assertThat(report.failedClosed()).isEmpty();
        assertThat(store.runs.get("run-unknown").state).isEqualTo(RunState.RECOVERING.name());
        assertThat(store.runs.get("run-mismatch").state).isEqualTo(RunState.RECOVERING.name());
    }

    @Test
    void aWebApplicationThatExitedCleanlyStillFailsAfterRecovery() {
        seedRun("run-web", RunState.RUNNING);
        store.runs.get("run-web").policyJson = RunControllerTest.servicePolicy().toJson();
        coordinator.observationsByRun.put("run-web", new JobCoordinator.JobObservation(
            JobCoordinator.ObservationKind.FOUND,
            new JobCoordinator.JobFacts(false, true, false, false, 0, "pod-web", "uid-web", false, true),
            RunExecutionReceipt.parse("protocol=1\nprojectId=" + PROJECT + "\nrunId=run-web"
                + "\npodUid=uid-web\nstate=EXITED\nreason=APPLICATION_EXITED\n")));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).containsExactly("run-web");
        assertThat(store.runs.get("run-web").state).isEqualTo(RunState.FAILED.name());
        assertThat(store.runs.get("run-web").terminationReason).isEqualTo("APPLICATION_EXITED");
    }

    @Test
    void aPythonServiceRunResumesRunningWithoutRebuildingTheExecution() {
        seedPythonServiceRun("run-py-live", RunState.RUNNING, null);
        coordinator.factsByRun.put("run-py-live", facts(true, false, false, false, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        // RUNNING recovery only re-arms observation: no Job is recreated and nothing is settled.
        assertThat(report.resumed()).containsExactly("run-py-live");
        assertThat(store.runs.get("run-py-live").state).isEqualTo(RunState.RUNNING.name());
        assertThat(store.runs.get("run-py-live").terminationReason).isNull();
        assertThat(coordinator.stopCalls).isEmpty();
        assertThat(coordinator.ensureJobCalls).isEmpty();
    }

    @Test
    void aPythonTaskRunSettlesFromTerminalJobFactsAndUnlocksTheProject() {
        seedPythonTaskRun("run-py-task", RunState.RUNNING);
        coordinator.factsByRun.put("run-py-task", facts(false, true, false, false, 0));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).containsExactly("run-py-task");
        assertThat(store.runs.get("run-py-task").state).isEqualTo(RunState.SUCCEEDED.name());
        assertThat(store.runs.get("run-py-task").exitCode).isZero();
    }

    @Test
    void aPythonStopIntentSurvivesTheRestartAndIsNeverResurrectedIntoRunning() {
        seedPythonServiceRun("run-py-stop", RunState.STOPPING, "USER_STOPPED");
        coordinator.factsByRun.put("run-py-stop", facts(true, false, false, false, null));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(store.runs.get("run-py-stop").state).isEqualTo(RunState.STOPPING.name());
        assertThat(store.runs.get("run-py-stop").terminationIntent).isEqualTo("USER_STOPPED");
        assertThat(coordinator.stopCalls).containsExactly("manao-run-run-py-stop");
        assertThat(report.resumed()).isEmpty();
        assertThat(report.settled()).isEmpty();
    }

    @Test
    void deletingProjectIsNotRecoveredOrSettled() {
        seedRun("run-deleting", RunState.RUNNING);
        store.projects.put(PROJECT, "DELETING");
        coordinator.factsByRun.put("run-deleting", facts(false, true, false, false, 0));

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
        coordinator.factsByRun.put("run-unclear",
            new JobCoordinator.JobFacts(false, false, false, false, null, null, null, false, false));

        RunRecoveryService.RecoveryReport report = service.recoverRuns();

        assertThat(report.settled()).isEmpty();
        assertThat(report.resumed()).isEmpty();
        assertThat(report.failedClosed()).isEmpty();
        assertThat(store.runs.get("run-unclear").state).isEqualTo(RunState.RECOVERING.name());
    }
}
