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
    WorkspacePortForwardManager workspacePortForwardManager(BackendProperties properties) {
        return new WorkspacePortForwardManager(
            properties.kubernetes().namespace(),
            properties.workspace().bridgePortStart(),
            properties.workspace().bridgePortEnd(),
            properties.workspace().agentPort(),
            (namespace, serviceName, servicePort, localPort) ->
                startKubectlPortForward(properties, serviceName, servicePort, localPort));
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

    private static WorkspacePortForwardManager.PortForwardProcess startKubectlPortForward(
        BackendProperties properties, String serviceName, int servicePort, int localPort) {
        List<String> command = List.of(
            "kubectl",
            "--kubeconfig=" + properties.kubernetes().kubeconfigFile(),
            "port-forward",
            "--address", "127.0.0.1",
            "service/" + serviceName,
            localPort + ":" + servicePort,
            "-n", properties.kubernetes().namespace());
        try {
            Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
            return new WorkspacePortForwardManager.PortForwardProcess() {
                @Override public boolean isAlive() { return process.isAlive(); }
                @Override public void kill() { process.destroyForcibly(); }
            };
        } catch (IOException ex) {
            throw new IllegalStateException("cannot start kubectl port-forward", ex);
        }
    }
}
