package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Fabric8 mock-server coverage for the fail-closed initializer semantics. */
class Fabric8KubernetesGatewayTest {
    private static final String NS = "manao";
    private static final String PROJECT = "p1";

    KubernetesMockServer server;
    Fabric8KubernetesGateway gateway;

    @BeforeEach
    void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        KubernetesClient client = server.createClient();
        gateway = new Fabric8KubernetesGateway(client, NS);
    }

    @AfterEach
    void tearDown() { server.destroy(); }

    @Test
    void missingInitializerIsNotSuccess() {
        assertThat(gateway.initializerSucceeded(PROJECT)).isFalse();
    }

    @Test
    void succeededPodIsSuccess() {
        seedInitializer("Succeeded");
        assertThat(gateway.initializerSucceeded(PROJECT)).isTrue();
    }

    @Test
    void failedPodIsNotSuccess() {
        seedInitializer("Failed");
        assertThat(gateway.initializerSucceeded(PROJECT)).isFalse();
    }

    @Test
    void matchesProjectNeverNpesOnMissingLabels() {
        var pvc = new io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder()
            .withNewMetadata().withName(WorkspaceResourceFactory.pvcName(PROJECT)).withNamespace(NS).endMetadata()
            .withNewSpec().endSpec()
            .build();
        server.createClient().persistentVolumeClaims().inNamespace(NS).resource(pvc).create();
        // 无 labels 的资源必须判为不匹配，而不是 NPE。
        assertThat(gateway.projectPvcExists(PROJECT)).isFalse();
    }

    private void seedInitializer(String phase) {
        var pod = new PodBuilder()
            .withNewMetadata().withName(WorkspaceResourceFactory.initializerPodName(PROJECT)).withNamespace(NS)
            .endMetadata()
            .withNewSpec().addNewContainer().withName("init").withImage("registry.example/init@sha256:" + "b".repeat(64)).endContainer().endSpec()
            .withStatus(new PodStatusBuilder().withPhase(phase).build())
            .build();
        server.createClient().pods().inNamespace(NS).resource(pod).create();
    }
}
