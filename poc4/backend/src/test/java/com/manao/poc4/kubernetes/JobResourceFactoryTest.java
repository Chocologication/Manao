package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JobResourceFactoryTest {
    private static final String RUN = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String PROJECT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4e5f";
    private final JobResourceFactory factory = new JobResourceFactory(
        "manao-test", 1800,
        new JobResourceFactory.RunResources(1000, 1L * 1024 * 1024 * 1024, 1L * 1024 * 1024 * 1024),
        new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024),
        "registry.example/manao/maven-runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void jobUsesFixedDeadlineAndNeverRestarts() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT);
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
        Job job = factory.createMavenJob(RUN, PROJECT);
        assertThat(job.getSpec().getSelector()).isNull();
        assertThat(job.getSpec().getManualSelector()).isNotEqualTo(Boolean.TRUE);
        assertThat(job.getSpec().getTemplate().getMetadata().getLabels())
            .containsEntry(ResourceIdentityVerifier.LABEL_RUN_ID, RUN)
            .containsEntry(ResourceIdentityVerifier.LABEL_PROJECT_ID, PROJECT);
    }

    @Test
    void pidOneDirectlyExecsFixedMavenCommandArray() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT);
        var container = job.getSpec().getTemplate().getSpec().getContainers().get(0);
        assertThat(container.getName()).isEqualTo("maven");
        assertThat(container.getCommand()).containsExactly("mvn", "clean", "test");
        assertThat(container.getArgs()).isNullOrEmpty();
        assertThat(container.getWorkingDir()).isEqualTo("/workspace");
        assertThat(container.getImage()).isEqualTo("registry.example/manao/maven-runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        assertThatNoBrowserPolicyFields(json.writeValueAsString(job));
    }

    @Test
    void workspaceSubPathRequiresInitializedDirectoryAndTmpIsEmptyDir() {
        Job job = factory.createMavenJob(RUN, PROJECT);
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
        Job job = factory.createMavenJob(RUN, PROJECT);
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
    void jobCarriesNoServiceAccountTokenOrBrowserInput() throws Exception {
        Job job = factory.createMavenJob(RUN, PROJECT);
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

    private void assertThatNoBrowserPolicyFields(String serialized) {
        // The run API never echoes image/env to the browser; the Job manifest itself is server-owned.
        assertThat(serialized).doesNotContain("browser-command");
    }
}
