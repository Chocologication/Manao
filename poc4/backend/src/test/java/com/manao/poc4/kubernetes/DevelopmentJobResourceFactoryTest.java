package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.ai.AgentContracts.BuildGoal;
import com.manao.poc4.ai.AgentContracts.BuildRequest;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import org.junit.jupiter.api.Test;

/**
 * Manifest shape of the isolated development build (stage one, design section 5): a read-only
 * source copy by a fixed init container into a scratch emptyDir, an execution container that
 * never sees the source mount, the shared cache preparation, and the single-run security
 * envelope — every value is server policy derived from the BuildRequest alone.
 */
class DevelopmentJobResourceFactoryTest {
    private static final String TASK = "task-1";
    private static final String CALL = "call-1";
    private static final String PROJECT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4e5f";
    private static final String COMMAND = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String IMAGE = "registry.example/manao/maven-runner@sha256:"
        + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static final String INIT_IMAGE = "registry.example/manao/busybox@sha256:"
        + "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private static final JobResourceFactory.RunResources REQUESTS =
        new JobResourceFactory.RunResources(1000, 1L * 1024 * 1024 * 1024, 1L * 1024 * 1024 * 1024);
    private static final JobResourceFactory.RunResources LIMITS =
        new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024);
    private static final JobResourceFactory.DevelopmentSourceVolume SOURCE =
        new JobResourceFactory.DevelopmentSourceVolume("nfs.example", "/export/manao-workspaces");
    private final JobResourceFactory factory = new JobResourceFactory(
        "manao-test", 1800, INIT_IMAGE, REQUESTS, LIMITS, IMAGE, pythonImageDigest());
    private final ObjectMapper json = new ObjectMapper();

    private static String pythonImageDigest() {
        return "registry.example/manao/python-runner@sha256:"
            + "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    }

    private static BuildRequest request(BuildGoal goal) {
        return new BuildRequest(TASK, CALL, PROJECT, COMMAND, 7L, goal);
    }

    @Test
    void theBuildJobNameIsDeterministicFromTheCommandId() {
        assertThat(JobResourceFactory.developmentJobName(COMMAND)).isEqualTo("manao-dev-" + COMMAND);
    }

    @Test
    void developmentBuildIsASingleRunOfTheFixedLauncher() throws Exception {
        Job job = factory.createDevelopmentJob(request(BuildGoal.TEST), SOURCE);
        assertThat(job.getMetadata().getName()).isEqualTo("manao-dev-" + COMMAND);
        assertThat(job.getSpec().getParallelism()).isEqualTo(1);
        assertThat(job.getSpec().getCompletions()).isEqualTo(1);
        assertThat(job.getSpec().getBackoffLimit()).isZero();
        // One build is bounded by its own 600 s deadline, not the application-run budget.
        assertThat(job.getSpec().getActiveDeadlineSeconds()).isEqualTo(600L);
        assertThat(job.getSpec().getTemplate().getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(job.getSpec().getTemplate().getSpec().getAutomountServiceAccountToken()).isFalse();
        var main = job.getSpec().getTemplate().getSpec().getContainers().get(0);
        assertThat(main.getCommand()).containsExactly("/usr/local/bin/manao-dev-build", "run", "test");
        assertThat(main.getWorkingDir()).isEqualTo("/workspace");
        assertThat(main.getImage()).isEqualTo(IMAGE);
        assertThatNoBrowserPolicyFields(json.writeValueAsString(job));
    }

    @Test
    void everyGoalMapsToItsFixedLowercaseArgument() {
        assertThat(factory.createDevelopmentJob(request(BuildGoal.COMPILE), SOURCE)
            .getSpec().getTemplate().getSpec().getContainers().get(0).getCommand())
            .containsExactly("/usr/local/bin/manao-dev-build", "run", "compile");
        assertThat(factory.createDevelopmentJob(request(BuildGoal.PACKAGE), SOURCE)
            .getSpec().getTemplate().getSpec().getContainers().get(0).getCommand())
            .containsExactly("/usr/local/bin/manao-dev-build", "run", "package");
    }

    @Test
    void theMainContainerNeverSeesTheSourceMountOrThePvcRoot() {
        Job job = factory.createDevelopmentJob(request(BuildGoal.TEST), SOURCE);
        var spec = job.getSpec().getTemplate().getSpec();
        var main = spec.getContainers().get(0);
        assertThat(main.getName()).isEqualTo(ResourceIdentityVerifier.APPLICATION_CONTAINER);
        assertThat(main.getVolumeMounts()).extracting(mount -> mount.getMountPath())
            .doesNotContain("/source")
            .containsExactlyInAnyOrder("/workspace", "/maven-cache", "/tmp");
        // The only PVC-backed volume is the writable cache; the main container references
        // only the scratch and tmp volumes, so it cannot reach the source at all.
        var volumeNames = main.getVolumeMounts().stream().map(mount -> mount.getName()).toList();
        assertThat(volumeNames).doesNotContain("source");
        assertThat(spec.getVolumes()).extracting(volume -> volume.getName())
            .containsExactlyInAnyOrder("workspace", "tmp", "source", "cache");
        var scratch = spec.getVolumes().stream()
            .filter(volume -> "workspace".equals(volume.getName())).findFirst().orElseThrow();
        assertThat(scratch.getEmptyDir()).isNotNull();
        // The read-only source comes through a dedicated NFS volume (volume-level readOnly):
        // this stage's cluster cannot mix a read-only and a read-write mount of one PVC, so
        // the source volume is no longer a PVC entry at all.
        var source = spec.getVolumes().stream()
            .filter(volume -> "source".equals(volume.getName())).findFirst().orElseThrow();
        assertThat(source.getNfs()).isNotNull();
        assertThat(source.getNfs().getServer()).isEqualTo(SOURCE.nfsServer());
        assertThat(source.getNfs().getPath()).isEqualTo(SOURCE.nfsPath());
        assertThat(source.getNfs().getReadOnly()).isTrue();
        assertThat(source.getPersistentVolumeClaim()).isNull();
        // The writable cache is still the project PVC.
        var cache = spec.getVolumes().stream()
            .filter(volume -> "cache".equals(volume.getName())).findFirst().orElseThrow();
        assertThat(cache.getPersistentVolumeClaim().getClaimName())
            .isEqualTo(WorkspaceResourceFactory.pvcName(PROJECT));
        assertThat(cache.getPersistentVolumeClaim().getReadOnly()).isFalse();
    }

    @Test
    void theDevelopmentSourceVolumeRequiresBothNfsEndpoints() {
        assertThatThrownBy(() -> new JobResourceFactory.DevelopmentSourceVolume(" ", "/export/manao"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new JobResourceFactory.DevelopmentSourceVolume("nfs.example", ""))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new JobResourceFactory.DevelopmentSourceVolume("nfs.example", null))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theInitContainersCopyTheReadOnlySourceIntoTheScratch() throws Exception {
        Job job = factory.createDevelopmentJob(request(BuildGoal.TEST), SOURCE);
        var spec = job.getSpec().getTemplate().getSpec();
        assertThat(spec.getInitContainers()).hasSize(2);
        var copy = spec.getInitContainers().stream()
            .filter(container -> "source-copy".equals(container.getName())).findFirst().orElseThrow();
        assertThat(copy.getImage()).isEqualTo(IMAGE);
        assertThat(copy.getCommand()).containsExactly("/usr/local/bin/manao-dev-build", "copy");
        var mounts = copy.getVolumeMounts();
        // The launcher's mktemp needs a WRITABLE /tmp under the read-only root filesystem
        // (review fix I4): the copy container mounts the same tmp emptyDir the main
        // container uses, so the copy phase can never fail on its own manifest file.
        assertThat(mounts).extracting(mount -> mount.getMountPath())
            .containsExactlyInAnyOrder("/source", "/workspace", "/tmp");
        var tmp = mounts.stream().filter(mount -> mount.getMountPath().equals("/tmp"))
            .findFirst().orElseThrow();
        assertThat(tmp.getName()).isEqualTo("tmp");
        // null means the Kubernetes default (writable); it must never be read-only.
        assertThat(tmp.getReadOnly()).isNotEqualTo(Boolean.TRUE);
        // The copy container runs under the exact production security envelope.
        assertThat(copy.getSecurityContext().getReadOnlyRootFilesystem()).isTrue();
        assertThat(copy.getSecurityContext().getRunAsUser())
            .isEqualTo(WorkspaceResourceFactory.WORKSPACE_UID);
        var source = mounts.stream().filter(mount -> mount.getMountPath().equals("/source"))
            .findFirst().orElseThrow();
        assertThat(source.getName()).isEqualTo("source");
        assertThat(source.getSubPath()).isEqualTo("project-" + PROJECT);
        assertThat(source.getReadOnly()).isTrue();
        // The shared cache preparation keeps its root-mount repair role.
        var prep = spec.getInitContainers().stream()
            .filter(container -> "prepare-maven-cache".equals(container.getName())).findFirst().orElseThrow();
        assertThat(prep.getVolumeMounts().get(0).getSubPath())
            .as("cache preparation must root-mount the workspace PVC").isNull();
        assertThat(json.writeValueAsString(job)).doesNotContain("rm ");
    }

    @Test
    void theDevelopmentJobCarriesTheProjectAndToolCallIdentity() {
        Job job = factory.createDevelopmentJob(request(BuildGoal.TEST), SOURCE);
        var labels = job.getMetadata().getLabels();
        assertThat(labels)
            .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, PROJECT)
            .containsEntry(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND)
            .containsEntry(JobResourceFactory.LABEL_COMPONENT, JobResourceFactory.COMPONENT_DEVELOPMENT_BUILD);
        // Template labels let the project cleaner inventory the job by identity, not by name.
        assertThat(job.getSpec().getTemplate().getMetadata().getLabels())
            .containsEntry(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND);
    }

    @Test
    void theDevelopmentJobSharesTheRunSecurityEnvelope() {
        Job job = factory.createDevelopmentJob(request(BuildGoal.TEST), SOURCE);
        var spec = job.getSpec().getTemplate().getSpec();
        var security = spec.getSecurityContext();
        assertThat(security.getRunAsNonRoot()).isTrue();
        assertThat(security.getRunAsUser()).isEqualTo(10001L);
        assertThat(security.getRunAsGroup()).isEqualTo(10001L);
        assertThat(security.getFsGroup()).isEqualTo(10001L);
        var main = spec.getContainers().get(0);
        assertThat(main.getSecurityContext().getReadOnlyRootFilesystem()).isTrue();
        assertThat(main.getSecurityContext().getAllowPrivilegeEscalation()).isFalse();
        var limits = main.getResources().getLimits();
        assertThat(limits.get("cpu").getAmount()).isEqualTo("8");
        assertThat(limits.get("memory").getAmount()).isEqualTo("16");
        assertThat(main.getEnv()).extracting(env -> env.getName())
            .containsExactlyInAnyOrder("TMPDIR", "HOME");
    }

    private void assertThatNoBrowserPolicyFields(String serialized) {
        assertThat(serialized).doesNotContain("browser-command", "hostPath");
    }
}
