package com.manao.poc4.kubernetes;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 6A bridge backed by the kubectl port-forward path proven against the real cluster. The child
 * process owns the remote WebSocket transport; this JVM only manages its lifecycle and verifies
 * the loopback listener.
 */
public final class KubectlPortForwardFactory implements WorkspacePortForwardManager.PortForwardProcessFactory {
    @FunctionalInterface
    public interface ProcessStarter {
        Process start(List<String> command) throws IOException;
    }

    private final String kubectl;
    private final Path kubeconfig;
    private final ProcessStarter starter;

    public KubectlPortForwardFactory(String kubectl, Path kubeconfig) {
        this(kubectl, kubeconfig, command -> new ProcessBuilder(command)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start());
    }

    KubectlPortForwardFactory(String kubectl, Path kubeconfig, ProcessStarter starter) {
        if (kubectl == null || kubectl.isBlank()) throw new IllegalArgumentException("kubectl is required");
        if (kubeconfig == null || kubeconfig.toString().isBlank()) throw new IllegalArgumentException("kubeconfig is required");
        this.kubectl = kubectl;
        this.kubeconfig = kubeconfig;
        this.starter = starter;
    }

    @Override
    public WorkspacePortForwardManager.PortForwardProcess start(
        String namespace, String podName, int servicePort, int localPort) {
        List<String> command = new ArrayList<>(List.of(
            kubectl, "--kubeconfig", kubeconfig.toString(), "--namespace", namespace,
            "port-forward", "pod/" + podName, "--address=127.0.0.1",
            localPort + ":" + servicePort));
        try {
            Process process = starter.start(command);
            return new WorkspacePortForwardManager.PortForwardProcess() {
                @Override public boolean isAlive() { return process.isAlive(); }

                @Override public boolean isListening() {
                    return process.isAlive() && WorkspacePortForwardManager.isPortListening(localPort);
                }

                @Override public void kill() {
                    if (process.isAlive()) process.destroy();
                    if (process.isAlive()) process.destroyForcibly();
                }

                @Override public java.util.OptionalLong pid() {
                    return java.util.OptionalLong.of(process.pid());
                }
            };
        } catch (IOException ex) {
            throw new IllegalStateException("cannot start workspace port-forward", ex);
        }
    }
}