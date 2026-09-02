package com.manao.poc4.config;

import com.manao.poc4.kubernetes.KubeconfigTlsPreflight;
import com.manao.poc4.kubernetes.SshApiTunnelHealth;
import com.manao.poc4.kubernetes.WorkspacePortForwardManager;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Profile;

/**
 * 6A local-cluster profile wiring: a kubectl port-forward process per project bound to loopback,
 * the TLS/RBAC preflight against the SSH-forwarded API endpoint, and tunnel health mapping.
 */
@Configuration
@Profile("local-cluster")
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class LocalClusterConfig {

    @Bean
    WorkspacePortForwardManager workspacePortForwardManager(
        BackendProperties properties,
        org.springframework.beans.factory.ObjectProvider<io.fabric8.kubernetes.client.KubernetesClient> clientProvider) {
        // MANAO_BRIDGE_MODE=supervised: an operator-managed kubectl bridge outside the JVM serves
        // deterministic per-project ports (sandbox environments where in-process binds and child
        // spawns are denied). Default: the in-process Fabric8 port-forward (pods/portforward).
        String mode = System.getenv().getOrDefault("MANAO_BRIDGE_MODE", "fabric8");
        WorkspacePortForwardManager.PortForwardProcessFactory factory = "supervised".equals(mode)
            ? null
            : (namespace, serviceName, servicePort, localPort) ->
                startFabric8PortForward(clientProvider, namespace, serviceName, servicePort, localPort);
        return new WorkspacePortForwardManager(
            properties.kubernetes().namespace(),
            properties.workspace().bridgePortStart(),
            properties.workspace().bridgePortEnd(),
            properties.workspace().agentPort(),
            factory);
    }

    @Bean
    SshApiTunnelHealth.CommandRunner kubectlCommandRunner() {
        return command -> {
            try {
                Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
                boolean finished = process.waitFor(30, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                    return new SshApiTunnelHealth.CommandRunner.CommandResult(-1, "", "kubectl timed out");
                }
                String stdout = new String(process.getInputStream().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
                String stderr = new String(process.getErrorStream().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
                return new SshApiTunnelHealth.CommandRunner.CommandResult(process.exitValue(), stdout, stderr);
            } catch (IOException | InterruptedException ex) {
                if (ex instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                }
                return new SshApiTunnelHealth.CommandRunner.CommandResult(-1, "", "kubectl could not be executed");
            }
        };
    }

    @Bean
    SshApiTunnelHealth sshApiTunnelHealth(SshApiTunnelHealth.CommandRunner runner,
                                          java.util.Optional<io.fabric8.kubernetes.client.KubernetesClient> client) {
        SshApiTunnelHealth.Fabric8VersionProbe probe = client
            .map(c -> (SshApiTunnelHealth.Fabric8VersionProbe) () -> {
                try {
                    c.getApiVersion();
                    return c.getConfiguration() != null;
                } catch (RuntimeException ex) {
                    return false;
                }
            })
            .orElse(null);
        return new SshApiTunnelHealth(runner, SshApiTunnelHealth.designVerbs(true), probe,
            path -> {
                try {
                    return Files.readString(Path.of(path));
                } catch (java.io.IOException ex) {
                    throw new IllegalStateException("kubeconfig is unreadable", ex);
                }
            });
    }

    /** Startup gate: structural kubeconfig preflight plus dual kubectl/auth can-i verification. */
    @Bean
    ApplicationRunner localClusterPreflightRunner(BackendProperties properties, SshApiTunnelHealth health) {
        return (ApplicationArguments args) -> {
            String kubeconfigPath = properties.kubernetes().kubeconfigFile();
            if (kubeconfigPath == null || kubeconfigPath.isBlank()) {
                throw new IllegalStateException("KUBECONFIG for the local-cluster profile is required");
            }
            try {
                KubeconfigTlsPreflight.requireValid(Files.readString(Path.of(kubeconfigPath)));
            } catch (java.io.IOException ex) {
                throw new IllegalStateException("kubeconfig is unreadable", ex);
            }
            SshApiTunnelHealth.Result result = health.check(kubeconfigPath,
                KubeconfigTlsPreflight.validate(Files.readString(Path.of(kubeconfigPath))).tlsServerName(),
                properties.kubernetes().namespace());
            if (!result.up()) {
                throw new IllegalStateException("SSH API tunnel preflight failed: " + result.failures());
            }
        };
    }

    /**
     * 6A workspace bridge via the in-process Fabric8 port-forward (pods/portforward is granted
     * to the 6A identity exactly for this bridge). The workspace Service name is server-derived
     * and equals the workspace Pod name, so forwarding targets the Pod directly. Loopback-only
     * by Fabric8's default LocalPortForward binding; no child processes and no captured stdio.
     */
    private static WorkspacePortForwardManager.PortForwardProcess startFabric8PortForward(
        org.springframework.beans.factory.ObjectProvider<io.fabric8.kubernetes.client.KubernetesClient> clientProvider,
        String namespace, String serviceName, int servicePort, int localPort) {
        io.fabric8.kubernetes.client.KubernetesClient client = clientProvider.getIfAvailable();
        if (client == null) {
            throw new IllegalStateException("Kubernetes client is required for the workspace bridge");
        }
        io.fabric8.kubernetes.client.LocalPortForward forward = client.pods().inNamespace(namespace)
            .withName(serviceName).portForward(servicePort, java.net.InetAddress.getLoopbackAddress(), localPort);
        return new WorkspacePortForwardManager.PortForwardProcess() {
            @Override public boolean isAlive() { return forward.isAlive(); }
            @Override public void kill() {
                try {
                    forward.close();
                } catch (java.io.IOException ex) {
                    throw new IllegalStateException("cannot close workspace bridge", ex);
                }
            }
        };
    }
}
