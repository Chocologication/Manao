package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Service;
import java.util.Map;
import org.junit.jupiter.api.Test;

class WorkspaceResourceFactoryTest {
    private static final String DIGEST_A = "sha256:" + "a".repeat(64);
    private static final String DIGEST_B = "sha256:" + "b".repeat(64);
    private static final String PROJECT = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String NAMESPACE = "manao-test";
    private final WorkspaceResourceFactory factory =
        new WorkspaceResourceFactory(NAMESPACE, "rwx-storage", "registry.example/manao/workspace-agent@" + DIGEST_A, "registry.example/manao/initializer@" + DIGEST_B);
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void pvcUsesFixedSizeAndReadWriteMany() throws Exception {
        PersistentVolumeClaim pvc = factory.createPvc(PROJECT);
        assertThat(WorkspaceResourceFactory.pvcName(PROJECT)).isEqualTo("manao-pvc-" + PROJECT);
        assertThat(pvc.getMetadata().getName()).isEqualTo("manao-pvc-" + PROJECT);
        assertThat(pvc.getMetadata().getNamespace()).isEqualTo(NAMESPACE);
        assertThat(pvc.getSpec().getAccessModes()).containsExactly("ReadWriteMany");
        var storage = pvc.getSpec().getResources().getRequests().get("storage");
        assertThat(storage.getAmount()).isEqualTo("10");
        assertThat(storage.getFormat()).isEqualTo("Gi");
        assertThat(pvc.getSpec().getStorageClassName()).isEqualTo("rwx-storage");
        assertThat(pvc.getMetadata().getLabels()).containsEntry("manao.poc4/project-id", PROJECT);
        assertNoForbiddenFields(json.writeValueAsString(pvc));
    }

