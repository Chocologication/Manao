package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import io.fabric8.kubernetes.api.model.IntOrString;
import io.fabric8.kubernetes.api.model.Quantity;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.api.model.SecretBuilder;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.DeploymentBuilder;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSetBuilder;
import io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicy;
import io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicyBuilder;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Builds the per-project MySQL/Redis dependency resources. Every resource carries the project
 * identity labels so the label-scoped cleanup owns them. Images must be pinned to an explicit
 * patch version or an immutable digest (the digest is recorded during deployment); floating
 * tags and {@code latest} are rejected. Resource requests/limits are the fixed preflight
 * starting points from the design, not measured capacities.
 */
public class DependencyResourceFactory {
    public static final String MYSQL_DATABASE = "app";
    public static final String MYSQL_USERNAME = "app";
    /** Fixed preflight starting point; real capacity is established by the environment preflight. */
    public static final Resources MYSQL_RESOURCES = new Resources("250m", "512Mi", "1", "1Gi");
    public static final Resources REDIS_RESOURCES = new Resources("100m", "128Mi", "500m", "256Mi");

    private static final String MYSQL_UID = "999";
    private static final Pattern EXPLICIT_PATCH_TAG = Pattern.compile("\\d+\\.\\d+\\.\\d+");
    private static final java.util.regex.Pattern DIGEST =
        java.util.regex.Pattern.compile("^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$");
    private static final String REDIS_AUTH_MOUNT = "/var/run/manao-redis-auth";
    /**
     * Cache-only Redis invocation: RDB snapshots and AOF are disabled, and the password is read
     * from the secret-mounted file at startup so the command line and logs never carry it.
     */
    private static final String REDIS_COMMAND = "printf 'save \"\"\\nappendonly no\\n' > /tmp/redis.conf && "
        + "printf 'requirepass %s\\n' \"$(cat " + REDIS_AUTH_MOUNT + "/password)\" >> /tmp/redis.conf && "
        + "exec redis-server /tmp/redis.conf";

    public record Resources(String cpuRequest, String memoryRequest, String cpuLimit, String memoryLimit) {}

    private final String namespace;
    private final String mysqlImage;
    private final String redisImage;
    private final String storageClassName;
    private final Resources mysqlResources;
    private final Resources redisResources;

    public DependencyResourceFactory(String namespace, String mysqlImage, String redisImage,
                                     String storageClassName, Resources mysqlResources, Resources redisResources) {
        this.namespace = requireText(namespace, "namespace");
        // Image validation happens at resource build time so console-only deployments can start
        // with blank configuration; building a dependency resource fails closed until pinned.
        this.mysqlImage = mysqlImage == null || mysqlImage.isBlank() ? null : mysqlImage;
        this.redisImage = redisImage == null || redisImage.isBlank() ? null : redisImage;
        this.storageClassName = storageClassName == null || storageClassName.isBlank() ? null : storageClassName;
        this.mysqlResources = mysqlResources == null ? MYSQL_RESOURCES : mysqlResources;
        this.redisResources = redisResources == null ? REDIS_RESOURCES : redisResources;
    }

    /**
     * Only an explicit patch tag ({@code 8.0.40}) or an immutable digest ({@code repo@sha256:...})
     * is a fixed reference. {@code latest} and floating minor tags ({@code 8.0}, {@code 7.4})
     * drift under deployment and are rejected.
     */
    static String requirePinnedImage(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        if (DIGEST.matcher(value).matches()) {
            return value;
        }
        int tagStart = value.lastIndexOf(':');
        if (tagStart < 0) {
            throw new IllegalArgumentException(name + " must carry an explicit patch tag or a digest");
        }
        String tag = value.substring(tagStart + 1);
        if ("latest".equals(tag) || !EXPLICIT_PATCH_TAG.matcher(tag).matches()) {
            throw new IllegalArgumentException(
                name + " must be pinned to an explicit patch version or an immutable digest, not '" + tag + "'");
        }
        return value;
    }

