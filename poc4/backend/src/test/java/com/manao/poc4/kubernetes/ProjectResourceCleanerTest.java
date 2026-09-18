package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProjectResourceCleanerTest {
    private static final String NS = "manao";
    private static final String P1 = "p1";
    private static final String P2 = "p2";
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    private KubernetesMockServer server;
    private KubernetesClient client;
    private WorkspaceResourceFactory factory;
    private JobResourceFactory jobs;
    private Fabric8KubernetesGateway gateway;

    @BeforeEach
    void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        client = server.createClient();
        gateway = new Fabric8KubernetesGateway(client, NS);
        factory = new WorkspaceResourceFactory(NS, "rwx-storage",
            "registry.example/manao/workspace-agent@" + DIGEST,
            "registry.example/manao/initializer@" + DIGEST);
        jobs = new JobResourceFactory(NS, 1800,
            new JobResourceFactory.RunResources(1000, 1L << 30, 1L << 30),
            new JobResourceFactory.RunResources(8000, 16L << 30, 10L << 30),
            "registry.example/manao/maven-runner@" + DIGEST);
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    @Test
    void currentWorkloadSelectorLeavesInitializerPodsBehind() {
        seedProject(P1, "Succeeded");
        assertThat(factory.createInitializerPod(P1).getMetadata().getLabels().get("manao.poc4/component"))
            .isEqualTo("initializer");
        Map<String, String> workspaceOnly = WorkspaceResourceFactory.projectLabels(P1);
        assertThat(client.pods().inNamespace(NS).withLabels(workspaceOnly).list().getItems())
            .extracting(pod -> pod.getMetadata().getName())
            .contains(WorkspaceResourceFactory.workspacePodName(P1))
            .doesNotContain(WorkspaceResourceFactory.initializerPodName(P1));
        assertThat(client.pods().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems())
            .extracting(pod -> pod.getMetadata().getName())
            .contains(WorkspaceResourceFactory.initializerPodName(P1),
                WorkspaceResourceFactory.workspacePodName(P1));
    }

    @Test
    void cleanerRemovesEveryOwnedComponentAndLeavesOtherProjects() {
        seedProject(P1, "Pending");
        seedFailedInitializer(P1);
        seedProject(P2, "Succeeded");
        ProjectResourceCleaner cleaner = new ProjectResourceCleaner(client, NS,
            Duration.ofSeconds(5), Duration.ZERO, Clock.systemUTC(), Duration.ofSeconds(5), duration -> { });

        ProjectResourceCleaner.CleanupReport report = cleaner.clean(P1);

        assertThat(report.complete()).isTrue();
        assertThat(client.pods().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isEmpty();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isEmpty();
        assertThat(client.services().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isEmpty();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS)
            .withName(WorkspaceResourceFactory.initializerPodName(P2)).get()).isNotNull();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(P2)).get()).isNotNull();
    }

    @Test
    void workloadsPathDeletesInitializerButNeverPvc() {
        seedProject(P1, "Failed");
        gateway.deleteProjectWorkloads(P1);
        assertThat(client.pods().inNamespace(NS)
            .withName(WorkspaceResourceFactory.initializerPodName(P1)).get()).isNull();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(P1)).get()).isNotNull();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isNotEmpty();
    }

    @Test
    void forbiddenAndTimeoutAreNotEmptyInventory() {
        io.fabric8.kubernetes.api.model.Status forbidden = new io.fabric8.kubernetes.api.model.StatusBuilder()
            .withCode(403).withMessage("denied").build();
        assertThat(ProjectResourceCleaner.category(new io.fabric8.kubernetes.client.KubernetesClientException("denied", 403, forbidden)))
            .isEqualTo("FORBIDDEN");
        assertThat(ProjectResourceCleaner.category(new io.fabric8.kubernetes.client.KubernetesClientException(
            "timeout", new java.net.SocketTimeoutException("read timed out"))))
            .isEqualTo("TIMEOUT");
    }

    @Test
    void expiredBudgetDoesNotClaimComplete() {
        seedProject(P1, "Succeeded");
        Clock clock = Clock.systemUTC();
        ProjectResourceCleaner cleaner = new ProjectResourceCleaner(client, NS,
            Duration.ZERO, Duration.ofMillis(250), clock, Duration.ofSeconds(5), duration -> { });

        ProjectResourceCleaner.CleanupReport report = cleaner.clean(P1);

        assertThat(report.complete()).isFalse();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(P1)).get()).isNotNull();
    }

    private void seedProject(String projectId, String initializerPhase) {
        client.persistentVolumeClaims().inNamespace(NS).resource(factory.createPvc(projectId)).create();
        client.pods().inNamespace(NS).resource(withPhase(factory.createInitializerPod(projectId), initializerPhase)).create();
        client.pods().inNamespace(NS).resource(factory.createWorkspacePod(projectId, "cHVibGljLWtleQ==")).create();
        client.services().inNamespace(NS).resource(factory.createWorkspaceService(projectId)).create();
        client.batch().v1().jobs().inNamespace(NS).resource(jobs.createMavenJob("run-" + projectId, projectId)).create();
    }

    private void seedFailedInitializer(String projectId) {
        Pod extra = new PodBuilder()
            .withNewMetadata()
            .withName(WorkspaceResourceFactory.initializerPodName(projectId) + "-old")
            .withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(projectId))
            .addToLabels("manao.poc4/component", "initializer")
            .endMetadata()
            .withNewSpec().addNewContainer().withName("init")
            .withImage("registry.example/manao/initializer@" + DIGEST).endContainer().endSpec()
            .withStatus(new PodStatusBuilder().withPhase("Failed").build())
            .build();
        client.pods().inNamespace(NS).resource(extra).create();
    }

    private static Pod withPhase(Pod pod, String phase) {
        pod.setStatus(new PodStatusBuilder().withPhase(phase).build());
        return pod;
    }
}
