package com.manao.poc4.config;

import java.time.Duration;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

@ConfigurationProperties(prefix = "manao.poc4.backend", ignoreUnknownFields = false)
public final class BackendProperties {
    private static final String FIXED_JAVA_VERSION = "17";
    private static final String FIXED_MAVEN_VERSION = "3.9.11";
    private static final Duration FIXED_TIMEOUT = Duration.ofSeconds(1800);
    private static final ResourceLimits FIXED_RESOURCES = new ResourceLimits(8, "16Gi", "10Gi");
    private static final Workspace FIXED_WORKSPACE = new Workspace(
        "rwx-pvc", "manao-workspace-rwx", "10Gi", "ReadWriteMany", 18100, 18199, 8080,
        "manao-workspace-rwx", "manao/workspace-agent:dev", "busybox:1.36");
    private static final int DEFAULT_RESERVED_PUBLIC_PORT = 30080;

    private final BackendProfile profile;
    private final String javaVersion;
    private final String mavenVersion;
    private final Duration timeout;
    private final Kubernetes kubernetes;
    private final ResourceLimits resources;
    private final Workspace workspace;
    private final Logging logging;
    private final RuntimeDeps runtimeDeps;

    @ConstructorBinding
    public BackendProperties(BackendProfile profile, String javaVersion, String mavenVersion,
                             Duration timeout, Kubernetes kubernetes, ResourceLimits resources,
                             Workspace workspace, Logging logging, RuntimeDeps runtimeDeps) {
        validateClusterConfiguration(profile, kubernetes);
        this.profile = profile;
        this.javaVersion = FIXED_JAVA_VERSION;
        this.mavenVersion = FIXED_MAVEN_VERSION;
        this.timeout = FIXED_TIMEOUT;
        this.kubernetes = kubernetes;
        this.resources = FIXED_RESOURCES;
        this.workspace = workspace == null ? FIXED_WORKSPACE : workspace.withDeploymentDefaults(FIXED_WORKSPACE);
        this.logging = logging;
        this.runtimeDeps = runtimeDeps == null
            ? new RuntimeDeps(List.of(DEFAULT_RESERVED_PUBLIC_PORT), null, null, null, null) : runtimeDeps;
    }

    private static void validateClusterConfiguration(BackendProfile profile, Kubernetes kubernetes) {
        if (profile == null || kubernetes == null) {
            throw new IllegalArgumentException("backend profile and Kubernetes configuration are required");
        }
        if (profile == BackendProfile.CLUSTER
            && (!kubernetes.inCluster() || !kubernetes.serviceAccount()
                || kubernetes.masterUrl() == null || !kubernetes.masterUrl().isBlank())) {
            throw new IllegalArgumentException("cluster profile requires in-cluster ServiceAccount configuration");
        }
        if (profile == BackendProfile.CLUSTER) {
            requireText(kubernetes.apiServerHost(), "cluster Kubernetes API host");
            if (kubernetes.apiServerPort() < 1 || kubernetes.apiServerPort() > 65535) {
                throw new IllegalArgumentException("cluster Kubernetes API port is required");
            }
            requireReadableFile(kubernetes.serviceAccountTokenFile(), "cluster ServiceAccount token");
            requireReadableFile(kubernetes.serviceAccountCaCertificateFile(), "cluster ServiceAccount CA certificate");
        }
        if (profile == BackendProfile.LOCAL_CLUSTER
            && (kubernetes.inCluster() || kubernetes.serviceAccount()
                || kubernetes.masterUrl() == null || kubernetes.masterUrl().isBlank())) {
            throw new IllegalArgumentException("local-cluster profile requires an external Kubernetes endpoint");
        }
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
    }

    private static void requireReadableFile(String value, String name) {
        requireText(value, name);
        Path path = Path.of(value);
        if (!Files.isRegularFile(path) || !Files.isReadable(path)) {
            throw new IllegalArgumentException(name + " must be a readable file");
        }
    }

    public BackendProfile profile() { return profile; }
    public String fixedCommand() { return "mvn -q -DskipTests compile exec:java"; }
    public String javaVersion() { return javaVersion; }
    public String mavenVersion() { return mavenVersion; }
    public Duration timeout() { return timeout; }
    public Kubernetes kubernetes() { return kubernetes; }
    public ResourceLimits resources() { return resources; }
    public Workspace workspace() { return workspace; }
    public Logging logging() { return logging; }
    public RuntimeDeps runtimeDeps() { return runtimeDeps; }

    public record Kubernetes(String masterUrl, String namespace, boolean inCluster, boolean serviceAccount,
                             String kubeconfigFile, String apiServerHost, int apiServerPort,
                             String serviceAccountTokenFile, String serviceAccountCaCertificateFile) {}
    public record ResourceLimits(int cpuCores, String memory, String ephemeralStorage) {}
    public record Workspace(String bridgeMode, String pvcName, String pvcSize, String accessMode,
                            int bridgePortStart, int bridgePortEnd, int agentPort,
                            String storageClassName, String agentImage, String initializerImage) {
        /** Fixed policy fields always win; only the three deployment fields honor configuration. */
        public Workspace withDeploymentDefaults(Workspace fixed) {
            return new Workspace(fixed.bridgeMode(), fixed.pvcName(), fixed.pvcSize(), fixed.accessMode(),
                fixed.bridgePortStart(), fixed.bridgePortEnd(), fixed.agentPort(),
                blank(storageClassName) ? fixed.storageClassName() : storageClassName,
                blank(agentImage) ? fixed.agentImage() : agentImage,
                blank(initializerImage) ? fixed.initializerImage() : initializerImage);
        }
        private static boolean blank(String value) { return value == null || value.isBlank(); }
    }
    public record Logging(boolean redactSecrets) {}

    /**
     * Runtime dependency configuration. The reserved public port set must match the deployment;
     * the image references and storage class are only mandatory for the selected dependency and
     * never affect legacy console projects. Image references must be explicit patch versions or
     * immutable digests (floating tags are rejected by the resource factory). The public entry
     * host (the address that reaches the NodePort range) is optional: without it the project
     * view reports the assigned ports without an access URL.
     */
    public record RuntimeDeps(List<Integer> reservedPublicPorts, String publicEntryHost,
                              String mysqlImageDigest, String redisImageDigest,
                              String mysqlStorageClassName) {
        public RuntimeDeps {
            reservedPublicPorts = List.copyOf(reservedPublicPorts == null ? List.of() : reservedPublicPorts);
            publicEntryHost = blank(publicEntryHost) ? null : publicEntryHost.trim();
        }
        private static boolean blank(String value) { return value == null || value.isBlank(); }
    }
}