    public static String mysqlPvcName(String projectId) { return "manao-mysql-pvc-" + projectId; }
    public static String mysqlStatefulSetName(String projectId) { return "manao-mysql-" + projectId; }
    public static String mysqlServiceName(String projectId) { return "manao-mysql-" + projectId; }
    public static String mysqlSecretName(String projectId) { return "manao-mysql-auth-" + projectId; }
    public static String redisDeploymentName(String projectId) { return "manao-redis-" + projectId; }
    public static String redisServiceName(String projectId) { return "manao-redis-" + projectId; }
    public static String redisSecretName(String projectId) { return "manao-redis-auth-" + projectId; }
    public static String networkPolicyName(String projectId) { return "manao-dep-netpol-" + projectId; }

    /** Separate deterministic data claim; never the workspace claim, never auto-generated names. */
    public io.fabric8.kubernetes.api.model.PersistentVolumeClaim mysqlClaim(String projectId) {
        return new io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder()
            .withNewMetadata()
            .withName(mysqlPvcName(projectId))
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, "mysql"))
            .endMetadata()
            .withNewSpec()
            .withAccessModes("ReadWriteOnce")
            .withStorageClassName(requireStorageClass())
            .withNewResources()
            .addToRequests("storage", new Quantity("5Gi"))
            .endResources()
            .endSpec()
            .build();
    }

    /** Single-replica MySQL bound to its own claim; credentials arrive only by Secret reference. */
    public StatefulSet mysql(String projectId, ProjectRuntimeSpec spec) {
        String secretName = mysqlSecretName(projectId);
        return new StatefulSetBuilder()
            .withNewMetadata()
            .withName(mysqlStatefulSetName(projectId))
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, "mysql"))
            .endMetadata()
            .withNewSpec()
            .withReplicas(1)
            .withServiceName(mysqlServiceName(projectId))
            .withNewSelector().withMatchLabels(componentLabels(projectId, "mysql")).endSelector()
            .withNewTemplate()
            .withNewMetadata().withLabels(componentLabels(projectId, "mysql")).endMetadata()
            .withNewSpec()
            .withAutomountServiceAccountToken(false)
            .withNewSecurityContext()
            .withFsGroup(Long.parseLong(MYSQL_UID))
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder()
                .withType("RuntimeDefault").build())
            .endSecurityContext()
            .withVolumes(new io.fabric8.kubernetes.api.model.VolumeBuilder()
                .withName("data")
                .withNewPersistentVolumeClaim()
                .withClaimName(mysqlPvcName(projectId))
                .withReadOnly(false)
                .endPersistentVolumeClaim()
                .build())
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName("mysql")
                .withImage(pinnedImage(mysqlImage, "MySQL image"))
                .withEnv(
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MYSQL_ROOT_PASSWORD")
                        .withNewValueFrom().withNewSecretKeyRef()
                        .withName(secretName).withKey("root-password")
                        .endSecretKeyRef().endValueFrom().build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder()
                        .withName("MYSQL_DATABASE").withValue(MYSQL_DATABASE).build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MYSQL_USER")
                        .withNewValueFrom().withNewSecretKeyRef()
                        .withName(secretName).withKey("username")
                        .endSecretKeyRef().endValueFrom().build(),
                    new io.fabric8.kubernetes.api.model.EnvVarBuilder().withName("MYSQL_PASSWORD")
                        .withNewValueFrom().withNewSecretKeyRef()
                        .withName(secretName).withKey("password")
                        .endSecretKeyRef().endValueFrom().build())
                .withPorts(new io.fabric8.kubernetes.api.model.ContainerPortBuilder().withContainerPort(3306).build())
                .withVolumeMounts(new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                    .withName("data").withMountPath("/var/lib/mysql").build())
                .withResources(resources(mysqlResources))
                .withNewStartupProbe()
                .withNewTcpSocket().withPort(new IntOrString(3306)).endTcpSocket()
                .withInitialDelaySeconds(10).withPeriodSeconds(10).withFailureThreshold(60).withTimeoutSeconds(3)
                .endStartupProbe()
                .withNewLivenessProbe()
                .withNewTcpSocket().withPort(new IntOrString(3306)).endTcpSocket()
                .withPeriodSeconds(10).withFailureThreshold(6).withTimeoutSeconds(3)
                .endLivenessProbe()
                .withNewReadinessProbe()
                .withNewTcpSocket().withPort(new IntOrString(3306)).endTcpSocket()
                .withPeriodSeconds(5).withFailureThreshold(12).withTimeoutSeconds(3)
                .endReadinessProbe()
                .build())
            .endSpec()
            .endTemplate()
            .endSpec()
            .build();
    }

    /** Single-replica cache-only Redis; the password is injected through the mounted secret file. */
    public Deployment redis(String projectId, ProjectRuntimeSpec spec) {
        long redisUid = 999L;
        return new DeploymentBuilder()
            .withNewMetadata()
            .withName(redisDeploymentName(projectId))
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, "redis"))
            .endMetadata()
            .withNewSpec()
            .withReplicas(1)
            .withNewSelector().withMatchLabels(componentLabels(projectId, "redis")).endSelector()
            .withNewTemplate()
            .withNewMetadata().withLabels(componentLabels(projectId, "redis")).endMetadata()
            .withNewSpec()
            .withAutomountServiceAccountToken(false)
            .withNewSecurityContext()
            .withRunAsNonRoot(true)
            .withRunAsUser(redisUid)
            .withRunAsGroup(redisUid)
            .withFsGroup(redisUid)
            .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder()
                .withType("RuntimeDefault").build())
            .endSecurityContext()
            .withVolumes(
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("redis-auth")
                    .withNewSecret()
                    .withSecretName(redisSecretName(projectId))
                    .withDefaultMode(0440)
                    .endSecret()
                    .build(),
                new io.fabric8.kubernetes.api.model.VolumeBuilder()
                    .withName("writable-tmp")
                    .withNewEmptyDir().endEmptyDir()
                    .build())
            .withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName("redis")
                .withImage(pinnedImage(redisImage, "Redis image"))
                .withCommand("sh", "-c", REDIS_COMMAND)
                .withPorts(new io.fabric8.kubernetes.api.model.ContainerPortBuilder().withContainerPort(6379).build())
                .withVolumeMounts(
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("redis-auth").withMountPath(REDIS_AUTH_MOUNT).withReadOnly(true).build(),
                    new io.fabric8.kubernetes.api.model.VolumeMountBuilder()
                        .withName("writable-tmp").withMountPath("/tmp").build())
                .withResources(resources(redisResources))
                .withNewStartupProbe()
                .withNewTcpSocket().withPort(new IntOrString(6379)).endTcpSocket()
                .withInitialDelaySeconds(5).withPeriodSeconds(5).withFailureThreshold(24).withTimeoutSeconds(2)
                .endStartupProbe()
                .withNewLivenessProbe()
                .withNewTcpSocket().withPort(new IntOrString(6379)).endTcpSocket()
                .withPeriodSeconds(10).withFailureThreshold(3).withTimeoutSeconds(2)
                .endLivenessProbe()
                .withNewReadinessProbe()
                .withNewTcpSocket().withPort(new IntOrString(6379)).endTcpSocket()
                .withPeriodSeconds(5).withFailureThreshold(3).withTimeoutSeconds(2)
                .endReadinessProbe()
                .withNewSecurityContext()
                .withAllowPrivilegeEscalation(false)
                .withNewCapabilities().withDrop("ALL").endCapabilities()
                .withReadOnlyRootFilesystem(true)
                .withSeccompProfile(new io.fabric8.kubernetes.api.model.SeccompProfileBuilder()
                    .withType("RuntimeDefault").build())
                .endSecurityContext()
                .build())
            .endSpec()
            .endTemplate()
            .endSpec()
            .build();
    }

    public Service mysqlService(String projectId) {
        return internalService(projectId, "mysql", mysqlServiceName(projectId), 3306);
    }

    public Service redisService(String projectId) {
        return internalService(projectId, "redis", redisServiceName(projectId), 6379);
    }

    private Service internalService(String projectId, String component, String name, int port) {
        return new ServiceBuilder()
            .withNewMetadata()
            .withName(name)
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, component))
            .endMetadata()
            .withNewSpec()
            .withType("ClusterIP")
            .withSelector(componentLabels(projectId, component))
            .withPorts(new io.fabric8.kubernetes.api.model.ServicePortBuilder()
                .withProtocol("TCP")
                .withPort(port)
                .withTargetPort(new IntOrString(port))
                .build())
            .endSpec()
            .build();
    }

    /** One-time credentials; the backend generates them once and never logs or returns them. */
    public Secret mysqlAuthSecret(String projectId, String username, String password, String rootPassword) {
        Map<String, String> data = new HashMap<>();
        data.put("username", username);
        data.put("password", password);
        data.put("root-password", rootPassword);
        return authSecret(projectId, mysqlSecretName(projectId), "mysql", data);
    }

    public Secret redisAuthSecret(String projectId, String password) {
        Map<String, String> data = new HashMap<>();
        data.put("password", password);
        return authSecret(projectId, redisSecretName(projectId), "redis", data);
    }

    private Secret authSecret(String projectId, String name, String component, Map<String, String> data) {
        return new SecretBuilder()
            .withNewMetadata()
            .withName(name)
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, component))
            .endMetadata()
            .withStringData(data)
            .build();
    }

    /**
     * Dependency pods admit ingress only from pods of the same project (workspace pod,
     * initializer and run Jobs share the project label) on the two dependency ports. Probes
     * come from the kubelet and are not subject to NetworkPolicy, so no extra peer is opened.
     */
    public NetworkPolicy dependencyNetworkPolicy(String projectId) {
        return new NetworkPolicyBuilder()
            .withNewMetadata()
            .withName(networkPolicyName(projectId))
            .withNamespace(namespace)
            .withLabels(componentLabels(projectId, "dependencies"))
            .endMetadata()
            .withNewSpec()
            .withPodSelector(new io.fabric8.kubernetes.api.model.LabelSelectorBuilder()
                .withMatchExpressions(new io.fabric8.kubernetes.api.model.LabelSelectorRequirementBuilder()
                    .withKey(WorkspaceResourceFactory.LABEL_COMPONENT)
                    .withOperator("In")
                    .withValues("mysql", "redis")
                    .build())
                .build())
            .withPolicyTypes("Ingress")
            .addNewIngress()
            .addNewFrom()
            .withNewPodSelector()
            .withMatchLabels(Map.of(WorkspaceResourceFactory.LABEL_PROJECT_ID, projectId))
            .endPodSelector()
            .endFrom()
            .addNewPort().withProtocol("TCP").withPort(new IntOrString(3306)).endPort()
            .addNewPort().withProtocol("TCP").withPort(new IntOrString(6379)).endPort()
            .endIngress()
            .endSpec()
            .build();
    }

    private Map<String, String> componentLabels(String projectId, String component) {
        Map<String, String> labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
        labels.put(WorkspaceResourceFactory.LABEL_COMPONENT, component);
        return labels;
    }

    private io.fabric8.kubernetes.api.model.ResourceRequirements resources(Resources value) {
        return new io.fabric8.kubernetes.api.model.ResourceRequirementsBuilder()
            .addToRequests("cpu", new Quantity(value.cpuRequest()))
            .addToRequests("memory", new Quantity(value.memoryRequest()))
            .addToLimits("cpu", new Quantity(value.cpuLimit()))
            .addToLimits("memory", new Quantity(value.memoryLimit()))
            .build();
    }

    private String pinnedImage(String image, String name) {
        if (image == null) {
            throw new IllegalStateException(name + " is not pinned; the deployment must provide an explicit "
                + "patch version or immutable digest before selecting this dependency");
        }
        return requirePinnedImage(image, name);
    }

    private String requireStorageClass() {
        if (storageClassName == null) {
            throw new IllegalStateException("MySQL storage class is not configured");
        }
        return storageClassName;
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
