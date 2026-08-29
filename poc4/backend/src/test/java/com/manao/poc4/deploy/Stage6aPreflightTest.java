package com.manao.poc4.deploy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.kubernetes.KubeconfigTlsPreflight;
import com.manao.poc4.kubernetes.SshApiTunnelHealth;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 6A decision-gate preflight harness. The pure parts always run; the real-cluster parts execute
 * only when MANAO_KUBECONFIG points at the operator's temporary kubeconfig (via -Dmanao.stage6.real=true).
 */
class Stage6aPreflightTest {
    private static final String KUBECONFIG_WITH_SAN = """
        apiVersion: v1
        kind: Config
        clusters:
        - name: stage6
          cluster:
            server: https://127.0.0.1:6443
            tls-server-name: localhost
            certificate-authority-data: Zm9vLWJhcg==
        contexts:
        - name: stage6
          context: {cluster: stage6, user: stage6}
        current-context: stage6
        users:
        - name: stage6
          user: {token: test}
        """;

    @Test
    void kubeconfigPreflightAcceptsSanAndCaAndRejectsInsecureKubeconfigs() {
        assertThat(KubeconfigTlsPreflight.validate(KUBECONFIG_WITH_SAN).passed()).isTrue();
        assertThatThrownBy(() -> KubeconfigTlsPreflight.requireValid(
            KUBECONFIG_WITH_SAN.replace("    tls-server-name: localhost\n", "")))
            .isInstanceOf(IllegalStateException.class);
        String insecure = KUBECONFIG_WITH_SAN.replace("    tls-server-name: localhost\n",
            "    insecure-skip-tls-verify: true\n");
        assertThatThrownBy(() -> KubeconfigTlsPreflight.requireValid(insecure))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("insecure-skip-tls-verify");
    }

    @Test
    void tunnelHealthRejectsDeniedNamespaceVerbs() {
        SshApiTunnelHealth.CommandRunner denying = command ->
            new SshApiTunnelHealth.CommandRunner.CommandResult(0, "no", "");
        SshApiTunnelHealth health = new SshApiTunnelHealth(denying, List.of("get", "create"));
        SshApiTunnelHealth.Result result = health.check("kubeconfig", "localhost", "manao");
        assertThat(result.up()).isFalse();
        assertThat(SshApiTunnelHealth.mapsToDependencyUnavailable(result)).isTrue();
    }

    @Test
    void realClusterPreflightRunsOnlyWhenEnabled()
        throws Exception {
        String enabled = System.getProperty("manao.stage6.real", "false");
        String kubeconfigPath = System.getenv("KUBECONFIG");
        if (!"true".equals(enabled) || kubeconfigPath == null || !Files.isReadable(Path.of(kubeconfigPath))) {
            return; // Gate run only; the pure assertions above cover the build.
        }
        String kubeconfig = Files.readString(Path.of(kubeconfigPath));
        KubeconfigTlsPreflight.requireValid(kubeconfig);
        SshApiTunnelHealth health = new SshApiTunnelHealth(realKubectl(), List.of("get", "list", "watch", "create", "delete"));
        SshApiTunnelHealth.Result result = health.check(kubeconfigPath,
            KubeconfigTlsPreflight.validate(kubeconfig).tlsServerName(),
            System.getenv().getOrDefault("MANAO_K8S_NAMESPACE", "manao"));
        assertThat(result.failures()).as("6A preflight failures: %s", result.failures()).isEmpty();
    }

    private SshApiTunnelHealth.CommandRunner realKubectl() {
        return command -> {
            try {
                Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
                boolean done = process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS);
                if (!done) {
                    process.destroyForcibly();
                    return new SshApiTunnelHealth.CommandRunner.CommandResult(-1, "", "timeout");
                }
                return new SshApiTunnelHealth.CommandRunner.CommandResult(process.exitValue(),
                    new String(process.getInputStream().readAllBytes()),
                    new String(process.getErrorStream().readAllBytes()));
            } catch (Exception ex) {
                return new SshApiTunnelHealth.CommandRunner.CommandResult(-1, "", ex.toString());
            }
        };
    }
}
