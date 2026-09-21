package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.IntOrString;
import io.fabric8.kubernetes.api.model.SecurityContext;
import io.fabric8.kubernetes.api.model.SecurityContextBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.api.model.Quantity;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Builds the Maven Job manifests. For TASK runs PID 1 of the application container directly execs
 * the fixed argument array {@code mvn -q -DskipTests compile exec:java} under the single overall
 * deadline. For SERVICE runs (bounded web session) the container command is the root-owned
 * supervisor launcher: one single-run Job (completions/parallelism=1, Never, backoffLimit=0) with
 * a per-run control directory on the workspace PVC, the startup-deadline/lifetime environment and
 * a supervisor-probe readiness check. Every constraint (deadlines, resources, subPath, no
 * ServiceAccount token, safe low-port sysctl) comes from server policy, never from browser input.
 */
public class JobResourceFactory {
    static final String SUPERVISOR_COMMAND = "/usr/local/bin/manao-run-supervisor";
    static final String CONTROL_DIR_MOUNT = "/run-control";
    static final String TERMINATION_MESSAGE_PATH = "/tmp/manao-termination.log";
    static final String LABEL_COMPONENT = "manao.poc4/component";
    static final String COMPONENT_VALUE = "maven-run";
    static final String SAFE_LOW_PORT_SYSCTL = "net.ipv4.ip_unprivileged_port_start";

    private final String namespace;
    private final long timeoutSeconds;
    private final String initializerImage;
    private final RunResources requests;
    private final RunResources limits;
    private final String mavenImage;

    public JobResourceFactory(String namespace, long timeoutSeconds, String initializerImage,
                              RunResources requests, RunResources limits, String mavenImage) {
        this.namespace = requireText(namespace, "namespace");
        this.timeoutSeconds = timeoutSeconds;
        this.initializerImage = WorkspaceResourceFactory.requireDigest(initializerImage, "run initializer image");
        this.requests = requests;
        this.limits = limits;
        this.mavenImage = WorkspaceResourceFactory.requireDigest(mavenImage, "maven image");
    }

    public record RunResources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    public static String jobName(String runId) { return "manao-run-" + runId; }

