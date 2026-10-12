package com.manao.poc4.kubernetes;

import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.SecurityContext;
import io.fabric8.kubernetes.api.model.SecurityContextBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.api.model.Quantity;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Builds the single-run Job manifests for every fixed template. The persisted Run snapshot alone
 * decides the language: Java uses the original Maven image and commands, Python uses the
 * {@code MANAO_PYTHON_RUNNER_IMAGE} launcher image — the manifest shape, security envelope and
 * historical identifiers are shared. For TASK runs PID 1 of the application container (always
 * named {@code maven}, an internal compatibility identifier for both languages) is the fixed
 * launcher: the root-owned {@code manao-maven} wrapper execs {@code mvn -q -DskipTests compile
 * exec:java} under the single overall deadline, the Python launcher execs the project's console
 * entrypoint. For SERVICE runs (bounded web session) the container command is the root-owned
 * supervisor launcher — with the explicitly enumerated profile for Python — spawning the same
 * fixed child after claiming the run: one single-run Job (completions/parallelism=1, Never,
 * backoffLimit=0) with a per-run control directory on the workspace PVC, the
 * startup-deadline/lifetime environment and a supervisor-probe readiness check.
 *
 * <p>Both run kinds mount the project's language cache (the same workspace PVC:
 * {@code .manao-cache/maven} at /maven-cache for Java, {@code .manao-cache/python} at
 * /python-cache for Python — never both), and an init container root-mounts the PVC once to
 * create/repair exactly that language's cache directory for projects created before it existed —
 * templates, code and the other language's cache are never touched. Every constraint (deadlines,
 * resources, subPath, no ServiceAccount token, safe low-port sysctl) comes from server policy,
 * never from browser input.</p>
 */
public class JobResourceFactory {
    static final String SUPERVISOR_COMMAND = "/usr/local/bin/manao-run-supervisor";
    static final String MAVEN_WRAPPER_COMMAND = "/usr/local/bin/manao-maven";
    static final String PYTHON_LAUNCHER_COMMAND = "/usr/local/bin/manao-python";
    static final String MAVEN_CACHE_MOUNT = "/maven-cache";
    static final String PYTHON_CACHE_MOUNT = "/python-cache";
    static final String MAVEN_CACHE_DIRECTORY = WorkspaceResourceFactory.MAVEN_CACHE_DIRECTORY;
    static final String PYTHON_CACHE_DIRECTORY = ".manao-cache/python";
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
    private final String pythonImage;

    public JobResourceFactory(String namespace, long timeoutSeconds, String initializerImage,
                              RunResources requests, RunResources limits, String mavenImage,
                              String pythonImage) {
        this.namespace = requireText(namespace, "namespace");
        this.timeoutSeconds = timeoutSeconds;
        this.initializerImage = WorkspaceResourceFactory.requireDigest(initializerImage, "run initializer image");
        this.requests = requests;
        this.limits = limits;
        this.mavenImage = WorkspaceResourceFactory.requireDigest(mavenImage, "maven image");
        this.pythonImage = WorkspaceResourceFactory.requireDigest(pythonImage, "python runner image");
    }

    public record RunResources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    /**
     * The per-language fixed manifest inputs, resolved from the persisted Run template. The
     * image, the cache mount, the TASK command and the SERVICE supervisor profile are server
     * policy; the supervisor profile argument exists only for Python because the legacy
     * profile-less {@code run}/{@code probe} keeps its Java default for already-created resources.
     */
    private record LanguageRuntime(String image, String cacheMountPath, String cacheSubPath,
                                   String cachePreparationContainer, boolean repairSharedCacheParent,
                                   List<String> taskCommand, List<String> serviceCommand,
                                   List<String> probeCommand) {

        static LanguageRuntime maven(String mavenImage) {
            return new LanguageRuntime(mavenImage, MAVEN_CACHE_MOUNT, MAVEN_CACHE_DIRECTORY,
                "prepare-maven-cache", true,
                List.of(MAVEN_WRAPPER_COMMAND, "-q", "-DskipTests", "compile", "exec:java"),
                List.of(SUPERVISOR_COMMAND, "run"),
                List.of(SUPERVISOR_COMMAND, "probe"));
        }

        static LanguageRuntime python(String pythonImage, String serviceProfileId) {
            return new LanguageRuntime(pythonImage, PYTHON_CACHE_MOUNT, PYTHON_CACHE_DIRECTORY,
                "prepare-python-cache", false,
                List.of(PYTHON_LAUNCHER_COMMAND, "console"),
                List.of(SUPERVISOR_COMMAND, "run", serviceProfileId),
                List.of(SUPERVISOR_COMMAND, "probe", serviceProfileId));
        }

        /**
         * The exact cache-preparation script of one language: creates this language's cache
         * directory and hands it to the fixed workspace UID/GID. Only the Maven cache also
         * repairs the shared {@code .manao-cache} parent (its historical behavior for
         * pre-existing projects); the Python cache never re-owns or re-permissions the parent
         * other caches live under.
         */
        String cachePreparationScript() {
            String ownDirectory = "/data/" + cacheSubPath;
            String parent = "/data/.manao-cache";
            String ownershipTargets = repairSharedCacheParent ? parent + " " + ownDirectory : ownDirectory;
            return "mkdir -p " + ownDirectory
                + " && chown " + WorkspaceResourceFactory.WORKSPACE_UID + ":"
                + WorkspaceResourceFactory.WORKSPACE_GID + " " + ownershipTargets
                + " && chmod 0775 " + ownershipTargets;
        }
    }

