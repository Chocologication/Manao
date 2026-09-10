package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.api.model.Quantity;

/**
 * Builds the Maven Job manifest. PID 1 of the application container directly execs the fixed
 * argument array {@code mvn clean test}; every constraint (deadline, resources, subPath, no
 * ServiceAccount token) comes from server policy, never from browser input.
 */
public class JobResourceFactory {
    private final String namespace;
    private final long timeoutSeconds;
    private final RunResources requests;
    private final RunResources limits;
    private final String mavenImage;

    public JobResourceFactory(String namespace, long timeoutSeconds, RunResources requests,
                              RunResources limits, String mavenImage) {
        this.namespace = requireText(namespace, "namespace");
        this.timeoutSeconds = timeoutSeconds;
        this.requests = requests;
        this.limits = limits;
        this.mavenImage = WorkspaceResourceFactory.requireDigest(mavenImage, "maven image");
    }

    public record RunResources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    public static String jobName(String runId) { return "manao-run-" + runId; }

    public Job createMavenJob(String runId, String projectId) {
        var labels = WorkspaceResourceFactory.projectLabels(projectId);
        labels.put("manao.poc4/component", "maven-run");
        labels.put(ResourceIdentityVerifier.LABEL_RUN_ID, runId);
        return new JobBuilder()
            .withNewMetadata()
            .withName(jobName(runId))
            .withNamespace(namespace)
            .withLabels(labels)
            .endMetadata()
            .withNewSpec()
            .withBackoffLimit(0)
            .withActiveDeadlineSeconds(timeoutSeconds)
            // Kubernetes generates the controller-UID selector; run/project labels stay on the template.
            .withNewTemplate()
            .withNewMetadata().withLabels(labels).endMetadata()
            .withNewSpec()
            .withServiceAccountName("manao-maven-runner")
            .withAutomountServiceAccountToken(false)
            .withRestartPolicy("Never")
            .withNewSecurityContext()
            .withRunAsNonRoot(true)
            .withRunAsUser(WorkspaceResourceFactory.WORKSPACE_UID)
            .withRunAsGroup(WorkspaceResourceFactory.WORKSPACE_GID)
            .withFsGroup(WorkspaceResourceFactory.WORKSPACE_GID)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
            .endSecurityContext()
            .withVolumes(
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("workspace")
                    .withNewPersistentVolumeClaim()
                    .withClaimName(WorkspaceResourceFactory.pvcName(projectId))
                    .withReadOnly(false)
                    .endPersistentVolumeClaim()
                    .build(),
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("tmp")
                    .withNewEmptyDir().endEmptyDir()
                    .build())
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
                .withImage(mavenImage)
                .withCommand("mvn", "clean", "test")
                .withWorkingDir("/workspace")
                .withEnv(
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("TMPDIR").withValue("/tmp").build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("HOME").withValue("/tmp").build())
                .withVolumeMounts(
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace")
                        .withMountPath("/workspace")
                        .withSubPath(WorkspaceResourceFactory.projectDirectory(projectId))
                        .withReadOnly(false)
                        .build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("tmp")
                        .withMountPath("/tmp")
                        .build())
                .withNewResources()
                .addToRequests("cpu", cpuQuantity(requests.cpuMillis()))
                .addToRequests("memory", bytesQuantity(requests.memoryBytes()))
                .addToRequests("ephemeral-storage", bytesQuantity(requests.ephemeralStorageBytes()))
                .addToLimits("cpu", cpuQuantity(limits.cpuMillis()))
                .addToLimits("memory", bytesQuantity(limits.memoryBytes()))
                .addToLimits("ephemeral-storage", bytesQuantity(limits.ephemeralStorageBytes()))
                .endResources()
                .withNewSecurityContext()
                .withAllowPrivilegeEscalation(false)
                .withNewCapabilities().withDrop("ALL").endCapabilities()
                .withReadOnlyRootFilesystem(true)
                .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
                .endSecurityContext()
                .build())
            .endSpec()
            .endTemplate()
            .endSpec()
            .build();
    }

    static Quantity cpuQuantity(long cpuMillis) {
        if (cpuMillis >= 1000 && cpuMillis % 1000 == 0) {
            return new Quantity(String.valueOf(cpuMillis / 1000));
        }
        return new Quantity(cpuMillis + "m");
    }

    static Quantity bytesQuantity(long bytes) {
        long gib = 1024L * 1024 * 1024;
        long mib = 1024L * 1024;
        if (bytes >= gib && bytes % gib == 0) return new Quantity((bytes / gib) + "Gi");
        if (bytes >= mib && bytes % mib == 0) return new Quantity((bytes / mib) + "Mi");
        return new Quantity(String.valueOf(bytes));
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
