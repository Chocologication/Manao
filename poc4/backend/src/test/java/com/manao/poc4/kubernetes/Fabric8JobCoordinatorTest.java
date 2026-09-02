package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.api.model.ContainerState;
import io.fabric8.kubernetes.api.model.ContainerStateBuilder;
import io.fabric8.kubernetes.api.model.ContainerStateRunningBuilder;
import io.fabric8.kubernetes.api.model.ContainerStateTerminatedBuilder;
import io.fabric8.kubernetes.api.model.ContainerStatusBuilder;
import io.fabric8.kubernetes.api.model.OwnerReferenceBuilder;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Fabric8 mock-server (CRUD) coverage for the live-Pod resolution used by the PTY handshake. */
class Fabric8JobCoordinatorTest {
    private static final String NS = "manao";
    private static final String RUN = "run-1";
    private static final String PROJECT = "prj-1";
    private static final String JOB_NAME = JobResourceFactory.jobName(RUN);
    private static final String POD_NAME = JOB_NAME + "-abcde";

    KubernetesMockServer server;
    KubernetesClient client;
    Fabric8JobCoordinator coordinator;

    @BeforeEach
    void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        client = server.createClient();
        coordinator = new Fabric8JobCoordinator(client,
            new JobResourceFactory(NS, 1800,
                new JobResourceFactory.RunResources(500, 1024L * 1024 * 1024, 1024L * 1024 * 1024),
                new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024),
                "registry.example/manao/maven-runner@sha256:" + "a".repeat(64)),
            new ResourceIdentityVerifier(), NS);
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    @Test
    void findLivePodReturnsVerifiedPodWhenApplicationContainerIsRunning() {
        seedJob();
        seedPod("Running", true);

        var live = coordinator.findLivePod(RUN);

        assertThat(live).isPresent();
        assertThat(live.get().podName()).isEqualTo(POD_NAME);
        assertThat(live.get().containerName()).isEqualTo(ResourceIdentityVerifier.APPLICATION_CONTAINER);
    }

    @Test
    void findLivePodIsEmptyWithoutAPod() {
        seedJob();

        assertThat(coordinator.findLivePod(RUN)).isEmpty();
    }

    @Test
    void findLivePodIsEmptyWhenTheContainerIsTerminated() {
        seedJob();
        seedPod("Failed", false);

        assertThat(coordinator.findLivePod(RUN)).isEmpty();
    }

    private void seedJob() {
        Job job = new JobBuilder()
            .withNewMetadata().withName(JOB_NAME).withNamespace(NS)
            .withLabels(Map.of(ResourceIdentityVerifier.LABEL_RUN_ID, RUN,
                ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT))
            .endMetadata()
            .withNewSpec().withNewTemplate().withNewSpec().endSpec().endTemplate().endSpec()
            .build();
        client.batch().v1().jobs().inNamespace(NS).resource(job).create();
    }

    private void seedPod(String phase, boolean running) {
        ContainerState state = running
            ? new ContainerStateBuilder()
                .withRunning(new ContainerStateRunningBuilder().withStartedAt("2026-09-02T00:00:00Z").build())
                .build()
            : new ContainerStateBuilder()
                .withTerminated(new ContainerStateTerminatedBuilder().withExitCode(1).build())
                .build();
        var pod = new PodBuilder()
            .withNewMetadata().withName(POD_NAME).withNamespace(NS)
            .withLabels(Map.of(ResourceIdentityVerifier.LABEL_RUN_ID, RUN,
                ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT))
            .withOwnerReferences(new OwnerReferenceBuilder()
                .withKind("Job").withName(JOB_NAME).withApiVersion("batch/v1").withUid("uid-1").build())
            .endMetadata()
            .withNewSpec().addNewContainer().withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
            .withImage("registry.example/manao/maven-runner@sha256:" + "a".repeat(64)).endContainer().endSpec()
            .withStatus(new PodStatusBuilder().withPhase(phase)
                .withContainerStatuses(new ContainerStatusBuilder()
                    .withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
                    .withImage("registry.example/manao/maven-runner@sha256:" + "a".repeat(64))
                    .withImageID("docker://sha256:" + "a".repeat(64))
                    .withReady(running)
                    .withState(state)
                    .build())
                .build())
            .build();
        client.pods().inNamespace(NS).resource(pod).create();
    }
}
