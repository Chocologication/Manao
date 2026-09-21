package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.DependencyResourceFactory;
import com.manao.poc4.kubernetes.Fabric8JobCoordinator;
import com.manao.poc4.kubernetes.Fabric8ProjectDependencies;
import com.manao.poc4.kubernetes.FakeProjectRuntimeStore;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.ResourceIdentityVerifier;
import com.manao.poc4.run.RunPolicy;
import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.client.ConfigBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Behavior of the per-project dependency lifecycle against the sanctioned Fabric8 mock server:
 * creation follows the selection exactly, credentials are generated once and only referenced,
 * a surviving data claim without its credential secret fails closed as RECOVERY_REQUIRED, and
 * run lifecycle never touches the dependency resources.
 */
class ProjectDependenciesTest {
    private static final String NS = "manao-test";
    private static final String PROJECT = "p1";

    KubernetesMockServer server;
    KubernetesClient client;
    DependencyResourceFactory factory;
    FakeProjectRuntimeStore runtimeStore;
    Fabric8ProjectDependencies dependencies;

    @BeforeEach
    void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        client = server.createClient();
        factory = new DependencyResourceFactory(NS, "registry.example/mysql:8.0.40",
            "registry.example/redis:7.4.1", "rwx-storage",
            DependencyResourceFactory.MYSQL_RESOURCES, DependencyResourceFactory.REDIS_RESOURCES);
        runtimeStore = new FakeProjectRuntimeStore();
        dependencies = new Fabric8ProjectDependencies(client, NS, factory, runtimeStore);
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.destroy();
    }

    private static ProjectRuntimeSpec spec(boolean mysql, boolean redis) {
        return new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, mysql, redis, List.of());
    }

    private boolean mysqlClaimExists() {
        return client.persistentVolumeClaims().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlPvcName(PROJECT)).get() != null;
    }

    private boolean mysqlStatefulSetExists() {
        return client.apps().statefulSets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlStatefulSetName(PROJECT)).get() != null;
    }

    private boolean redisDeploymentExists() {
        return client.apps().deployments().inNamespace(NS)
            .withName(DependencyResourceFactory.redisDeploymentName(PROJECT)).get() != null;
    }

    private boolean mysqlSecretExists() {
        return client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlSecretName(PROJECT)).get() != null;
    }

    private boolean redisSecretExists() {
        return client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.redisSecretName(PROJECT)).get() != null;
    }

    @Test
    void ensureCreatesExactlyTheSelectedDependencies() {
        // Console selection (no dependencies): nothing is created at all.
        dependencies.ensure(PROJECT, ProjectRuntimeSpec.console());
        assertThat(mysqlClaimExists()).isFalse();
        assertThat(mysqlStatefulSetExists()).isFalse();
        assertThat(mysqlSecretExists()).isFalse();
        assertThat(redisDeploymentExists()).isFalse();
        assertThat(redisSecretExists()).isFalse();

        // MySQL only.
        dependencies.ensure(PROJECT, spec(true, false));
        assertThat(mysqlClaimExists()).isTrue();
        assertThat(mysqlStatefulSetExists()).isTrue();
        assertThat(mysqlSecretExists()).isTrue();
        assertThat(redisDeploymentExists()).isFalse();
        assertThat(redisSecretExists()).isFalse();

        // Redis only.
        dependencies.ensure("p2", spec(false, true));
        assertThat(client.apps().statefulSets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlStatefulSetName("p2")).get()).isNull();
        assertThat(client.apps().deployments().inNamespace(NS)
            .withName(DependencyResourceFactory.redisDeploymentName("p2")).get()).isNotNull();
        assertThat(client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.redisSecretName("p2")).get()).isNotNull();

        // Both.
        dependencies.ensure("p3", spec(true, true));
        assertThat(client.apps().statefulSets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlStatefulSetName("p3")).get()).isNotNull();
        assertThat(client.apps().deployments().inNamespace(NS)
            .withName(DependencyResourceFactory.redisDeploymentName("p3")).get()).isNotNull();
        assertThat(client.network().networkPolicies().inNamespace(NS)
            .withName(DependencyResourceFactory.networkPolicyName("p3")).get()).isNotNull();
    }

    @Test
    void repeatedEnsureNeverRotatesCredentials() {
        dependencies.ensure(PROJECT, spec(true, true));
        Secret firstMysql = client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlSecretName(PROJECT)).get();
        Secret firstRedis = client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.redisSecretName(PROJECT)).get();
        dependencies.ensure(PROJECT, spec(true, true));
        Secret secondMysql = client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlSecretName(PROJECT)).get();
        Secret secondRedis = client.secrets().inNamespace(NS)
            .withName(DependencyResourceFactory.redisSecretName(PROJECT)).get();
        assertThat(secondMysql.getStringData()).isEqualTo(firstMysql.getStringData());
        assertThat(secondRedis.getStringData()).isEqualTo(firstRedis.getStringData());
    }

    @Test
    void ensureRegistersTheMysqlClaimForPermanentDeletion() {
        dependencies.ensure(PROJECT, spec(true, true));
        var claim = client.persistentVolumeClaims().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlPvcName(PROJECT)).get();
        var bindings = runtimeStore.storageBindings(PROJECT);
        assertThat(bindings).anySatisfy(binding -> {
            assertThat(binding.purpose()).isEqualTo(ProjectDependencies.STORAGE_PURPOSE_MYSQL);
            assertThat(binding.pvcName()).isEqualTo(DependencyResourceFactory.mysqlPvcName(PROJECT));
            assertThat(binding.pvcUid()).isEqualTo(claim.getMetadata().getUid());
        });
    }

    @Test
    void mysqlClaimIsRegisteredEvenWhenALaterEnsureStepFails() {
        // A conflicting StatefulSet without the project identity makes the controller create
        // step fail AFTER the claim exists — the exact window that used to leave the claim
        // unregistered and the permanent deletion flow stuck on UNEXPECTED_STORAGE_CLAIM.
        client.apps().statefulSets().inNamespace(NS).resource(
            new io.fabric8.kubernetes.api.model.apps.StatefulSetBuilder()
                .withNewMetadata().withNamespace(NS)
                .withName(DependencyResourceFactory.mysqlStatefulSetName(PROJECT))
                .endMetadata()
                .withNewSpec().withReplicas(1).endSpec()
                .build()).create();

        assertThatThrownBy(() -> dependencies.ensure(PROJECT, spec(true, true)))
            .isInstanceOf(IllegalStateException.class);

        // The claim identity landed in the store BEFORE the failure: the claim is owned and a
        // retry of creation hits the honest recovery path instead of an unregistered claim.
        assertThat(runtimeStore.storageBindings(PROJECT)).anySatisfy(binding -> {
            assertThat(binding.purpose()).isEqualTo(ProjectDependencies.STORAGE_PURPOSE_MYSQL);
            assertThat(binding.pvcName()).isEqualTo(DependencyResourceFactory.mysqlPvcName(PROJECT));
        });
    }

    @Test
    void existingMysqlClaimWithoutItsSecretRequiresRecoveryAndNeverReinitializes() {
        // A data volume survived while its credential secret was lost.
        client.persistentVolumeClaims().inNamespace(NS).resource(factory.mysqlClaim(PROJECT)).create();
        assertThatThrownBy(() -> dependencies.ensure(PROJECT, spec(true, true)))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.code()).isEqualTo("DEPENDENCY_RECOVERY_REQUIRED");
                assertThat(ex.status()).isEqualTo(409);
                assertThat(ex.getMessage()).doesNotContain("password");
            });
        // No credential was fabricated and no controller was started against the data.
        assertThat(mysqlSecretExists()).isFalse();
        assertThat(mysqlStatefulSetExists()).isFalse();
        assertThat(dependencies.status(PROJECT, spec(true, true)).mysql())
            .isEqualTo(ProjectDependencies.RECOVERY_REQUIRED);
    }

    @Test
    void statusFollowsTheSelectionAndReadiness() {
        var selected = spec(true, true);
        assertThat(dependencies.status(PROJECT, selected).mysql()).isEqualTo(ProjectDependencies.ABSENT);
        assertThat(dependencies.status(PROJECT, selected).redis()).isEqualTo(ProjectDependencies.ABSENT);
        assertThat(dependencies.status(PROJECT, ProjectRuntimeSpec.console()).mysql())
            .isEqualTo(ProjectDependencies.ABSENT);

        dependencies.ensure(PROJECT, selected);
        // The mock server never reports ready replicas: created controllers count as provisioning.
        assertThat(dependencies.status(PROJECT, selected).mysql()).isEqualTo(ProjectDependencies.PROVISIONING);
        assertThat(dependencies.status(PROJECT, selected).redis()).isEqualTo(ProjectDependencies.PROVISIONING);

        var set = client.apps().statefulSets().inNamespace(NS)
            .withName(DependencyResourceFactory.mysqlStatefulSetName(PROJECT)).get();
        set.setStatus(new io.fabric8.kubernetes.api.model.apps.StatefulSetStatusBuilder()
            .withReadyReplicas(1).build());
        client.apps().statefulSets().inNamespace(NS).resource(set).replace();
        var deployment = client.apps().deployments().inNamespace(NS)
            .withName(DependencyResourceFactory.redisDeploymentName(PROJECT)).get();
        deployment.setStatus(new io.fabric8.kubernetes.api.model.apps.DeploymentStatusBuilder()
            .withReadyReplicas(1).build());
        client.apps().deployments().inNamespace(NS).resource(deployment).replace();
        assertThat(dependencies.status(PROJECT, selected).mysql()).isEqualTo(ProjectDependencies.READY);
        assertThat(dependencies.status(PROJECT, selected).redis()).isEqualTo(ProjectDependencies.READY);
    }

    @Test
    void remoteUnknownIsNeverReportedAsAbsent() {
        try (KubernetesClient dead = new KubernetesClientBuilder().withConfig(new ConfigBuilder()
                .withMasterUrl("http://127.0.0.1:9").withNamespace(NS)
                .withRequestTimeout(1000).withConnectionTimeout(1000).build()).build()) {
            var unreachable = new Fabric8ProjectDependencies(dead, NS, factory, runtimeStore);
            var status = unreachable.status(PROJECT, spec(true, true));
            assertThat(status.mysql()).isEqualTo(ProjectDependencies.UNAVAILABLE);
            assertThat(status.redis()).isEqualTo(ProjectDependencies.UNAVAILABLE);
        }
    }

    @Test
    void applicationEnvironmentFollowsTheSelectionAndCarriesOnlySecretReferences() {
        // Unselected dependencies contribute nothing but the fixed service port.
        var consoleEnv = dependencies.applicationEnvironment(PROJECT,
            new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE, false, false, List.of()));
        assertThat(consoleEnv).extracting(EnvVar::getName).containsExactly("SERVER_PORT");
        assertThat(consoleEnv.get(0).getValue()).isEqualTo("8080");

        var spec = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true,
            List.of(new ProjectRuntimeSpec.Port("http", 9090, 30001)));
        var env = dependencies.applicationEnvironment(PROJECT, spec);
        assertThat(env).extracting(EnvVar::getName).containsExactlyInAnyOrder(
            "SERVER_PORT",
            "MANAO_MYSQL_HOST", "MANAO_MYSQL_PORT", "MANAO_MYSQL_DATABASE",
            "MANAO_MYSQL_USERNAME", "MANAO_MYSQL_PASSWORD",
            "MANAO_REDIS_HOST", "MANAO_REDIS_PORT", "MANAO_REDIS_PASSWORD");
        assertThat(env.stream().filter(entry -> "SERVER_PORT".equals(entry.getName())).findFirst().orElseThrow()
            .getValue()).isEqualTo("9090");
        assertThat(env.stream().filter(entry -> "MANAO_MYSQL_HOST".equals(entry.getName())).findFirst().orElseThrow()
            .getValue()).isEqualTo(DependencyResourceFactory.mysqlServiceName(PROJECT));

        var mysqlPassword = named(env, "MANAO_MYSQL_PASSWORD");
        assertThat(mysqlPassword.getValue()).isNull();
        assertThat(mysqlPassword.getValueFrom().getSecretKeyRef().getName())
            .isEqualTo(DependencyResourceFactory.mysqlSecretName(PROJECT));
        assertThat(mysqlPassword.getValueFrom().getSecretKeyRef().getKey()).isEqualTo("password");
        var mysqlUsername = named(env, "MANAO_MYSQL_USERNAME");
        assertThat(mysqlUsername.getValue()).isNull();
        assertThat(mysqlUsername.getValueFrom().getSecretKeyRef().getKey()).isEqualTo("username");
        var redisPassword = named(env, "MANAO_REDIS_PASSWORD");
        assertThat(redisPassword.getValue()).isNull();
        assertThat(redisPassword.getValueFrom().getSecretKeyRef().getName())
            .isEqualTo(DependencyResourceFactory.redisSecretName(PROJECT));
        assertThat(redisPassword.getValueFrom().getSecretKeyRef().getKey()).isEqualTo("password");

        // Redis-only selection: no MySQL variable may appear.
        var redisOnly = dependencies.applicationEnvironment(PROJECT, spec(false, true));
        assertThat(redisOnly).extracting(EnvVar::getName)
            .doesNotContain("MANAO_MYSQL_HOST", "MANAO_MYSQL_PASSWORD");
    }

    @Test
    void credentialsNeverReachTheBrowserContractOrTheRunPolicy() {
        // The browser-facing project record has no credential-shaped field.
        assertThat(Arrays.stream(ProjectService.Project.class.getRecordComponents())
                .map(java.lang.reflect.RecordComponent::getName))
            .containsExactly("id", "ownerId", "name", "state", "createdAt", "failureReason");
        // The persisted run policy carries no environment or credential surface at all.
        RunPolicy policy = new RunPolicy("mvn -q -DskipTests compile exec:java", 17, 3, 1800,
            RunPolicy.EXECUTION_KIND_TASK, 1800, 0,
            new RunPolicy.Resources(1000, 1073741824L, 1073741824L),
            new RunPolicy.Resources(8000, 17179869184L, 10737418240L));
        JsonNode json = read(policy.toJson());
        List<String> fields = new java.util.ArrayList<>();
        json.fieldNames().forEachRemaining(fields::add);
        assertThat(fields).containsExactlyInAnyOrder("command", "runtime", "timeoutSeconds",
            "executionKind", "startupTimeoutSeconds", "serviceLifetimeSeconds", "resources");
        // The internal application environment never carries a plaintext credential value.
        var env = dependencies.applicationEnvironment(PROJECT, spec(true, true));
        assertThat(env).allSatisfy(entry -> {
            if (entry.getName().endsWith("PASSWORD") || entry.getName().endsWith("USERNAME")) {
                assertThat(entry.getValue()).as("%s must be a secret reference", entry.getName()).isNull();
                assertThat(entry.getValueFrom().getSecretKeyRef()).isNotNull();
            }
        });
    }

    private static JsonNode read(String json) {
        try {
            return new ObjectMapper().readTree(json);
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    @Test
    void stoppingARunDeletesOnlyTheJobAndNeverTheDependencies() {
        dependencies.ensure(PROJECT, spec(true, true));
        var runResources = new JobResourceFactory.RunResources(1000, 1073741824L, 10737418240L);
        var jobFactory = new JobResourceFactory(NS, 1800,
            "registry.example/manao/initializer@sha256:" + "c".repeat(64), runResources, runResources,
            "registry.example/maven@sha256:" + "c".repeat(64));
        client.batch().v1().jobs().inNamespace(NS)
            .resource(jobFactory.createMavenJob("run-1", PROJECT, List.of())).create();
        var coordinator = new Fabric8JobCoordinator(client, jobFactory, new ResourceIdentityVerifier(), NS,
            (pod, container, command, cols, rows, pty) -> { throw new UnsupportedOperationException(); });

        coordinator.stop(jobFactory.jobName("run-1"));

        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(jobFactory.jobName("run-1")).get()).isNull();
        assertThat(mysqlClaimExists()).isTrue();
        assertThat(mysqlStatefulSetExists()).isTrue();
        assertThat(mysqlSecretExists()).isTrue();
        assertThat(redisDeploymentExists()).isTrue();
        assertThat(redisSecretExists()).isTrue();
        assertThat(client.network().networkPolicies().inNamespace(NS)
            .withName(DependencyResourceFactory.networkPolicyName(PROJECT)).get()).isNotNull();
    }

    private static EnvVar named(List<EnvVar> env, String name) {
        return env.stream().filter(entry -> entry.getName().equals(name)).findFirst().orElseThrow();
    }
}
