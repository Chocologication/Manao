package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Resource shapes for the per-project MySQL/Redis dependencies: the MySQL claim must be
 * separate from the workspace claim, images must be pinned to an explicit patch or digest,
 * and credentials may only travel through Secret references or mounted secret files.
 */
class DependencyResourceFactoryTest {
    private static final String PROJECT = "p1";
    private static final String MYSQL_IMAGE = "registry.example/mysql:8.0.40";
    private static final String REDIS_IMAGE = "registry.example/redis:7.4.1";
    private static final String DIGEST_SUFFIX = "@sha256:" + "a".repeat(64);

    private final DependencyResourceFactory factory = new DependencyResourceFactory(
        "manao-test", MYSQL_IMAGE, REDIS_IMAGE, "rwx-storage",
        DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);

    private static ProjectRuntimeSpec webSpec(boolean mysql, boolean redis) {
        return new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, mysql, redis, List.of());
    }

    @Test
    void mysqlUsesItsOwnClaim() {
        var spec = new ProjectRuntimeSpec("java-spring-boot-web", true, true, List.of());
        assertThat(factory.mysqlClaim(PROJECT).getMetadata().getName())
            .isEqualTo("manao-mysql-pvc-p1")
            .isNotEqualTo(WorkspaceResourceFactory.pvcName(PROJECT));
        assertThat(factory.mysql(PROJECT, spec).getSpec().getReplicas()).isEqualTo(1);
    }

    @Test
    void mysqlClaimRequestsFiveGibiBytesUnderTheProjectIdentity() {
        var claim = factory.mysqlClaim(PROJECT);
        assertThat(claim.getSpec().getAccessModes()).containsExactly("ReadWriteOnce");
        assertThat(claim.getSpec().getStorageClassName()).isEqualTo("rwx-storage");
        var storage = claim.getSpec().getResources().getRequests().get("storage");
        assertThat(storage.getAmount()).isEqualTo("5");
        assertThat(storage.getFormat()).isEqualTo("Gi");
        assertThat(claim.getMetadata().getLabels())
            .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, PROJECT);
    }

    @Test
    void mysqlStatefulSetMountsItsOwnClaimAndReferencesCredentialsBySecret() {
        var set = factory.mysql(PROJECT, webSpec(true, true));
        var podSpec = set.getSpec().getTemplate().getSpec();
        var container = podSpec.getContainers().get(0);
        assertThat(set.getMetadata().getName()).isEqualTo("manao-mysql-p1");
        assertThat(container.getImage()).isEqualTo(MYSQL_IMAGE);
        assertThat(podSpec.getVolumes())
            .anySatisfy(volume -> assertThat(volume.getPersistentVolumeClaim().getClaimName())
                .isEqualTo("manao-mysql-pvc-p1"));
        assertThat(container.getEnv()).extracting(env -> env.getName())
            .contains("MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD");
        assertThat(container.getEnv())
            .filteredOn(env -> env.getName().equals("MYSQL_USER") || env.getName().equals("MYSQL_PASSWORD"))
            .allSatisfy(env -> {
                assertThat(env.getValue()).as("%s must not carry a plaintext value", env.getName()).isNull();
                assertThat(env.getValueFrom().getSecretKeyRef().getName()).isEqualTo("manao-mysql-auth-p1");
            });
        assertThat(container.getResources().getRequests().get("cpu").getAmount()).isEqualTo("250");
        assertThat(container.getResources().getRequests().get("cpu").getFormat()).isEqualTo("m");
        assertThat(container.getResources().getRequests().get("memory").getAmount()).isEqualTo("512");
        assertThat(container.getResources().getRequests().get("memory").getFormat()).isEqualTo("Mi");
        assertThat(container.getResources().getLimits().get("cpu").getAmount()).isEqualTo("1");
        assertThat(container.getResources().getLimits().get("memory").getAmount()).isEqualTo("1");
        assertThat(container.getResources().getLimits().get("memory").getFormat()).isEqualTo("Gi");
        assertThat(container.getReadinessProbe().getTcpSocket().getPort().getIntVal()).isEqualTo(3306);
        assertThat(container.getLivenessProbe().getTcpSocket().getPort().getIntVal()).isEqualTo(3306);
        assertThat(container.getPorts()).anySatisfy(port -> assertThat(port.getContainerPort()).isEqualTo(3306));
    }

    @Test
    void redisDeploymentIsSingleReplicaWithoutPersistenceAndFileInjectedCredential() {
        var deployment = factory.redis(PROJECT, webSpec(true, true));
        var container = deployment.getSpec().getTemplate().getSpec().getContainers().get(0);
        assertThat(deployment.getMetadata().getName()).isEqualTo("manao-redis-p1");
        assertThat(deployment.getSpec().getReplicas()).isEqualTo(1);
        assertThat(container.getImage()).isEqualTo(REDIS_IMAGE);
        String invocation = String.join(" ", container.getCommand()) + " " + String.join(" ", container.getArgs());
        // Cache-only semantics: RDB snapshots and AOF are both disabled.
        assertThat(invocation).contains("save \"\"", "appendonly no");
        // The password is read from the mounted secret file; the command line must not carry it.
        assertThat(invocation).contains("$(cat /var/run/manao-redis-auth/password)");
        assertThat(deployment.getSpec().getTemplate().getSpec().getVolumes())
            .anySatisfy(volume -> assertThat(volume.getSecret().getSecretName()).isEqualTo("manao-redis-auth-p1"));
        assertThat(container.getResources().getRequests().get("cpu").getAmount()).isEqualTo("100");
        assertThat(container.getResources().getRequests().get("cpu").getFormat()).isEqualTo("m");
        assertThat(container.getResources().getRequests().get("memory").getAmount()).isEqualTo("128");
        assertThat(container.getResources().getRequests().get("memory").getFormat()).isEqualTo("Mi");
        assertThat(container.getResources().getLimits().get("cpu").getAmount()).isEqualTo("500");
        assertThat(container.getResources().getLimits().get("cpu").getFormat()).isEqualTo("m");
        assertThat(container.getResources().getLimits().get("memory").getAmount()).isEqualTo("256");
        assertThat(container.getResources().getLimits().get("memory").getFormat()).isEqualTo("Mi");
        assertThat(container.getReadinessProbe().getTcpSocket().getPort().getIntVal()).isEqualTo(6379);
        assertThat(container.getLivenessProbe().getTcpSocket().getPort().getIntVal()).isEqualTo(6379);
    }

    @Test
    void dependencyServicesAreInternalClusterIpOnly() {
        var mysql = factory.mysqlService(PROJECT);
        assertThat(mysql.getMetadata().getName()).isEqualTo("manao-mysql-p1");
        assertThat(mysql.getSpec().getType()).isEqualTo("ClusterIP");
        assertThat(mysql.getSpec().getPorts().get(0).getPort()).isEqualTo(3306);
        var redis = factory.redisService(PROJECT);
        assertThat(redis.getMetadata().getName()).isEqualTo("manao-redis-p1");
        assertThat(redis.getSpec().getType()).isEqualTo("ClusterIP");
        assertThat(redis.getSpec().getPorts().get(0).getPort()).isEqualTo(6379);
    }

    @Test
    void networkPolicyAdmitsOnlySameProjectPodsToTheDependencyPorts() {
        var policy = factory.dependencyNetworkPolicy(PROJECT);
        assertThat(policy.getMetadata().getName()).isEqualTo("manao-dep-netpol-p1");
        assertThat(policy.getSpec().getPodSelector().getMatchExpressions())
            .anySatisfy(requirement -> {
                assertThat(requirement.getKey()).isEqualTo(WorkspaceResourceFactory.LABEL_COMPONENT);
                assertThat(requirement.getOperator()).isEqualTo("In");
                assertThat(requirement.getValues()).containsExactly("mysql", "redis");
            });
        assertThat(policy.getSpec().getPolicyTypes()).containsExactly("Ingress");
        assertThat(policy.getSpec().getIngress()).hasSize(1);
        var rule = policy.getSpec().getIngress().get(0);
        assertThat(rule.getFrom()).anySatisfy(peer ->
            assertThat(peer.getPodSelector().getMatchLabels())
                .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, PROJECT));
        assertThat(rule.getPorts())
            .extracting(port -> port.getPort().getIntVal())
            .containsExactlyInAnyOrder(3306, 6379);
    }

    @Test
    void authSecretsHoldOnlyTheCredentialKeys() {
        var mysql = factory.mysqlAuthSecret(PROJECT, "app", "generated-app", "generated-root");
        assertThat(mysql.getMetadata().getName()).isEqualTo("manao-mysql-auth-p1");
        assertThat(mysql.getMetadata().getLabels())
            .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, PROJECT);
        assertThat(mysql.getStringData()).containsOnlyKeys("username", "password", "root-password");
        var redis = factory.redisAuthSecret(PROJECT, "generated-redis");
        assertThat(redis.getMetadata().getName()).isEqualTo("manao-redis-auth-p1");
        assertThat(redis.getStringData()).containsOnlyKeys("password");
    }

    @Test
    void neverBuildsWithFloatingOrLatestImages() {
        var spec = webSpec(true, true);
        var latest = new DependencyResourceFactory("manao-test", "mysql:latest", REDIS_IMAGE, "sc",
            DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);
        assertThatThrownBy(() -> latest.mysql(PROJECT, spec)).isInstanceOf(IllegalArgumentException.class);
        var floating = new DependencyResourceFactory("manao-test", MYSQL_IMAGE, "redis:7.4", "sc",
            DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);
        assertThatThrownBy(() -> floating.redis(PROJECT, spec)).isInstanceOf(IllegalArgumentException.class);
        var minor = new DependencyResourceFactory("manao-test", "mysql:8.0", REDIS_IMAGE, "sc",
            DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);
        assertThatThrownBy(() -> minor.mysql(PROJECT, spec)).isInstanceOf(IllegalArgumentException.class);
        // Explicit patch versions and immutable digests are the only accepted pins;
        // a digest is recorded for deployment in Task 8 and never fabricated here.
        var digest = new DependencyResourceFactory("manao-test",
            "registry.example/mysql" + DIGEST_SUFFIX, REDIS_IMAGE, "sc",
            DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);
        assertThat(digest.mysql(PROJECT, spec).getSpec().getTemplate().getSpec().getContainers().get(0).getImage())
            .endsWith(DIGEST_SUFFIX);
    }
}
