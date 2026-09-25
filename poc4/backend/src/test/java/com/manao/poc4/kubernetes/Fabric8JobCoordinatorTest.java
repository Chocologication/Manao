package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.JobCoordinator.JobObservation;
import com.manao.poc4.kubernetes.JobCoordinator.ObservationKind;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.ContainerState;
import io.fabric8.kubernetes.api.model.ContainerStateBuilder;
import io.fabric8.kubernetes.api.model.ContainerStateRunningBuilder;
import io.fabric8.kubernetes.api.model.ContainerStateTerminatedBuilder;
import io.fabric8.kubernetes.api.model.ContainerStatusBuilder;
import io.fabric8.kubernetes.api.model.OwnerReferenceBuilder;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Fabric8 mock-server (CRUD) coverage for the run observation used by the lifecycle loops:
 * identity-verified Job/Pod chains (UID level), the fixed receipt exec while the application
 * container lives, and the termination message after it exits. The mock API server assigns UIDs
 * like the real one, so every fixture reads the assigned UIDs back.
 */
class Fabric8JobCoordinatorTest {
    private static final String NS = "manao";
    private static final String RUN = "run-1";
    private static final String PROJECT = "prj-1";
    private static final String JOB_NAME = JobResourceFactory.jobName(RUN);
    private static final String POD_NAME = JOB_NAME + "-abcde";
    private static final String IMAGE = "registry.example/manao/maven-runner@sha256:" + "a".repeat(64);

    KubernetesMockServer server;
    KubernetesClient client;
    StubExecTransport exec;
    Fabric8JobCoordinator coordinator;

