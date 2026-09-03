package com.manao.poc4.kubernetes;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 6A workspace bridge: one kubectl port-forward per project, bound to loopback only, with the
 * service name and port always server-derived. Child exit or loss of the forwarded listener is
 * detected and the original mapping is recreated; backend shutdown kills every child process and
 * releases the ports.
 */
public final class WorkspacePortForwardManager {
    private static final Pattern PROJECT_ID = Pattern.compile("[A-Za-z0-9-]+");

    public interface PortForwardProcess {
        /** Process handle still alive; does not guarantee the forwarded port accepts connections. */
        boolean isAlive();

        /** The forwarded loopback port actually accepts TCP connections right now. */
        boolean isListening();

        void kill();
    }

    public interface PortForwardProcessFactory {
        PortForwardProcess start(String namespace, String serviceName, int servicePort, int localPort);
    }

    private static final class Bridge {
        final String serviceName;
        final int localPort;
        int refcount = 1;
        PortForwardProcess process;

        Bridge(String serviceName, int localPort, PortForwardProcess process) {
            this.serviceName = serviceName;
            this.localPort = localPort;
            this.process = process;
        }
    }

    private final String namespace;
    private final int portStart;
    private final int portEnd;
    private final int servicePort;
    private final PortForwardProcessFactory factory;
    private final Map<String, Bridge> bridges = new ConcurrentHashMap<>();

    public WorkspacePortForwardManager(String namespace, int portStart, int portEnd,
                                       PortForwardProcessFactory factory) {
        this(namespace, portStart, portEnd, 8080, factory);
    }

    public WorkspacePortForwardManager(String namespace, int portStart, int portEnd, int servicePort,
                                       PortForwardProcessFactory factory) {
        this.namespace = namespace;
        this.portStart = portStart;
        this.portEnd = portEnd;
        this.servicePort = servicePort;
        this.factory = factory;
    }

    /**
     * Best-effort loopback TCP connect probe: true only when the port accepts connections.
     * Distinguishes a live port-forward socket from a handle that merely reports alive.
     */
    public static boolean isPortListening(int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 250);
            return true;
        } catch (IOException ex) {
            return false;
        }
    }

    /**
     * Allocates (or reuses) a loopback port for the project and starts its bridge process.
     * Idempotent: repeated calls (e.g. one per workspace request) never spawn a second bridge.
     */
    public synchronized int allocate(String projectId) {
        requireValidProjectId(projectId);
        Bridge existing = bridges.get(projectId);
        if (existing != null) {
            if (factory != null && (!existing.process.isAlive() || !existing.process.isListening())) {
                existing.process = factory.start(namespace, existing.serviceName, servicePort, existing.localPort);
            }
            return existing.localPort;
        }
        // Supervised mode (factory == null): a deterministic port derived from the project id,
        // served by an operator-managed bridge process outside this JVM.
        int port = factory == null ? deterministicPort(projectId) : findFreePort();
        String serviceName = WorkspaceResourceFactory.serviceName(projectId);
        PortForwardProcess process = factory == null ? supervisedProcess(port) : factory.start(namespace, serviceName, servicePort, port);
        Bridge bridge = new Bridge(serviceName, port, process);
        bridges.put(projectId, bridge);
        return port;
    }

    private int deterministicPort(String projectId) {
        int span = portEnd - portStart + 1;
        return portStart + Math.floorMod(projectId.hashCode(), span);
    }

    /**
     * Supervised mode (factory == null): an operator-managed bridge outside this JVM serves the
     * deterministic port. Liveness is reported from the real listener, never assumed.
     */
    private static PortForwardProcess supervisedProcess(int port) {
        return new PortForwardProcess() {
            @Override public boolean isAlive() { return isPortListening(port); }
            @Override public boolean isListening() { return isPortListening(port); }
            @Override public void kill() { }
        };
    }

    /** Recreates dead or listener-less bridges on their original ports (called by the dependency monitor). */
    public synchronized void checkChildren() {
        if (factory == null) return; // supervised: the external operator owns the bridge
        for (Bridge bridge : bridges.values()) {
            if (!bridge.process.isAlive() || !bridge.process.isListening()) {
                bridge.process = factory.start(namespace, bridge.serviceName, servicePort, bridge.localPort);
            }
        }
    }

    /** Loopback endpoint of the project's bridge; unknown projects are rejected. */
    public URI endpoint(String projectId) {
        Bridge bridge = bridges.get(projectId);
        if (bridge == null) {
            throw new IllegalArgumentException("no workspace bridge for this project");
        }
        return URI.create("http://127.0.0.1:" + bridge.localPort);
    }

    /**
     * Drops one reference of the project bridge; the child process dies and the port is
     * released only when the last reference goes away.
     */
    public synchronized void release(String projectId) {
        Bridge bridge = bridges.get(projectId);
        if (bridge == null) return;
        if (--bridge.refcount > 0) return;
        bridges.remove(projectId);
        bridge.process.kill();
    }

    /** Adds one reference for a consumer that needs the bridge to stay up. */
    public synchronized void retain(String projectId) {
        Bridge bridge = bridges.get(projectId);
        if (bridge == null) throw new IllegalArgumentException("no workspace bridge for this project");
        bridge.refcount++;
    }

    public synchronized int references(String projectId) {
        Bridge bridge = bridges.get(projectId);
        return bridge == null ? 0 : bridge.refcount;
    }

    public synchronized void shutdown() {
        for (Bridge bridge : bridges.values()) {
            bridge.process.kill();
        }
        bridges.clear();
    }

    public int activeBridges() {
        return bridges.size();
    }

    private int findFreePort() {
        for (int candidate = portStart; candidate <= portEnd; candidate++) {
            final int port = candidate;
            boolean taken = bridges.values().stream().anyMatch(bridge -> bridge.localPort == port);
            if (!taken) return port;
        }
        throw new IllegalStateException("workspace bridge port range is exhausted");
    }

    private static void requireValidProjectId(String projectId) {
        if (projectId == null || projectId.isBlank() || projectId.contains("..")
            || !PROJECT_ID.matcher(projectId).matches()) {
            throw new IllegalArgumentException("invalid project identity");
        }
    }
}
