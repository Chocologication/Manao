package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.fabric8.kubernetes.api.model.EnvVarBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JobResourceFactoryTest {
    private static final String RUN = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String PROJECT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4e5f";
    private static final String IMAGE = "registry.example/manao/maven-runner@sha256:"
        + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static final String INIT_IMAGE = "registry.example/manao/busybox@sha256:"
        + "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private final JobResourceFactory factory = new JobResourceFactory(
        "manao-test", 1800, INIT_IMAGE,
        new JobResourceFactory.RunResources(1000, 1L * 1024 * 1024 * 1024, 1L * 1024 * 1024 * 1024),
        new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024),
        IMAGE);
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void jobUsesFixedDeadlineAndNeverRestarts() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        assertThat(JobResourceFactory.jobName(RUN)).isEqualTo("manao-run-" + RUN);
        assertThat(job.getMetadata().getName()).isEqualTo("manao-run-" + RUN);
        assertThat(job.getSpec().getBackoffLimit()).isEqualTo(0);
        assertThat(job.getSpec().getActiveDeadlineSeconds()).isEqualTo(1800L);
        assertThat(job.getSpec().getTemplate().getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(job.getSpec().getTemplate().getSpec().getAutomountServiceAccountToken()).isFalse();
        assertThat(job.getMetadata().getLabels()).containsEntry("manao.poc4/run-id", RUN)
            .containsEntry("stage6-test", "true")
            .containsEntry("manao.poc4/project-id", PROJECT)
            .containsEntry("app.kubernetes.io/managed-by", "manao-poc4-backend");
        assertThatNoBrowserPolicyFields(json.writeValueAsString(job));
    }

    @Test
    void jobLeavesSelectorGenerationToTheApiServer() {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        assertThat(job.getSpec().getSelector()).isNull();
        assertThat(job.getSpec().getManualSelector()).isNotEqualTo(Boolean.TRUE);
        assertThat(job.getSpec().getTemplate().getMetadata().getLabels())
            .containsEntry(ResourceIdentityVerifier.LABEL_RUN_ID, RUN)
            .containsEntry(ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT);
    }

    @Test
    void projectResourceLabelsCoverWorkspaceAndMavenResources() {
        assertThat(WorkspaceResourceFactory.projectResourceLabels(PROJECT))
            .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, PROJECT)
            .containsEntry(WorkspaceResourceFactory.LABEL_STAGE6_TEST, "true")
            .doesNotContainKey("manao.poc4/component");
    }

    @Test
    void pidOneDirectlyExecsUserCodeCommandArray() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        var container = job.getSpec().getTemplate().getSpec().getContainers().get(0);
        assertThat(container.getName()).isEqualTo("maven");
        assertThat(container.getCommand()).containsExactly("mvn", "-q", "-DskipTests", "compile", "exec:java");
        assertThat(container.getArgs()).isNullOrEmpty();
        assertThat(container.getWorkingDir()).isEqualTo("/workspace");
        assertThat(container.getImage()).isEqualTo(IMAGE);
        assertThatNoBrowserPolicyFields(json.writeValueAsString(job));
    }

    @Test
    void taskJobInjectsTheSelectedDependencyEnvironmentVerbatim() throws Exception {
        var environment = List.of(
            new EnvVarBuilder().withName("SERVER_PORT").withValue("8080").build(),
            new EnvVarBuilder().withName("MANAO_MYSQL_HOST").withValue("manao-mysql-x").build(),
            new EnvVarBuilder().withName("MANAO_MYSQL_PASSWORD").withNewValueFrom()
                .withNewSecretKeyRef().withName("manao-mysql-cred-x").withKey("password")
                .endSecretKeyRef().endValueFrom().build());
        Job job = factory.createMavenJob(RUN, PROJECT, environment);
        var names = job.getSpec().getTemplate().getSpec().getContainers().get(0).getEnv().stream()
            .map(item -> item.getName()).toList();
        assertThat(names).contains("SERVER_PORT", "MANAO_MYSQL_HOST", "MANAO_MYSQL_PASSWORD");
        assertThat(json.writeValueAsString(job)).doesNotContain("ManaoPoc4");
    }

    @Test
    void workspaceSubPathRequiresInitializedDirectoryAndTmpIsEmptyDir() {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        var spec = job.getSpec().getTemplate().getSpec();
        var workspaceMount = spec.getContainers().get(0).getVolumeMounts().stream()
            .filter(candidate -> candidate.getMountPath().equals("/workspace")).findFirst().orElseThrow();
        assertThat(workspaceMount.getSubPath()).isEqualTo("project-" + PROJECT);
        assertThat(workspaceMount.getReadOnly()).isFalse();
        assertThat(spec.getVolumes()).extracting(volume -> volume.getName()).containsExactlyInAnyOrder("workspace", "tmp");
        assertThat(spec.getVolumes()).anySatisfy(volume -> assertThat(volume.getEmptyDir()).isNotNull());
        var security = spec.getSecurityContext();
        assertThat(security.getRunAsNonRoot()).isTrue();
        assertThat(security.getRunAsUser()).isEqualTo(10001L);
        assertThat(security.getFsGroup()).isEqualTo(10001L);
    }

    @Test
    void resourcesAreBoundedByThePolicySnapshot() {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        var limits = job.getSpec().getTemplate().getSpec().getContainers().get(0).getResources().getLimits();
        assertThat(limits.get("cpu").getAmount()).isEqualTo("8");
        assertThat(limits.get("memory").getAmount()).isEqualTo("16").satisfies(amount -> {
            assertThat(limits.get("memory").getFormat()).isEqualTo("Gi");
        });
        assertThat(limits.get("ephemeral-storage").getAmount()).isEqualTo("10");
        var requests = job.getSpec().getTemplate().getSpec().getContainers().get(0).getResources().getRequests();
        assertThat(requests.get("cpu").getAmount()).isEqualTo("1");
    }

    @Test
    void byteQuantitiesSerializeAsAlignedPowerOfTwoSuffixes() {
        // MiB-aligned but not GiB-aligned values keep the Mi suffix instead of degrading to bytes.
        assertThat(JobResourceFactory.bytesQuantity(512L * 1024 * 1024).getFormat()).isEqualTo("Mi");
        assertThat(JobResourceFactory.bytesQuantity(512L * 1024 * 1024).getAmount()).isEqualTo("512");
        // GiB-aligned values keep the Gi suffix.
        assertThat(JobResourceFactory.bytesQuantity(3L * 1024 * 1024 * 1024).getFormat()).isEqualTo("Gi");
        assertThat(JobResourceFactory.bytesQuantity(3L * 1024 * 1024 * 1024).getAmount()).isEqualTo("3");
        // Unaligned values degrade to raw bytes.
        assertThat(JobResourceFactory.bytesQuantity(3L * 1024 * 1024 * 1024 + 7).getFormat()).isEmpty();
        assertThat(JobResourceFactory.bytesQuantity(3L * 1024 * 1024 * 1024 + 7).getAmount())
            .isEqualTo(String.valueOf(3L * 1024 * 1024 * 1024 + 7));
    }

    @Test
    void jobCarriesNoServiceAccountTokenOrBrowserInput() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT, List.of());
        assertThat(job.getSpec().getTemplate().getSpec().getServiceAccountName()).isEqualTo("manao-maven-runner");
        String serialized = json.writeValueAsString(job);
        assertThat(serialized).doesNotContain("portforward");
        for (String forbidden : java.util.List.of("insecure-skip-tls-verify", "hostPath")) {
            assertThat(serialized).doesNotContain(forbidden);
        }
        // Environment is fixed by the server; no user-provided values exist anywhere in the manifest.
        job.getSpec().getTemplate().getSpec().getContainers().get(0).getEnv()
            .forEach(item -> assertThat(Map.of("TMPDIR", "x", "HOME", "x")).containsKey(item.getName()));
    }

    @Test
    void serviceJobBindsASingleExecutionToTheSupervisorWithTheStartupBudgetAndLifetime() throws Exception {
        Instant startupDeadline = Instant.parse("2026-09-21T10:30:00Z");
        Job job = factory.createServiceJob(RUN, PROJECT, startupDeadline, 7200, 8080, List.of());
        var spec = job.getSpec();
        assertThat(spec.getParallelism()).isEqualTo(1);
        assertThat(spec.getCompletions()).isEqualTo(1);
        assertThat(spec.getBackoffLimit()).isEqualTo(0);
        // 1800 startup budget + 7200 fixed lifetime is only the last-resort backstop.
        assertThat(spec.getActiveDeadlineSeconds()).isEqualTo(9000L);
        assertThat(spec.getTemplate().getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(spec.getTemplate().getSpec().getAutomountServiceAccountToken()).isFalse();
        var container = spec.getTemplate().getSpec().getContainers().get(0);
        assertThat(container.getName()).isEqualTo("maven");
        assertThat(container.getCommand())
            .containsExactly("/usr/local/bin/manao-run-supervisor", "run");
        assertThat(container.getPorts()).isNullOrEmpty();
        Map<String, String> env = new java.util.HashMap<>();
        container.getEnv().forEach(item -> {
            if (item.getValue() != null) env.put(item.getName(), item.getValue());
        });
        assertThat(env.get("MANAO_RUN_ID")).isEqualTo(RUN);
        assertThat(env.get("MANAO_PROJECT_ID")).isEqualTo(PROJECT);
        assertThat(env.get("MANAO_RUN_STARTUP_DEADLINE")).isEqualTo("2026-09-21T10:30:00Z");
        assertThat(env.get("MANAO_PRIMARY_PORT")).isEqualTo("8080");
        assertThat(env.get("MANAO_RUN_CONTROL_DIR")).isEqualTo("/run-control");
        assertThat(env.get("MANAO_SERVICE_LIFETIME_SECONDS")).isEqualTo("7200");
        var podUidEnv = container.getEnv().stream()
            .filter(item -> "MANAO_POD_UID".equals(item.getName())).findFirst().orElseThrow();
        assertThat(podUidEnv.getValueFrom().getFieldRef().getFieldPath()).isEqualTo("metadata.uid");
        assertThatNoBrowserPolicyFields(json.writeValueAsString(job));
    }

    @Test
    void serviceJobReadinessProbeRunsTheSupervisorProbeWithoutExtraPorts() {
        Job job = factory.createServiceJob(RUN, PROJECT, Instant.now(), 7200, 8080, List.of());
        var container = job.getSpec().getTemplate().getSpec().getContainers().get(0);
        var probe = container.getReadinessProbe();
        assertThat(probe).isNotNull();
        assertThat(probe.getExec().getCommand())
            .containsExactly("/usr/local/bin/manao-run-supervisor", "probe");
        assertThat(probe.getHttpGet()).isNull();
        assertThat(container.getTerminationMessagePath()).isEqualTo("/tmp/manao-termination.log");
        assertThat(container.getTerminationMessagePolicy()).isEqualTo("File");
    }

    @Test
    void serviceJobMountsTheControlDirectoryFromTheWorkspacePvcWithoutDeletingOldClaims() throws Exception {
        Job job = factory.createServiceJob(RUN, PROJECT, Instant.now(), 7200, 8080, List.of());
        var spec = job.getSpec().getTemplate().getSpec();
        var mounts = spec.getContainers().get(0).getVolumeMounts();
        assertThat(mounts).extracting(mount -> mount.getMountPath())
            .containsExactlyInAnyOrder("/workspace", "/run-control", "/tmp");
        var controlMount = mounts.stream().filter(mount -> mount.getMountPath().equals("/run-control"))
            .findFirst().orElseThrow();
        assertThat(controlMount.getSubPath()).isEqualTo("project-" + PROJECT + "/.manao-runs/" + RUN);
        assertThat(controlMount.getReadOnly()).isFalse();

        // The init container only creates this run's control directory; no old claim is removed.
        assertThat(spec.getInitContainers()).hasSize(1);
        var init = spec.getInitContainers().get(0);
        assertThat(init.getCommand()).containsExactly("mkdir", "-p", "/control/.manao-runs/" + RUN);
        assertThat(json.writeValueAsString(job)).doesNotContain("rm ");
        assertThat(init.getSecurityContext().getRunAsNonRoot()).isTrue();
        assertThat(init.getSecurityContext().getAllowPrivilegeEscalation()).isFalse();
    }

    @Test
    void servicePodEnablesLowPortBindingThroughASafePodSysctlWithoutRoot() {
        Job job = factory.createServiceJob(RUN, PROJECT, Instant.now(), 7200, 8080, List.of());
        var spec = job.getSpec().getTemplate().getSpec();
        var security = spec.getSecurityContext();
        assertThat(security.getRunAsNonRoot()).isTrue();
        assertThat(security.getRunAsUser()).isEqualTo(10001L);
        assertThat(spec.getShareProcessNamespace()).isNotEqualTo(Boolean.TRUE);
        assertThat(security.getSysctls()).isNotNull();
        assertThat(security.getSysctls()).anySatisfy(sysctl -> {
            assertThat(sysctl.getName()).isEqualTo("net.ipv4.ip_unprivileged_port_start");
            assertThat(sysctl.getValue()).isEqualTo("0");
        });
    }

    private void assertThatNoBrowserPolicyFields(String serialized) {
        // The run API never echoes image/env to the browser; the Job manifest itself is server-owned.
        assertThat(serialized).doesNotContain("browser-command");
    }
}