    @BeforeEach
    void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        client = server.createClient();
        exec = new StubExecTransport();
        coordinator = new Fabric8JobCoordinator(client,
            new JobResourceFactory(NS, 1800, "registry.example/manao/busybox@sha256:" + "d".repeat(64),
                new JobResourceFactory.RunResources(500, 1024L * 1024 * 1024, 1024L * 1024 * 1024),
                new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024),
                IMAGE),
            new ResourceIdentityVerifier(), NS, exec);
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    private RunRecord run() {
        return run(null);
    }

    private RunRecord run(String executionPodUid) {
        return new RunRecord(RUN, PROJECT, 0, RunState.RUNNING, "{}", JOB_NAME,
            null, null, null, null, null, 0L, Instant.parse("2026-09-21T10:00:00Z"), 0L,
            null, null, executionPodUid, null);
    }

    @Test
    void findLivePodReturnsVerifiedPodWhenApplicationContainerIsRunning() {
        Job job = seedJob();
        seedPod(job, "Running", true, null);

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
        Job job = seedJob();
        seedPod(job, "Failed", false, null);

        assertThat(coordinator.findLivePod(RUN)).isEmpty();
    }

    @Test
    void observeReturnsFoundWithTheVerifiedLiveReceipt() {
        Job job = seedJob();
        String podUid = seedPod(job, "Running", true, null);
        exec.output = readyReceipt(podUid);

        JobObservation observation = coordinator.observe(run());

        assertThat(observation.kind()).isEqualTo(ObservationKind.FOUND);
        assertThat(observation.facts().running()).isTrue();
        assertThat(observation.facts().podUid()).isEqualTo(podUid);
        assertThat(observation.facts().applicationTerminated()).isFalse();
        assertThat(observation.receipt()).isNotNull();
        assertThat(observation.receipt().state()).isEqualTo("READY");
        // The exec is the fixed command in the verified pod/container only.
        assertThat(exec.commands).containsExactly(
            POD_NAME + "|" + ResourceIdentityVerifier.APPLICATION_CONTAINER + "|[cat, /run-control/receipt.properties]");
    }

    @Test
    void observeNeverTrustsAReceiptFromAnotherRunOrPod() {
        Job job = seedJob();
        String podUid = seedPod(job, "Running", true, null);
        exec.output = readyReceipt(podUid).replace("runId=" + RUN, "runId=other-run");

        JobObservation wrongRun = coordinator.observe(run());
        assertThat(wrongRun.kind()).isEqualTo(ObservationKind.FOUND);
        assertThat(wrongRun.receipt()).isNull();

        exec.output = readyReceipt("another-pod-uid");
        JobObservation wrongPod = coordinator.observe(run());
        assertThat(wrongPod.kind()).isEqualTo(ObservationKind.FOUND);
        assertThat(wrongPod.receipt()).isNull();
    }

    @Test
    void observeReadsTheTerminationMessageAfterTheContainerExits() {
        Job job = seedJob();
        String podUid = seedPod(job, "Failed", false, null);
        String terminationMessage = "protocol=1\nprojectId=" + PROJECT + "\nrunId=" + RUN
            + "\npodUid=" + podUid + "\nstate=TIMED_OUT\nfirstReadyAt=2026-09-21T10:05:00Z\n"
            + "expiresAt=2026-09-21T12:05:00Z\nreason=TIME_LIMIT_EXCEEDED\n";
        client.pods().inNamespace(NS).withName(POD_NAME).edit(pod ->
            new PodBuilder(pod).editStatus().editContainerStatus(0).editState()
                .editOrNewTerminated().withExitCode(124).withMessage(terminationMessage)
                .endTerminated().endState().endContainerStatus().endStatus().build());

        JobObservation observation = coordinator.observe(run());

        assertThat(observation.kind()).isEqualTo(ObservationKind.FOUND);
        assertThat(observation.facts().applicationTerminated()).isTrue();
        assertThat(observation.facts().exitCode()).isEqualTo(124);
        assertThat(observation.facts().running()).isFalse();
        assertThat(observation.receipt()).isNotNull();
        assertThat(observation.receipt().state()).isEqualTo("TIMED_OUT");
        assertThat(exec.commands).isEmpty(); // a terminated container never gets an exec
    }

    @Test
    void observeRejectsAnOwnerReferenceWhoseUidIsNotTheJobUid() {
        Job job = seedJob();
        seedPod(job, "Running", true, null, "foreign-job-uid");

        JobObservation observation = coordinator.observe(run());

        assertThat(observation.kind()).isEqualTo(ObservationKind.IDENTITY_MISMATCH);
    }

    @Test
    void observeReturnsMissingWhenTheJobAndEveryMatchingPodAreGone() {
        JobObservation observation = coordinator.observe(run());
        assertThat(observation.kind()).isEqualTo(ObservationKind.MISSING);
    }

    @Test
    void observeReturnsUnknownWhileTheJobIsGoneButPodsAreStillActive() {
        seedOrphanPod();
        JobObservation observation = coordinator.observe(run());
        assertThat(observation.kind()).isEqualTo(ObservationKind.UNKNOWN);
    }

    @Test
    void observeReturnsUnknownForAPodThatIsNotObservableYet() {
        Job job = seedJob();
        seedPod(job, "Pending", false, null);
        JobObservation observation = coordinator.observe(run());
        assertThat(observation.kind()).isEqualTo(ObservationKind.UNKNOWN);
    }

    @Test
    void observeReadsOnlyTheClaimedPodWhenAReplacementAppears() {
        Job job = seedJob();
        String podUid = seedPod(job, "Running", true, null);
        // A replacement Pod shares the run label only; the claimed UID stays recorded on the run.
        Pod replacement = client.pods().inNamespace(NS).withName(POD_NAME).get();
        client.pods().inNamespace(NS).resource(new PodBuilder(replacement)
            .editMetadata().withName(JOB_NAME + "-replacement").withUid("pod-uid-replacement").endMetadata()
            .build()).create();

        exec.output = readyReceipt(podUid);
        JobObservation observation = coordinator.observe(run(podUid));

        assertThat(observation.kind()).isEqualTo(ObservationKind.FOUND);
        assertThat(observation.facts().podName()).isEqualTo(POD_NAME);
        assertThat(exec.commands).hasSize(1);
        assertThat(exec.commands.get(0)).startsWith(POD_NAME + "|");
    }

    @Test
    void observeRefusesToGuessWhenTwoPodsExistWithoutARecordedClaim() {
        Job job = seedJob();
        seedPod(job, "Running", true, null);
        Pod replacement = client.pods().inNamespace(NS).withName(POD_NAME).get();
        client.pods().inNamespace(NS).resource(new PodBuilder(replacement)
            .editMetadata().withName(JOB_NAME + "-replacement").withUid("pod-uid-replacement").endMetadata()
            .build()).create();

        assertThat(coordinator.observe(run()).kind()).isEqualTo(ObservationKind.IDENTITY_MISMATCH);
    }

    @Test
    void observeRefusesToGuessWhenTheRecordedClaimedPodDisappearedAmongOthers() {
        Job job = seedJob();
        seedPod(job, "Running", true, null);

        assertThat(coordinator.observe(run("pod-uid-gone")).kind())
            .isEqualTo(ObservationKind.IDENTITY_MISMATCH);
    }

    private String readyReceipt(String podUid) {
        return "protocol=1\nprojectId=" + PROJECT + "\nrunId=" + RUN
            + "\npodUid=" + podUid + "\nstate=READY\nfirstReadyAt=2026-09-21T10:05:00Z\n"
            + "expiresAt=2026-09-21T12:05:00Z\nreason=\n";
    }

    private Job seedJob() {
        Job job = new JobBuilder()
            .withNewMetadata().withName(JOB_NAME).withNamespace(NS)
            .withLabels(Map.of(ResourceIdentityVerifier.LABEL_RUN_ID, RUN,
                ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT))
            .endMetadata()
            .withNewSpec().withNewTemplate().withNewSpec().endSpec().endTemplate().endSpec()
            .build();
        client.batch().v1().jobs().inNamespace(NS).resource(job).create();
        return client.batch().v1().jobs().inNamespace(NS).withName(JOB_NAME).get();
    }

    /** An orphan pod (no Job object) that still matches the run label. */
    private void seedOrphanPod() {
        var pod = new PodBuilder()
            .withNewMetadata().withName(POD_NAME).withNamespace(NS).withUid("orphan-pod-uid")
            .withLabels(Map.of(ResourceIdentityVerifier.LABEL_RUN_ID, RUN,
                ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT))
            .endMetadata()
            .withNewSpec().addNewContainer().withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
            .withImage(IMAGE).endContainer().endSpec()
            .withNewStatus().withPhase("Running")
            .addNewContainerStatus().withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
            .withNewState().withNewRunning().endRunning().endState().endContainerStatus()
            .endStatus()
            .build();
        client.pods().inNamespace(NS).resource(pod).create();
    }

    /** Creates the run pod and returns the server-assigned Pod UID used inside the receipts. */
    private String seedPod(Job job, String phase, boolean running, String terminationMessage) {
        return seedPod(job, phase, running, terminationMessage, job.getMetadata().getUid());
    }

    private String seedPod(Job job, String phase, boolean running, String terminationMessage, String ownerUid) {
        ContainerState state = running
            ? new ContainerStateBuilder()
                .withRunning(new ContainerStateRunningBuilder().withStartedAt("2026-09-02T00:00:00Z").build())
                .build()
            : new ContainerStateBuilder()
                .withTerminated(new ContainerStateTerminatedBuilder().withExitCode(124)
                    .withMessage(terminationMessage).build())
                .build();
        var pod = new PodBuilder()
            .withNewMetadata().withName(POD_NAME).withNamespace(NS).withUid("requested-pod-uid")
            .withLabels(Map.of(ResourceIdentityVerifier.LABEL_RUN_ID, RUN,
                ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT))
            .withOwnerReferences(new OwnerReferenceBuilder()
                .withKind("Job").withName(JOB_NAME).withApiVersion("batch/v1").withUid(ownerUid).build())
            .endMetadata()
            .withNewSpec().addNewContainer().withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
            .withImage(IMAGE).endContainer().endSpec()
            .withStatus(new PodStatusBuilder().withPhase(phase)
                .withContainerStatuses(new ContainerStatusBuilder()
                    .withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
                    .withImage(IMAGE)
                    .withImageID("docker://sha256:" + "a".repeat(64))
                    .withReady(running)
                    .withState(state)
                    .build())
                .build())
            .build();
        client.pods().inNamespace(NS).resource(pod).create();
        return client.pods().inNamespace(NS).withName(POD_NAME).get().getMetadata().getUid();
    }

    /** Exec double for the fixed receipt read; records every command for identity assertions. */
    static final class StubExecTransport implements ExecTransport {
        final List<String> commands = new ArrayList<>();
        String output = "";
        int exitCode;

        @Override public ExecProcess exec(String podName, String containerName, List<String> command,
                                          int cols, int rows, boolean pty) {
            commands.add(podName + "|" + containerName + "|" + command);
            ByteArrayInputStream stream = new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8));
            return new ExecProcess() {
                @Override public OutputStream stdin() {
                    return OutputStream.nullOutputStream();
                }

                @Override public InputStream stdout() {
                    return stream;
                }

                @Override public InputStream stderr() {
                    return InputStream.nullInputStream();
                }

                @Override public void resize(int newCols, int newRows) { }

                @Override public void close() { }

                @Override public Integer waitFor(long timeout, TimeUnit unit) {
                    return exitCode;
                }
            };
        }
    }
}