    /** TASK run: unchanged single overall deadline; the selected dependency environment is injected. */
    public Job createMavenJob(String runId, String projectId, List<EnvVar> applicationEnvironment) {
        var labels = labels(projectId, runId);
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
                .withCommand("mvn", "-q", "-DskipTests", "compile", "exec:java")
                .withWorkingDir("/workspace")
                .withEnv(baseEnvironment(applicationEnvironment))
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
                .withSecurityContext(containerSecurity())
                .build())
            .endSpec()
            .endTemplate()
            .endSpec()
            .build();
    }

    /**
     * SERVICE run: exactly one execution of the supervisor, control directory prepared by the
     * init container (this run's directory only — old claims are never deleted), the readiness
     * probe is the supervisor probe and the termination message carries the receipt protocol.
     */
    public Job createServiceJob(String runId, String projectId, Instant startupDeadlineUtc,
                                long serviceLifetimeSeconds, int primaryPort, List<EnvVar> applicationEnvironment) {
        var labels = labels(projectId, runId);
        long backstopSeconds = timeoutSeconds + serviceLifetimeSeconds;
        return new JobBuilder()
            .withNewMetadata()
            .withName(jobName(runId))
            .withNamespace(namespace)
            .withLabels(labels)
            .endMetadata()
            .withNewSpec()
            .withCompletions(1)
            .withParallelism(1)
            .withBackoffLimit(0)
            .withActiveDeadlineSeconds(backstopSeconds)
            .withNewTemplate()
            .withNewMetadata().withLabels(labels).endMetadata()
            .withNewSpec()
            .withServiceAccountName("manao-maven-runner")
            .withAutomountServiceAccountToken(false)
            .withRestartPolicy("Never")
            .withShareProcessNamespace(false)
            .withNewSecurityContext()
            .withRunAsNonRoot(true)
            .withRunAsUser(WorkspaceResourceFactory.WORKSPACE_UID)
            .withRunAsGroup(WorkspaceResourceFactory.WORKSPACE_GID)
            .withFsGroup(WorkspaceResourceFactory.WORKSPACE_GID)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
            .addNewSysctl()
            .withName(SAFE_LOW_PORT_SYSCTL)
            .withValue("0")
            .endSysctl()
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
            .withInitContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName("run-control")
                .withImage(initializerImage)
                .withCommand("mkdir", "-p", "/control/.manao-runs/" + runId)
                .withVolumeMounts(new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                    .withName("workspace")
                    .withMountPath("/control")
                    .withSubPath(WorkspaceResourceFactory.projectDirectory(projectId))
                    .withReadOnly(false)
                    .build())
                .withSecurityContext(containerSecurity())
                .build())
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
                .withImage(mavenImage)
                .withCommand(SUPERVISOR_COMMAND, "run")
                .withWorkingDir("/workspace")
                .withEnv(baseEnvironment(applicationEnvironment))
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_RUN_ID").withValue(runId).build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_PROJECT_ID").withValue(projectId).build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MANAO_POD_UID")
                    .withNewValueFrom().withNewFieldRef().withFieldPath("metadata.uid").endFieldRef()
                    .endValueFrom().build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_RUN_STARTUP_DEADLINE").withValue(startupDeadlineUtc.toString()).build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_PRIMARY_PORT").withValue(String.valueOf(primaryPort)).build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_RUN_CONTROL_DIR").withValue(CONTROL_DIR_MOUNT).build())
                .addToEnv(new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                    .withName("MANAO_SERVICE_LIFETIME_SECONDS").withValue(String.valueOf(serviceLifetimeSeconds)).build())
                .withVolumeMounts(
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace")
                        .withMountPath("/workspace")
                        .withSubPath(WorkspaceResourceFactory.projectDirectory(projectId))
                        .withReadOnly(false)
                        .build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("workspace")
                        .withMountPath(CONTROL_DIR_MOUNT)
                        .withSubPath(WorkspaceResourceFactory.projectDirectory(projectId) + "/.manao-runs/" + runId)
                        .withReadOnly(false)
                        .build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("tmp")
                        .withMountPath("/tmp")
                        .build())
                .withNewReadinessProbe()
                .withNewExec()
                .withCommand(SUPERVISOR_COMMAND, "probe")
                .endExec()
                .withInitialDelaySeconds(5)
                .withPeriodSeconds(10)
                .withTimeoutSeconds(5)
                .withFailureThreshold(3)
                .endReadinessProbe()
                .withTerminationMessagePath(TERMINATION_MESSAGE_PATH)
                .withTerminationMessagePolicy("File")
                .withNewResources()
                .addToRequests("cpu", cpuQuantity(requests.cpuMillis()))
                .addToRequests("memory", bytesQuantity(requests.memoryBytes()))
                .addToRequests("ephemeral-storage", bytesQuantity(requests.ephemeralStorageBytes()))
                .addToLimits("cpu", cpuQuantity(limits.cpuMillis()))
                .addToLimits("memory", bytesQuantity(limits.memoryBytes()))
                .addToLimits("ephemeral-storage", bytesQuantity(limits.ephemeralStorageBytes()))
                .endResources()
                .withSecurityContext(containerSecurity())
                .build())
            .endSpec()
            .endTemplate()
            .endSpec()
            .build();
    }

    private static java.util.Map<String, String> labels(String projectId, String runId) {
        var labels = WorkspaceResourceFactory.projectLabels(projectId);
        labels.put(LABEL_COMPONENT, COMPONENT_VALUE);
        labels.put(ResourceIdentityVerifier.LABEL_RUN_ID, runId);
        return labels;
    }

    private static List<EnvVar> baseEnvironment(List<EnvVar> applicationEnvironment) {
        List<EnvVar> env = new ArrayList<>(List.of(
            new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("TMPDIR").withValue("/tmp").build(),
            new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("HOME").withValue("/tmp").build()));
        env.addAll(applicationEnvironment == null ? List.of() : applicationEnvironment);
        return env;
    }

    private static SecurityContext containerSecurity() {
        return new SecurityContextBuilder()
            .withAllowPrivilegeEscalation(false)
            .withRunAsNonRoot(true)
            .withRunAsUser(WorkspaceResourceFactory.WORKSPACE_UID)
            .withNewCapabilities().withDrop("ALL").endCapabilities()
            .withReadOnlyRootFilesystem(true)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
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
        if (bytes >= mib && bytes % gib == 0) return new Quantity((bytes / mib) + "Mi");
        return new Quantity(String.valueOf(bytes));
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
