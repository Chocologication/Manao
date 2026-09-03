package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;

class WorkspacePortForwardManagerTest {
    @Test
    void allocatesDistinctLoopbackPortsPerProjectWithinTheBoundedRange() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);

        int portA = manager.allocate("prj-a");
        int portB = manager.allocate("prj-b");
        int portC = manager.allocate("prj-c");

        assertThat(portA).isBetween(18100, 18199);
        assertThat(portB).isBetween(18100, 18199).isNotEqualTo(portA);
        assertThat(portC).isNotEqualTo(portA).isNotEqualTo(portB);
        // Same project is idempotent: one bridge per project with refcount semantics.
        assertThat(manager.allocate("prj-a")).isEqualTo(portA);
        assertThat(factory.started).hasSize(3);
    }

    @Test
    void endpointIsLoopbackOnlyWithServerDerivedServiceNames() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");

        var endpoint = manager.endpoint("prj-a");
        assertThat(endpoint.getHost()).isEqualTo("127.0.0.1");
        assertThat(endpoint.getPort()).isEqualTo(port);
        // The service name is server-derived; browser input can never influence the target.
        assertThat(factory.started.get(0).serviceName()).isEqualTo("manao-ws-prj-a");
        assertThat(factory.started.get(0).localPort()).isEqualTo(port);
        assertThatThrownBy(() -> manager.endpoint("unknown-project"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> manager.endpoint("../etc/passwd"))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void childProcessExitIsDetectedAndTheOriginalMappingIsRecreated() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");

        factory.processes.get("manao-ws-prj-a:" + port).fail();
        manager.checkChildren();

        assertThat(factory.started).hasSize(2);
        assertThat(factory.started.get(1).localPort()).isEqualTo(port);
        assertThat(factory.started.get(1).serviceName()).isEqualTo("manao-ws-prj-a");
    }

    @Test
    void releaseIsRefcountedAndKillsOnlyOnTheLastReference() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        manager.retain("prj-a"); // second consumer holds its own reference
        assertThat(manager.references("prj-a")).isEqualTo(2);

        manager.release("prj-a");
        assertThat(manager.references("prj-a")).isEqualTo(1);
        assertThat(manager.endpoint("prj-a").getPort()).isEqualTo(port);

        manager.release("prj-a");
        assertThat(manager.references("prj-a")).isZero();
        assertThatThrownBy(() -> manager.endpoint("prj-a")).isInstanceOf(IllegalArgumentException.class);
        assertThat(factory.killed).hasSize(1);
    }

    @Test
    void shutdownKillsAllChildrenAndReleasesPorts() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        manager.allocate("prj-a");
        manager.allocate("prj-b");

        manager.shutdown();

        assertThat(factory.killed).hasSize(2);
        assertThat(manager.activeBridges()).isZero();
        // After shutdown the port is free again for a fresh allocation.
        assertThat(manager.allocate("prj-a")).isBetween(18100, 18199);
    }

    @Test
    void rangeExhaustionFailsClosed() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18101, factory);
        manager.allocate("prj-a");
        manager.allocate("prj-b");
        assertThatThrownBy(() -> manager.allocate("prj-c"))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aliveButNonListeningProcessIsDetectedAndRecreated() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).stopListening();

        manager.checkChildren();

        assertThat(factory.started).hasSize(2);
        assertThat(factory.started.get(1).localPort()).isEqualTo(port);
        assertThat(factory.started.get(1).serviceName()).isEqualTo("manao-ws-prj-a");
    }

    @Test
    void allocateRecreatesABridgeWhoseListenerWasLost() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).stopListening();

        assertThat(manager.allocate("prj-a")).isEqualTo(port);
        assertThat(factory.started).hasSize(2);
    }

    @Test
    void supervisedModeUsesDeterministicPortsAndKeepsOneBridgePerProject() {
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, null);
        int port = manager.allocate("prj-a");
        assertThat(port).isBetween(18100, 18199);
        WorkspacePortForwardManager second = new WorkspacePortForwardManager("manao-test", 18100, 18199, null);
        assertThat(second.allocate("prj-a")).isEqualTo(port);
        manager.checkChildren();
        assertThat(manager.activeBridges()).isEqualTo(1);
        manager.shutdown();
        assertThat(manager.activeBridges()).isZero();
    }

    static final class RecordingFactory implements WorkspacePortForwardManager.PortForwardProcessFactory {
        record Start(String serviceName, int servicePort, int localPort) { }
        final List<Start> started = new ArrayList<>();
        final Map<String, FakeProcess> processes = new ConcurrentHashMap<>();
        final List<String> killed = new ArrayList<>();

        @Override public WorkspacePortForwardManager.PortForwardProcess start(String namespace, String serviceName,
                                                                              int servicePort, int localPort) {
            started.add(new Start(serviceName, servicePort, localPort));
            FakeProcess process = new FakeProcess(() -> killed.add(serviceName));
            processes.put(serviceName + ":" + localPort, process);
            return process;
        }
    }

    static final class FakeProcess implements WorkspacePortForwardManager.PortForwardProcess {
        private final Runnable onKill;
        private volatile boolean alive = true;
        private volatile boolean listening = true;
        FakeProcess(Runnable onKill) { this.onKill = onKill; }
        void fail() { alive = false; }
        void stopListening() { listening = false; }
        @Override public boolean isAlive() { return alive; }
        @Override public boolean isListening() { return listening; }
        @Override public void kill() {
            if (alive) onKill.run();
            alive = false;
        }
    }
}
