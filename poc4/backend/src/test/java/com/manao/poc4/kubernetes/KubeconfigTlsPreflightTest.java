package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class KubeconfigTlsPreflightTest {
    private static final String VALID_KUBECONFIG = """
        apiVersion: v1
        kind: Config
        clusters:
        - name: test-cluster
          cluster:
            server: https://127.0.0.1:6443
            tls-server-name: kubernetes.svc.cluster.local
            certificate-authority-data: Zm9vLWJhcg==
        contexts:
        - name: test-context
          context:
            cluster: test-cluster
            user: test-user
        current-context: test-context
        users:
        - name: test-user
          user:
            token: test-token
        """;

    @Test
    void acceptsValidKubeconfigWithTlsServerNameAndCa() {
        var result = KubeconfigTlsPreflight.validate(VALID_KUBECONFIG);
        assertThat(result.passed()).isTrue();
        assertThat(result.tlsServerName()).isEqualTo("kubernetes.svc.cluster.local");
        assertThat(result.server()).isEqualTo("https://127.0.0.1:6443");
    }

    @Test
    void rejectsInsecureSkipTlsVerify() {
        String insecure = VALID_KUBECONFIG.replace("tls-server-name: kubernetes.svc.cluster.local",
            "insecure-skip-tls-verify: true");
        var result = KubeconfigTlsPreflight.validate(insecure);
        assertThat(result.passed()).isFalse();
        assertThat(result.reason()).contains("insecure-skip-tls-verify");
    }

    @Test
    void rejectsMissingTlsServerNameAndMissingCa() {
        var noSan = KubeconfigTlsPreflight.validate(
            VALID_KUBECONFIG.replace("    tls-server-name: kubernetes.svc.cluster.local\n", ""));
        assertThat(noSan.passed()).isFalse();
        assertThat(noSan.reason()).contains("tls-server-name");

        var noCa = KubeconfigTlsPreflight.validate(
            VALID_KUBECONFIG.replace("certificate-authority-data: Zm9vLWJhcg==\n", ""));
        assertThat(noCa.passed()).isFalse();
        assertThat(noCa.reason()).contains("certificate-authority");

        // CA data without a tls-server-name cannot be rescued by insecure mode.
        assertThatThrownBy(() -> KubeconfigTlsPreflight.requireValid(
            VALID_KUBECONFIG.replace("tls-server-name: kubernetes.svc.cluster.local\n", "")))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsPlaintextServerAndUnresolvableYaml() {
        var http = KubeconfigTlsPreflight.validate(
            VALID_KUBECONFIG.replace("server: https://", "server: http://"));
        assertThat(http.passed()).isFalse();
        assertThat(http.reason()).contains("https");

        assertThat(KubeconfigTlsPreflight.validate("::not-yaml::").passed()).isFalse();
    }

    @Test
    void certificateAuthorityMayAlsoComeFromFileReference() {
        String fileCa = VALID_KUBECONFIG.replace("certificate-authority-data: Zm9vLWJhcg==",
            "certificate-authority: /etc/kubernetes/pki/ca.crt");
        assertThat(KubeconfigTlsPreflight.validate(fileCa).passed()).isTrue();
    }

    @SuppressWarnings("unused")
    private static List<String> unused() { return List.of(); }
}
