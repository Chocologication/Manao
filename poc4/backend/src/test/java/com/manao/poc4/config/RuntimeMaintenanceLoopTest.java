package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunControllerTest.FakeRun;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunControllerTest.StubCoordinator;
import com.manao.poc4.run.RunObservationService;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunRecoveryService;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;

class RuntimeMaintenanceLoopTest {
    @Test
    void recurringRecoveryLeavesHealthyRunsForTheObservationLoop() {
        var store = seededStore();
        var coordinator = new StubCoordinator();
        coordinator.factsByRun.put("run-live", new JobCoordinator.JobFacts(
            true, false, false, false, null, null, null, false, false));
        var loop = loop(store, coordinator);
        loop.recoverRuns();
        long recoveredVersion = store.findRun("run-live").orElseThrow().version();

        coordinator.observationKinds.put("run-live", JobCoordinator.ObservationKind.UNKNOWN);
        loop.recoverRuns();
        assertThat(store.findRun("run-live").orElseThrow().state()).isEqualTo(RunState.RUNNING);
        assertThat(store.findRun("run-live").orElseThrow().version()).isEqualTo(recoveredVersion);

        coordinator.observationKinds.clear();
        coordinator.factsByRun.put("run-live", new JobCoordinator.JobFacts(
            false, true, false, false, 0, null, null, false, true));
        loop.observeRuns();
        assertThat(store.findRun("run-live").orElseThrow().state()).isEqualTo(RunState.SUCCEEDED);
    }

    @Test
    void failedInitializationIsRetriedByTheNextMaintenanceTick() {
        var store = org.mockito.Mockito.spy(seededStore());
        org.mockito.Mockito.doThrow(new IllegalStateException("snapshot temporarily unavailable"))
            .doCallRealMethod().when(store).findRunsInState(RunState.STARTING, RunState.RUNNING, RunState.STOPPING);
        var coordinator = new StubCoordinator();
        coordinator.observationKinds.put("run-live", JobCoordinator.ObservationKind.UNKNOWN);
        var loop = loop(store, coordinator);

        loop.recoverRuns();
        assertThat(store.findRun("run-live").orElseThrow().state()).isEqualTo(RunState.RUNNING);
        loop.recoverRuns();
        assertThat(store.findRun("run-live").orElseThrow().state()).isEqualTo(RunState.RECOVERING);
        coordinator.observationKinds.clear();
        loop.recoverRuns();
        assertThat(store.findRun("run-live").orElseThrow().state()).isEqualTo(RunState.FAILED);
    }

    private FakeRunStore seededStore() {
        var store = new FakeRunStore();
        store.runs.put("run-live", new FakeRun(new RunRecord("run-live", "project-1", 0, RunState.RUNNING,
            "{}", "manao-run-live", null, null, null, null, null, 7L,
            Instant.parse("2026-10-25T00:00:00Z"), 0L)));
        return store;
    }

    private RuntimeMaintenanceLoop loop(FakeRunStore store, StubCoordinator coordinator) {
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("runRecovery", new RunRecoveryService(store, coordinator));
        beans.registerSingleton("runObservation", new RunObservationService(store, coordinator,
            org.mockito.Mockito.mock(RunLogIngestor.class)));
        return new RuntimeMaintenanceLoop(beans.getBeanProvider(RunObservationService.class),
            beans.getBeanProvider(RunRecoveryService.class),
            beans.getBeanProvider(com.manao.poc4.recovery.ProjectRecoveryService.class),
            beans.getBeanProvider(com.manao.poc4.audit.RetentionCleanupJob.class),
            beans.getBeanProvider(com.manao.poc4.kubernetes.WorkspacePortForwardManager.class),
            beans.getBeanProvider(RunLogIngestor.class),
            beans.getBeanProvider(com.manao.poc4.terminal.TerminalWebSocketHandler.class));
    }
}
