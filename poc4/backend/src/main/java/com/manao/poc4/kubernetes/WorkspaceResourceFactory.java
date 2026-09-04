package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.ObjectMeta;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.api.model.Quantity;
import io.fabric8.kubernetes.api.model.IntOrString;
import java.util.HashMap;
import java.util.Map;

/**
 * Builds every workspace namespace resource from the server-derived project identity. Names and
 * labels come only from the opaque project UUID; browser input can never reach a resource name.
 */
public class WorkspaceResourceFactory {
    public static final long WORKSPACE_UID = 10001L;
    public static final long WORKSPACE_GID = 10001L;
    public static final String LABEL_PROJECT_ID = "manao.poc4/project-id";
    public static final String LABEL_STAGE6_TEST = "stage6-test";
    public static final String WORKSPACE_SERVICE_ACCOUNT = "manao-workspace-agent";
    private static final String MANAGED_BY = "manao-poc4-backend";
    private static final java.util.regex.Pattern IMMUTABLE_DIGEST =
        java.util.regex.Pattern.compile("^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$");

    private final String namespace;
    private final String storageClassName;
    private final String agentImage;
    private final String initializerImage;

    public WorkspaceResourceFactory(String namespace, String storageClassName, String agentImage,
                                    String initializerImage) {
        this.namespace = requireText(namespace, "namespace");
        this.storageClassName = requireText(storageClassName, "storage class");
        this.agentImage = requireDigest(agentImage, "agent image");
        this.initializerImage = requireDigest(initializerImage, "initializer image");
    }

    /** Fail closed: images must be pinned by immutable digest, never by floating tag. */
    static String requireDigest(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        if (!IMMUTABLE_DIGEST.matcher(value).matches()) {
            throw new IllegalArgumentException(name + " must reference an immutable digest (repo@sha256:<64 hex>)");
        }
        return value;
    }

    public static String pvcName(String projectId) { return "manao-pvc-" + projectId; }
    public static String workspacePodName(String projectId) { return "manao-ws-" + projectId; }
    public static String initializerPodName(String projectId) { return "manao-ws-init-" + projectId; }
    public static String serviceName(String projectId) { return "manao-ws-" + projectId; }
    public static String projectDirectory(String projectId) { return "project-" + projectId; }

    public static Map<String, String> projectLabels(String projectId) {
        Map<String, String> labels = new HashMap<>();
        labels.put("app.kubernetes.io/managed-by", MANAGED_BY);
        labels.put(LABEL_PROJECT_ID, projectId);
        labels.put("manao.poc4/component", "workspace");
        labels.put(LABEL_STAGE6_TEST, "true");
        return labels;
    }

    public PersistentVolumeClaim createPvc(String projectId) {
        return new PersistentVolumeClaimBuilder()
            .withNewMetadata()
            .withName(pvcName(projectId))
            .withNamespace(namespace)
            .withLabels(projectLabels(projectId))
            .endMetadata()
            .withNewSpec()
            .withAccessModes("ReadWriteMany")
            .withStorageClassName(storageClassName)
            .withNewResources()
            .addToRequests("storage", new Quantity("10Gi"))
            .endResources()
            .endSpec()
            .build();
    }

