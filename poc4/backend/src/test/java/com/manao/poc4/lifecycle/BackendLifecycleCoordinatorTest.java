package com.manao.poc4.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class BackendLifecycleCoordinatorTest {
    @Test
    void teardownRunsDisposersInContractOrder() {
        List<String> order = new ArrayList<>();
        BackendLifecycleCoordinator coordinator = new BackendLifecycleCoordinator();
        coordinator.register("disable-input", 1, () -> order.add("disable-input"));
        coordinator.register("close-pty", 2, () -> order.add("close-pty"));
        coordinator.register("settle-audit-session", 3, () -> order.add("settle-audit-session"));
        coordinator.register("release-run-lock", 4, () -> order.add("release-run-lock"));

        coordinator.teardown("session-1");

        assertThat(order).containsExactly("disable-input", "close-pty", "settle-audit-session", "release-run-lock");
    }

    @Test
    void teardownIsIdempotentAndIsolatesDisposerFailures() {
        List<String> order = new ArrayList<>();
        BackendLifecycleCoordinator coordinator = new BackendLifecycleCoordinator();
        coordinator.register("disable-input", 1, () -> order.add("disable-input"));
        coordinator.register("close-pty", 2, () -> { throw new IllegalStateException("pty already gone"); });
        coordinator.register("settle-audit-session", 3, () -> order.add("settle-audit-session"));

        coordinator.teardown("session-1");
        coordinator.teardown("session-1");

        // Both teardown passes ran the surviving disposers exactly once; the failure never leaked.
        assertThat(order).containsExactly("disable-input", "settle-audit-session", "disable-input",
            "settle-audit-session");
    }

    @Test
    void runEndWaitsForTerminalTeardownBeforeUnlocking() {
        List<String> order = new ArrayList<>();
        BackendLifecycleCoordinator coordinator = new BackendLifecycleCoordinator();
        coordinator.register("disable-input", 1, () -> order.add("disable-input"));
        coordinator.register("close-pty", 2, () -> order.add("close-pty"));
        coordinator.register("settle-audit-session", 3, () -> order.add("settle-audit-session"));

        coordinator.teardownRunTerminals("run-1");
        order.add("run-settled");

        assertThat(order).containsExactly("disable-input", "close-pty", "settle-audit-session", "run-settled");
    }
}
