package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.client.KubernetesClient;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Kubernetes client must speak HTTP/1.1: run-receipt reads go through WebSocket exec
 * upgrades, and HTTP/2 (ALPN) negotiation makes every exec fail immediately with an opaque
 * handshake rejection against kube-apiserver (observed live on v1.31, 2026-09-22).
 */
class WorkspaceConfigKubernetesClientTest {

    private static final String MINIMAL_KUBECONFIG = """
        apiVersion: v1
        kind: Config
        clusters:
          - name: test
            cluster:
              server: https://127.0.0.1:6443
        contexts:
          - name: test
            context:
              cluster: test
              user: test
        current-context: test
        users:
          - name: test
            user: {}
        """;

    @Test
    void theKubernetesClientDisablesHttp2ForWebSocketExec(@TempDir Path tempDir) throws IOException {
        Path kubeconfig = tempDir.resolve("kubeconfig");
        Files.writeString(kubeconfig, MINIMAL_KUBECONFIG);
        BackendProperties.Kubernetes kubernetes = new BackendProperties.Kubernetes(
            "https://127.0.0.1:6443", "manao-test", false, false,
            kubeconfig.toString(), null, 0, null, null);
        BackendProperties properties = new BackendProperties(
            BackendProfile.LOCAL_CLUSTER, null, null, null, kubernetes, null, null, null, null);

        try (KubernetesClient client = new WorkspaceConfig().kubernetesClient(properties)) {
            assertThat(client.getConfiguration().isHttp2Disable())
                .as("HTTP/2 must be disabled so exec WebSocket upgrades use HTTP/1.1")
                .isTrue();
        }
    }
}
