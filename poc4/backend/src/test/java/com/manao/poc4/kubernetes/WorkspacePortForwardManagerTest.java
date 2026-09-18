package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
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
        assertThat(factory.killed).containsExactly("manao-ws-prj-a");
    }

    @Test
    void allocateRecreatesABridgeWhoseListenerWasLost() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).stopListening();

        assertThat(manager.allocate("prj-a")).isEqualTo(port);
        assertThat(factory.started).hasSize(2);
        assertThat(factory.killed).containsExactly("manao-ws-prj-a");
    }

    @Test
    void isPortListeningReflectsRealLoopbackSocketLifecycle() throws Exception {
        // A free port in the manager range must report false; probe once for a false baseline so we
        // never collide with something already bound in this environment.
        int freePort = 18100;
        while (freePort <= 18199 && WorkspacePortForwardManager.isPortListening(freePort)) {
            freePort++;
        }
        assertThat(freePort).as("the 18100-18199 range must contain at least one free port").isLessThanOrEqualTo(18199);
        assertThat(WorkspacePortForwardManager.isPortListening(freePort)).as("a free port must not report listening").isFalse();

        // A genuinely bound loopback socket must report true, and close() must clear it. close() is
        // idempotent, so the try-with-resources close after our explicit close is a harmless no-op.
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int boundPort = server.getLocalPort();
            assertThat(WorkspacePortForwardManager.isPortListening(boundPort)).as("a bound loopback socket must report listening").isTrue();
            server.close();
            assertThat(WorkspacePortForwardManager.isPortListening(boundPort)).as("a closed socket must no longer report listening").isFalse();
        }
    }

    @Test
    void closeProjectKillsRegardlessOfRemainingReferences() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        manager.allocate("prj-a");
        manager.retain("prj-a");
        assertThat(manager.references("prj-a")).isEqualTo(2);

        manager.closeProject("prj-a");

        assertThat(manager.references("prj-a")).isZero();
        assertThat(factory.killed).containsExactly("manao-ws-prj-a");
        assertThatThrownBy(() -> manager.endpoint("prj-a")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void closeProjectRestoresTheHandleWhenKillFails() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).failKill = true;

        assertThatThrownBy(() -> manager.closeProject("prj-a")).isInstanceOf(IllegalStateException.class);
        assertThat(manager.endpoint("prj-a").getPort()).isEqualTo(port);
        assertThat(manager.references("prj-a")).isEqualTo(1);
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

    @Test
    void allocateWaitsUntilTheListenerIsReady() throws Exception {
        RecordingFactory factory = new RecordingFactory(false);
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager(
            "manao-test", 18100, 18199, 8080, factory, Duration.ofSeconds(2), 10);
        Thread releaser = new Thread(() -> {
            long deadline = System.currentTimeMillis() + 1500;
            while (factory.processes.isEmpty() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(5); } catch (InterruptedException ex) { Thread.currentThread().interrupt(); return; }
            }
            factory.processes.values().forEach(FakeProcess::startListening);
        });
        releaser.setDaemon(true);
        releaser.start();

        int port = manager.allocate("prj-a");
        assertThat(port).isBetween(18100, 18199);
        assertThat(factory.started).hasSize(1);
    }

    @Test
    void allocateFailsClosedWhenTheListenerNeverBecomesReady() {
        RecordingFactory factory = new RecordingFactory(false);
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager(
            "manao-test", 18100, 18199, 8080, factory, Duration.ofMillis(80), 10);
        assertThatThrownBy(() -> manager.allocate("prj-a"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("listener did not become ready");
        assertThat(factory.killed).containsExactly("manao-ws-prj-a");
        assertThat(manager.activeBridges()).isZero();
    }

    @Test
    void findFreePortSkipsAnOsOccupiedLoopbackPort() throws Exception {
        try (ServerSocket occupied = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int busy = occupied.getLocalPort();
            int start = busy;
            int end = busy + 2;
            RecordingFactory factory = new RecordingFactory();
            WorkspacePortForwardManager manager = new WorkspacePortForwardManager(
                "manao-test", start, end, factory);
            int port = manager.allocate("prj-a");
            assertThat(port).isNotEqualTo(busy);
            assertThat(port).isBetween(start, end);
        }
    }

    @Test
    void supervisedModeReusesTheExternallyOwnedListenerAcrossBackendRestart() throws Exception {
        try (ServerSocket externalBridge = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int port = externalBridge.getLocalPort();
            WorkspacePortForwardManager firstBackend = new WorkspacePortForwardManager(
                "manao-test", port, port, null);
            assertThat(firstBackend.allocate("prj-supervised")).isEqualTo(port);
            firstBackend.shutdown();
            assertThat(externalBridge.isClosed()).isFalse();
            WorkspacePortForwardManager restartedBackend = new WorkspacePortForwardManager(
                "manao-test", port, port, null);
            assertThat(restartedBackend.allocate("prj-supervised")).isEqualTo(port);
        }
    }

    @Test
    void supervisedModeGivesCollidingProjectIdsDistinctPorts() {
        int span = 100;
        String first = "prj-0";
        String second = null;
        int firstPort = 18100 + Math.floorMod(first.hashCode(), span);
        for (int i = 1; i < 5000; i++) {
            String candidate = "prj-" + i;
            if (18100 + Math.floorMod(candidate.hashCode(), span) == firstPort) {
                second = candidate;
                break;
            }
        }
        assertThat(second).isNotNull();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, null);
        int portA = manager.allocate(first);
        int portB = manager.allocate(second);
        assertThat(portA).isNotEqualTo(portB);
        assertThat(portA).isBetween(18100, 18199);
        assertThat(portB).isBetween(18100, 18199);
    }

    @Test
    void heldDiagnosticBridgeIsNotRecreatedByMaintenance() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).fail();

        manager.hold("prj-a");
        manager.checkChildren();

        assertThat(factory.started).hasSize(1);
        assertThat(manager.endpoint("prj-a").getPort()).isEqualTo(port);
    }
    @Test
    void recreateKillsTheOldProcessBeforeStartingTheReplacement() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).fail();
        manager.checkChildren();
        assertThat(factory.events).containsExactly("start:" + port, "kill:" + port, "start:" + port);
    }

    static final class RecordingFactory implements WorkspacePortForwardManager.PortForwardProcessFactory {
        record Start(String serviceName, int servicePort, int localPort) { }
        final List<Start> started = new ArrayList<>();
        final Map<String, FakeProcess> processes = new ConcurrentHashMap<>();
        final List<String> killed = new ArrayList<>();
        final List<String> events = new CopyOnWriteArrayList<>();
        private final boolean startListening;

        RecordingFactory() { this(true); }
        RecordingFactory(boolean startListening) { this.startListening = startListening; }

        @Override public WorkspacePortForwardManager.PortForwardProcess start(String namespace, String serviceName,
                                                                              int servicePort, int localPort) {
            started.add(new Start(serviceName, servicePort, localPort));
            events.add("start:" + localPort);
            FakeProcess process = new FakeProcess(() -> {
                events.add("kill:" + localPort);
                killed.add(serviceName);
            }, startListening);
            processes.put(serviceName + ":" + localPort, process);
            return process;
        }
    }

    static final class FakeProcess implements WorkspacePortForwardManager.PortForwardProcess {
        private final Runnable onKill;
        private volatile boolean alive = true;
        private volatile boolean listening;
        private volatile boolean killed;
        private boolean failKill;
        FakeProcess(Runnable onKill) { this(onKill, true); }
        FakeProcess(Runnable onKill, boolean listening) {
            this.onKill = onKill;
            this.listening = listening;
        }
        void fail() { alive = false; }
        void stopListening() { listening = false; }
        void startListening() { listening = true; }
        @Override public boolean isAlive() { return alive; }
        @Override public boolean isListening() { return listening; }
        @Override public void kill() {
            if (failKill) {
                throw new IllegalStateException("kill failed");
            }
            if (!killed) {
                killed = true;
                onKill.run();
            }
            alive = false;
            listening = false;
        }
    }
}