    /** Root-mounted one-shot pod: creates the project directory, hands it to the fixed UID/GID. */
    public Pod createInitializerPod(String projectId) {
        String directory = projectDirectory(projectId);
        String createScript = "mkdir -p /data/" + directory
            + " && chown " + WORKSPACE_UID + ":" + WORKSPACE_GID + " /data/" + directory
            + " && chmod 0775 /data/" + directory;
        String probeScript = "test -w /data && touch /data/" + directory + "/.probe && rm /data/" + directory + "/.probe";
        return new PodBuilder()
            .withNewMetadata()
            .withName(initializerPodName(projectId))
            .withNamespace(namespace)
            .withLabels(withComponent(projectId, "initializer"))
            .endMetadata()
            .withNewSpec()
            .withRestartPolicy("Never")
            .withActiveDeadlineSeconds(600L)
            .withAutomountServiceAccountToken(false)
            .withNewSecurityContext()
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
            .endSecurityContext()
            .withVolumes(new io.fabric8.kubernetes.api.model.VolumeBuilder()
                .withName("workspace")
                .withNewPersistentVolumeClaim()
                .withClaimName(pvcName(projectId))
                .withReadOnly(false)
                .endPersistentVolumeClaim()
                .build())
            // Init containers run strictly before app containers: mkdir/chown/chmod are
            // guaranteed complete before the non-root permission probe starts.
            .withInitContainers(
                new io.fabric8.kubernetes.api.model.ContainerBuilder()
                    .withName("create-directory")
                    .withImage(initializerImage)
                    .withCommand("/bin/sh", "-ec", createScript)
                    .withVolumeMounts(new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace").withMountPath("/data").build())
                    .build())
            .withContainers(
                new io.fabric8.kubernetes.api.model.ContainerBuilder()
                    .withName("probe-permissions")
                    .withImage(initializerImage)
                    .withCommand("/bin/sh", "-ec", probeScript)
                    .withVolumeMounts(new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace").withMountPath("/data").build())
                    .withNewSecurityContext()
                    .withRunAsNonRoot(true)
                    .withRunAsUser(WORKSPACE_UID)
                    .withRunAsGroup(WORKSPACE_GID)
                    .withAllowPrivilegeEscalation(false)
                    .withNewCapabilities().withDrop("ALL").endCapabilities()
                    .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
                    .endSecurityContext()
                    .build())
            .endSpec()
            .build();
    }

    public Pod createWorkspacePod(String projectId, String capabilityPublicKeyBase64) {
        return new PodBuilder()
            .withNewMetadata()
            .withName(workspacePodName(projectId))
            .withNamespace(namespace)
            .withLabels(withComponent(projectId, "workspace"))
            .endMetadata()
            .withNewSpec()
            .withServiceAccountName(WORKSPACE_SERVICE_ACCOUNT)
            .withAutomountServiceAccountToken(false)
            .withNewSecurityContext()
            .withRunAsNonRoot(true)
            .withRunAsUser(WORKSPACE_UID)
            .withRunAsGroup(WORKSPACE_GID)
            .withFsGroup(WORKSPACE_GID)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
            .endSecurityContext()
            .withVolumes(
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("workspace")
                    .withNewPersistentVolumeClaim()
                    .withClaimName(pvcName(projectId))
                    .withReadOnly(false)
                    .endPersistentVolumeClaim()
                    .build(),
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("tmp")
                    .withNewEmptyDir().endEmptyDir()
                    .build())
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName("workspace-agent")
                .withImage(agentImage)
                .withEnv(
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MANAO_AGENT_PROJECT_ID").withValue(projectId).build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MANAO_AGENT_CAPABILITY_PUBLIC_KEY").withValue(capabilityPublicKeyBase64).build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MANAO_AGENT_ROOT").withValue("/workspace").build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("TMPDIR").withValue("/tmp").build())
                .withPorts(new io.fabric8.kubernetes.api.model.ContainerPortBuilder().withContainerPort(8080).build())
                .withVolumeMounts(
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace").withMountPath("/workspace").withSubPath(projectDirectory(projectId)).withReadOnly(false)
                        .build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("tmp").withMountPath("/tmp")
                        .build())
                .withNewResources()
                .addToRequests("cpu", new Quantity("250m"))
                .addToRequests("memory", new Quantity("512Mi"))
                .addToLimits("cpu", new Quantity("1"))
                .addToLimits("memory", new Quantity("1Gi"))
                .endResources()
                .withNewStartupProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(5).withPeriodSeconds(5).withFailureThreshold(24).withTimeoutSeconds(2)
                .endStartupProbe()
                .withNewLivenessProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(5).withPeriodSeconds(10).withFailureThreshold(3)
                .endLivenessProbe()
                .withNewReadinessProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(3).withPeriodSeconds(5).withFailureThreshold(3)
                .endReadinessProbe()
                .withNewSecurityContext()
                .withAllowPrivilegeEscalation(false)
                .withNewCapabilities().withDrop("ALL").endCapabilities()
                .withReadOnlyRootFilesystem(true)
                .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
                .endSecurityContext()
                .build())
            .endSpec()
            .build();
    }

    public Service createWorkspaceService(String projectId) {
        Map<String, String> selector = new HashMap<>(projectLabels(projectId));
        selector.put("manao.poc4/component", "workspace");
        return new ServiceBuilder()
            .withNewMetadata()
            .withName(serviceName(projectId))
            .withNamespace(namespace)
            .withLabels(withComponent(projectId, "workspace"))
            .endMetadata()
            .withNewSpec()
            .withType("ClusterIP")
            .withSelector(selector)
            .withPorts(new io.fabric8.kubernetes.api.model.ServicePortBuilder()
                .withPort(8080)
                .withTargetPort(new IntOrString(8080))
                .withProtocol("TCP")
                .build())
            .endSpec()
            .build();
    }

    private static Map<String, String> withComponent(String projectId, String component) {
        Map<String, String> labels = new HashMap<>(projectLabels(projectId));
        labels.put("manao.poc4/component", component);
        return labels;
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