    /**
     * The unified Job entry point: the persisted Run snapshot alone selects image, fixed
     * commands, cache and execution shape. Template-less historical rows keep their Java
     * semantics (decided by the execution kind); an unreadable snapshot fails closed.
     */
    public Job createJob(RunRecord run, String projectId, int primaryPort, List<EnvVar> applicationEnvironment) {
        RunPolicy policy = RunPolicy.fromJson(run.policyJson());
        com.manao.poc4.project.RuntimeTemplate template = policy.template();
        LanguageRuntime runtime = switch (template) {
            case JAVA_CONSOLE, JAVA_SPRING_BOOT_WEB -> LanguageRuntime.maven(mavenImage);
            case PYTHON_CONSOLE, PYTHON_FASTAPI_WEB -> LanguageRuntime.python(pythonImage, template.id());
        };
        if (policy.isService()) {
            return serviceJob(run.id(), projectId, run.createdAt().plusSeconds(policy.startupTimeoutSeconds()),
                policy.serviceLifetimeSeconds(), primaryPort, applicationEnvironment, runtime);
        }
        return taskJob(run.id(), projectId, applicationEnvironment, runtime);
    }

    public static String jobName(String runId) { return "manao-run-" + runId; }

    /** TASK run: unchanged single overall deadline; the selected dependency environment is injected. */
    public Job createMavenJob(String runId, String projectId, List<EnvVar> applicationEnvironment) {
        return taskJob(runId, projectId, applicationEnvironment, LanguageRuntime.maven(mavenImage));
    }

    /**
     * SERVICE run: exactly one execution of the supervisor, control directory prepared by the
     * init container (this run's directory only — old claims are never deleted), the readiness
     * probe is the supervisor probe and the termination message carries the receipt protocol.
     */
    public Job createServiceJob(String runId, String projectId, Instant startupDeadlineUtc,
                                long serviceLifetimeSeconds, int primaryPort, List<EnvVar> applicationEnvironment) {
        return serviceJob(runId, projectId, startupDeadlineUtc, serviceLifetimeSeconds, primaryPort,
            applicationEnvironment, LanguageRuntime.maven(mavenImage));
    }

    private Job taskJob(String runId, String projectId, List<EnvVar> applicationEnvironment,
                        LanguageRuntime runtime) {
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
            .withInitContainers(cachePreparationContainer(runtime))
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName(ResourceIdentityVerifier.APPLICATION_CONTAINER)
                .withImage(runtime.image())
                .withCommand(runtime.taskCommand())
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
                        .withName("workspace")
                        .withMountPath(runtime.cacheMountPath())
                        .withSubPath(runtime.cacheSubPath())
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

    private Job serviceJob(String runId, String projectId, Instant startupDeadlineUtc,
                           long serviceLifetimeSeconds, int primaryPort, List<EnvVar> applicationEnvironment,
                           LanguageRuntime runtime) {
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
            .withInitContainers(
                cachePreparationContainer(runtime),
                new io.fabric8.kubernetes.api.model.ContainerBuilder()
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
                .withImage(runtime.image())
                .withCommand(runtime.serviceCommand())
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
                        .withName("workspace")
                        .withMountPath(runtime.cacheMountPath())
                        .withSubPath(runtime.cacheSubPath())
                        .withReadOnly(false)
                        .build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("tmp")
                        .withMountPath("/tmp")
                        .build())
                .withNewReadinessProbe()
                .withNewExec()
                .withCommand(runtime.probeCommand())
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

    /**
     * Root-mounts the workspace PVC once and creates/repairs exactly the project cache directory
     * of this run's language (creating projects already have it from the initializer; old PVCs
     * get it rebuilt here). It never touches templates, code, the other language's cache or any
     * other path, so it cannot run the project-initialization flow or overwrite saved files.
     * Runs as root because the PVC root is root-owned; the cache directory itself is handed to
     * the fixed workspace UID/GID, while the application containers keep their non-root identity.
     */
    private io.fabric8.kubernetes.api.model.Container cachePreparationContainer(LanguageRuntime runtime) {
        return new io.fabric8.kubernetes.api.model.ContainerBuilder()
            .withName(runtime.cachePreparationContainer())
            .withImage(initializerImage)
            .withCommand("/bin/sh", "-ec", runtime.cachePreparationScript())
            .withVolumeMounts(new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                .withName("workspace").withMountPath("/data").build())
            .withNewSecurityContext()
            .withRunAsNonRoot(false)
            .withRunAsUser(0L)
            .withAllowPrivilegeEscalation(false)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder().withType("RuntimeDefault").build())
            .endSecurityContext()
            .build();
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
        // MiB-aligned values keep the Mi suffix (fixes the former dead branch that tested % gib).
        if (bytes >= mib && bytes % mib == 0) return new Quantity((bytes / mib) + "Mi");
        return new Quantity(String.valueOf(bytes));
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
