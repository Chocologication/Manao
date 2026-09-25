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
        jobs = new JobResourceFactory(NS, 1800, "registry.example/manao/initializer@" + DIGEST,
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
        gateway.deleteWorkspaceWorkloads(P1);
        assertThat(client.pods().inNamespace(NS)
            .withName(WorkspaceResourceFactory.initializerPodName(P1)).get()).isNull();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(P1)).get()).isNotNull();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isNotEmpty();
    }

    @Test
    void workspaceRepairKeepsOtherProjectComponents() {
        seedProject(P1, "Pending");
        seedApplicationService(P1);
        seedDependencyPod(P1, "mysql-p1-0", "mysql");
        seedDependencyPod(P1, "redis-p1-0", "redis");
        ProjectResourceCleaner cleaner = new ProjectResourceCleaner(client, NS,
            Duration.ofSeconds(5), Duration.ZERO, Clock.systemUTC(), Duration.ofSeconds(5), duration -> { });

        cleaner.deleteWorkspaceWorkloads(P1);

        assertThat(client.pods().inNamespace(NS)
            .withName(WorkspaceResourceFactory.workspacePodName(P1)).get()).isNull();
        assertThat(client.services().inNamespace(NS)
            .withName(WorkspaceResourceFactory.serviceName(P1)).get()).isNull();
        assertThat(client.pods().inNamespace(NS)
            .withName(WorkspaceResourceFactory.initializerPodName(P1)).get()).isNull();
        // Workspace repair must never reach the user application or the dependency workloads.
        assertThat(client.services().inNamespace(NS).withName("manao-app-" + P1).get()).isNotNull();
        assertThat(client.pods().inNamespace(NS).withName("mysql-p1-0").get()).isNotNull();
        assertThat(client.pods().inNamespace(NS).withName("redis-p1-0").get()).isNotNull();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isNotEmpty();
    }

    @Test
    void fullCleanupRemovesDependencyControllersSecretsPoliciesAndBothClaims() {
        seedProject(P1, "Pending");
        seedApplicationService(P1);
        seedDependencyPod(P1, "mysql-p1-0", "mysql");
        seedDependencyPod(P1, "redis-p1-0", "redis");
        client.apps().statefulSets().inNamespace(NS).resource(statefulSet("mysql-p1")).create();
        client.apps().deployments().inNamespace(NS).resource(deployment("redis-p1")).create();
        client.apps().replicaSets().inNamespace(NS).resource(replicaSet("redis-p1-old")).create();
        client.secrets().inNamespace(NS).resource(namedSecret("mysql-credentials-p1")).create();
        client.network().networkPolicies().inNamespace(NS).resource(networkPolicy("allow-mysql-p1")).create();
        FakeProjectRuntimeStore runtimeStore = new FakeProjectRuntimeStore();
        runtimeStore.rememberStorage(P1, new com.manao.poc4.project.ProjectRuntimeStore.StorageBinding(
            "MYSQL", "manao-mysql-pvc-" + P1, "uid-mysql", null, null));
        ProjectResourceCleaner cleaner = new ProjectResourceCleaner(client, NS,
            Duration.ofSeconds(5), Duration.ZERO, Clock.systemUTC(), Duration.ofSeconds(5), duration -> { },
            runtimeStore);

        ProjectResourceCleaner.CleanupReport report = cleaner.clean(P1);

        assertThat(report.complete()).isTrue();
        assertThat(client.apps().statefulSets().inNamespace(NS).withName("mysql-p1").get()).isNull();
        assertThat(client.apps().deployments().inNamespace(NS).withName("redis-p1").get()).isNull();
        assertThat(client.apps().replicaSets().inNamespace(NS).withName("redis-p1-old").get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName("mysql-p1-0").get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName("redis-p1-0").get()).isNull();
        assertThat(client.services().inNamespace(NS).withName("manao-app-" + P1).get()).isNull();
        assertThat(client.secrets().inNamespace(NS).withName("mysql-credentials-p1").get()).isNull();
        assertThat(client.network().networkPolicies().inNamespace(NS).withName("allow-mysql-p1").get()).isNull();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName("manao-mysql-pvc-" + P1).get()).isNull();
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(P1)).get()).isNull();
        assertThat(client.pods().inNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1)).list().getItems()).isEmpty();
    }

    @Test
    void fullCleanupCatchesThePublicEndpointServiceWithoutLegacyTestLabel() {
        // The application Service carries exactly the labels Fabric8PublicEndpointGateway sets:
        // managed-by and project-id, without the legacy stage6-test marker.
        client.services().inNamespace(NS).resource(new io.fabric8.kubernetes.api.model.ServiceBuilder()
            .withNewMetadata().withName("manao-app-" + P1).withNamespace(NS)
            .withLabels(Map.of(
                "app.kubernetes.io/managed-by", "manao-poc4-backend",
                WorkspaceResourceFactory.LABEL_PROJECT_ID, P1))
            .endMetadata()
            .withNewSpec().withType("NodePort")
            .withPorts(new io.fabric8.kubernetes.api.model.ServicePortBuilder()
                .withName("web").withProtocol("TCP").withPort(8080)
                .withTargetPort(new io.fabric8.kubernetes.api.model.IntOrString(8080))
                .withNodePort(30081).build())
            .endSpec().build()).create();
        FakeProjectRuntimeStore runtimeStore = new FakeProjectRuntimeStore();
        ProjectResourceCleaner cleaner = new ProjectResourceCleaner(client, NS,
            Duration.ofSeconds(5), Duration.ZERO, Clock.systemUTC(), Duration.ofSeconds(5), duration -> { },
            runtimeStore);

        ProjectResourceCleaner.CleanupReport report = cleaner.clean(P1);

        assertThat(report.complete()).isTrue();
        assertThat(client.services().inNamespace(NS).withName("manao-app-" + P1).get()).isNull();
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
        client.batch().v1().jobs().inNamespace(NS).resource(jobs.createMavenJob("run-" + projectId, projectId, java.util.List.of())).create();
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

    private void seedApplicationService(String projectId) {
        client.services().inNamespace(NS).resource(new io.fabric8.kubernetes.api.model.ServiceBuilder()
            .withNewMetadata().withName("manao-app-" + projectId).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(projectId))
            .addToLabels("manao.poc4/component", "app")
            .endMetadata()
            .withNewSpec().withType("NodePort")
            .withPorts(new io.fabric8.kubernetes.api.model.ServicePortBuilder()
                .withName("web").withProtocol("TCP").withPort(8080)
                .withTargetPort(new io.fabric8.kubernetes.api.model.IntOrString(8080))
                .withNodePort(30081).build())
            .endSpec().build()).create();
    }

    private void seedDependencyPod(String projectId, String podName, String component) {
        client.pods().inNamespace(NS).resource(new PodBuilder()
            .withNewMetadata().withName(podName).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(projectId))
            .addToLabels("manao.poc4/component", component)
            .endMetadata()
            .withNewSpec().addNewContainer().withName(component)
            .withImage("registry.example/manao/" + component + "@" + DIGEST).endContainer().endSpec()
            .withStatus(new PodStatusBuilder().withPhase("Running").build())
            .build()).create();
    }

    private io.fabric8.kubernetes.api.model.apps.StatefulSet statefulSet(String name) {
        return new io.fabric8.kubernetes.api.model.apps.StatefulSetBuilder()
            .withNewMetadata().withName(name).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1))
            .addToLabels("manao.poc4/component", "mysql")
            .endMetadata()
            .withNewSpec().withServiceName(name).withReplicas(1)
            .withNewSelector().addToMatchLabels("manao.poc4/component", "mysql").endSelector()
            .withNewTemplate()
            .withNewMetadata().addToLabels("manao.poc4/component", "mysql").endMetadata()
            .withNewSpec().addNewContainer().withName("mysql")
            .withImage("registry.example/manao/mysql@" + DIGEST).endContainer().endSpec()
            .endTemplate()
            .endSpec().build();
    }

    private io.fabric8.kubernetes.api.model.apps.Deployment deployment(String name) {
        return new io.fabric8.kubernetes.api.model.apps.DeploymentBuilder()
            .withNewMetadata().withName(name).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1))
            .addToLabels("manao.poc4/component", "redis")
            .endMetadata()
            .withNewSpec().withReplicas(1)
            .withNewSelector().addToMatchLabels("manao.poc4/component", "redis").endSelector()
            .withNewTemplate()
            .withNewMetadata().addToLabels("manao.poc4/component", "redis").endMetadata()
            .withNewSpec().addNewContainer().withName("redis")
            .withImage("registry.example/manao/redis@" + DIGEST).endContainer().endSpec()
            .endTemplate()
            .endSpec().build();
    }

    private io.fabric8.kubernetes.api.model.apps.ReplicaSet replicaSet(String name) {
        return new io.fabric8.kubernetes.api.model.apps.ReplicaSetBuilder()
            .withNewMetadata().withName(name).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1))
            .addToLabels("manao.poc4/component", "redis")
            .endMetadata()
            .withNewSpec().withReplicas(1)
            .withNewSelector().addToMatchLabels("manao.poc4/component", "redis").endSelector()
            .withNewTemplate()
            .withNewMetadata().addToLabels("manao.poc4/component", "redis").endMetadata()
            .withNewSpec().addNewContainer().withName("redis")
            .withImage("registry.example/manao/redis@" + DIGEST).endContainer().endSpec()
            .endTemplate()
            .endSpec().build();
    }

    private io.fabric8.kubernetes.api.model.Secret namedSecret(String name) {
        return new io.fabric8.kubernetes.api.model.SecretBuilder()
            .withNewMetadata().withName(name).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1))
            .addToLabels("manao.poc4/component", "mysql")
            .endMetadata()
            .addToStringData("password", "generated-not-a-secret").build();
    }

    private io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicy networkPolicy(String name) {
        return new io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicyBuilder()
            .withNewMetadata().withName(name).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(P1))
            .addToLabels("manao.poc4/component", "mysql")
            .endMetadata()
            .withNewSpec()
            .withNewPodSelector().addToMatchLabels("manao.poc4/component", "mysql").endPodSelector()
            .withPolicyTypes("Ingress")
            .endSpec().build();
    }

    private static Pod withPhase(Pod pod, String phase) {
        pod.setStatus(new PodStatusBuilder().withPhase(phase).build());
        return pod;
    }
}