    @Test
    void initializerMountsPvcRootAndCreatesDirectoryWithFixedOwnership() throws Exception {
        Pod initializer = factory.createInitializerPod(PROJECT);
        assertThat(initializer.getMetadata().getName()).isEqualTo("manao-ws-init-" + PROJECT);
        assertThat(initializer.getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(initializer.getSpec().getActiveDeadlineSeconds()).isEqualTo(600L);
        assertThat(initializer.getSpec().getAutomountServiceAccountToken()).isFalse();
        var volume = initializer.getSpec().getVolumes().get(0);
        assertThat(volume.getPersistentVolumeClaim().getClaimName()).isEqualTo("manao-pvc-" + PROJECT);
        assertThat(volume.getPersistentVolumeClaim().getReadOnly()).isFalse();
        assertThat(initializer.getSpec().getContainers()).hasSize(1);
        var create = initializer.getSpec().getInitContainers().get(0);
        assertThat(create.getVolumeMounts().get(0).getMountPath()).isEqualTo("/data");
        assertThat(create.getVolumeMounts().get(0).getSubPath()).isNull();
        // create-directory runs as an init container: strict ordering before the non-root probe.
        assertThat(initializer.getSpec().getInitContainers()).hasSize(1);
        assertThat(initializer.getSpec().getInitContainers().get(0).getName()).isEqualTo("create-directory");
        assertThat(String.join(" ", create.getCommand())).contains("mkdir -p /data/project-" + PROJECT);
        assertThat(String.join(" ", create.getCommand())).contains("chown 10001:10001");
        var probe = initializer.getSpec().getContainers().get(0);
        assertThat(probe.getSecurityContext().getRunAsUser()).isEqualTo(10001L);
        assertThat(probe.getSecurityContext().getRunAsGroup()).isEqualTo(10001L);
        assertNoForbiddenFields(json.writeValueAsString(initializer));
    }

    @Test
    void workspacePodMountsOnlyItsSubPathAndExposesNoPrivateKey() throws Exception {
        Pod pod = factory.createWorkspacePod(PROJECT, "cHVibGljLWtleQ==");
        assertThat(pod.getMetadata().getName()).isEqualTo("manao-ws-" + PROJECT);
        assertThat(pod.getMetadata().getNamespace()).isEqualTo(NAMESPACE);
        var podSecurity = pod.getSpec().getSecurityContext();
        assertThat(podSecurity.getRunAsNonRoot()).isTrue();
        assertThat(podSecurity.getRunAsUser()).isEqualTo(10001L);
        assertThat(podSecurity.getRunAsGroup()).isEqualTo(10001L);
        assertThat(podSecurity.getFsGroup()).isEqualTo(10001L);
        assertThat(podSecurity.getSeccompProfile().getType()).isEqualTo("RuntimeDefault");
        assertThat(pod.getSpec().getAutomountServiceAccountToken()).isFalse();
        assertThat(pod.getSpec().getServiceAccountName()).isEqualTo(WorkspaceResourceFactory.WORKSPACE_SERVICE_ACCOUNT);
        assertThat(pod.getMetadata().getLabels()).containsEntry(WorkspaceResourceFactory.LABEL_STAGE6_TEST, "true");
        var container = pod.getSpec().getContainers().get(0);
        assertThat(container.getName()).isEqualTo("workspace-agent");
        assertThat(container.getImage()).isEqualTo("registry.example/manao/workspace-agent@" + DIGEST_A);
        assertThat(container.getSecurityContext().getAllowPrivilegeEscalation()).isFalse();
        assertThat(container.getSecurityContext().getCapabilities().getDrop()).containsExactly("ALL");
        assertThat(container.getSecurityContext().getReadOnlyRootFilesystem()).isTrue();
        var mount = container.getVolumeMounts().stream()
            .filter(candidate -> candidate.getMountPath().equals("/workspace")).findFirst().orElseThrow();
        assertThat(mount.getSubPath()).isEqualTo("project-" + PROJECT);
        assertThat(mount.getReadOnly()).isFalse();
        Map<String, String> env = new java.util.HashMap<>();
        pod.getSpec().getContainers().get(0).getEnv().forEach(item -> env.put(item.getName(), item.getValue()));
        assertThat(env).containsEntry("MANAO_AGENT_PROJECT_ID", PROJECT)
            .containsEntry("MANAO_AGENT_CAPABILITY_PUBLIC_KEY", "cHVibGljLWtleQ==")
            .doesNotContainKey("MANAO_WORKSPACE_CAPABILITY_PRIVATE_KEY")
            .doesNotContainKey("MANAO_AGENT_CAPABILITY_PRIVATE_KEY");
        assertThat(container.getLivenessProbe().getHttpGet().getPath()).isEqualTo("/agent/v1/healthz");
        assertThat(container.getReadinessProbe().getHttpGet().getPath()).isEqualTo("/agent/v1/healthz");
        assertThat(container.getResources().getLimits()).isNotEmpty();
        assertThat(pod.getSpec().getContainers().get(0).getVolumeMounts())
            .noneMatch(candidate -> candidate.getMountPath().equals("/data"));
        assertNoForbiddenFields(json.writeValueAsString(pod));
    }

    @Test
    void workspacePodProbesSurviveJavaColdStart() {
        Pod pod = factory.createWorkspacePod(PROJECT, "key");
        var container = pod.getSpec().getContainers().get(0);
        var startup = container.getStartupProbe();
        assertThat(startup).isNotNull();
        assertThat(startup.getHttpGet().getPath()).isEqualTo("/agent/v1/healthz");
        assertThat(startup.getHttpGet().getPort().getIntVal()).isEqualTo(8080);
        assertThat(startup.getInitialDelaySeconds()).isEqualTo(5);
        assertThat(startup.getPeriodSeconds()).isEqualTo(5);
        assertThat(startup.getFailureThreshold()).isEqualTo(24);
        assertThat(startup.getTimeoutSeconds()).isEqualTo(2);
        var liveness = container.getLivenessProbe();
        assertThat(liveness.getInitialDelaySeconds()).isEqualTo(5);
        assertThat(liveness.getPeriodSeconds()).isEqualTo(10);
        assertThat(liveness.getFailureThreshold()).isEqualTo(3);
        var readiness = container.getReadinessProbe();
        assertThat(readiness.getInitialDelaySeconds()).isEqualTo(3);
        assertThat(readiness.getPeriodSeconds()).isEqualTo(5);
        assertThat(readiness.getFailureThreshold()).isEqualTo(3);
    }

    @Test
    void serviceIsClusterInternalAndSelectorsMatchPodLabels() throws Exception {
        Service service = factory.createWorkspaceService(PROJECT);
        assertThat(WorkspaceResourceFactory.serviceName(PROJECT)).isEqualTo("manao-ws-" + PROJECT);
        assertThat(service.getSpec().getType()).isEqualTo("ClusterIP");
        assertThat(service.getSpec().getPorts().get(0).getPort()).isEqualTo(8080);
        assertThat(service.getSpec().getPorts().get(0).getTargetPort().getIntVal()).isEqualTo(8080);
        Pod pod = factory.createWorkspacePod(PROJECT, "key");
        service.getSpec().getSelector().forEach((key, value) -> assertThat(pod.getMetadata().getLabels()).containsEntry(key, value));
        assertNoForbiddenFields(json.writeValueAsString(service));
    }

    @Test
    void imageReferencesMustBeImmutableDigests() {
        // Floating tags fail closed at factory construction.
        assertThatThrownBy(() -> new WorkspaceResourceFactory(NAMESPACE, "rwx-storage",
            "registry.example/manao/workspace-agent:latest", "registry.example/manao/initializer@" + DIGEST_B))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceResourceFactory(NAMESPACE, "rwx-storage",
            "registry.example/manao/workspace-agent@" + DIGEST_A, "busybox:1.36"))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void resourceNamesAreDeterministicAndDerivedOnlyFromProjectId() {
        assertThat(WorkspaceResourceFactory.workspacePodName(PROJECT)).isEqualTo(WorkspaceResourceFactory.workspacePodName(PROJECT));
        assertThat(WorkspaceResourceFactory.workspacePodName("other-" + PROJECT)).contains("other-" + PROJECT);
        assertThat(WorkspaceResourceFactory.projectDirectory(PROJECT)).isEqualTo("project-" + PROJECT);
    }

    private void assertNoForbiddenFields(String serialized) {
        for (String forbidden : java.util.List.of("insecure-skip-tls-verify", "hostPath", "portforward", "MANAO_JWT_SECRET")) {
            assertThat(serialized).doesNotContain(forbidden);
        }
    }
}
