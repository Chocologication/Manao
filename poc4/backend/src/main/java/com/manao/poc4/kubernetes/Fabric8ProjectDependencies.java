package com.manao.poc4.kubernetes;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectDependencies;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.EnvVarBuilder;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.PersistentVolume;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.dsl.Resource;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * Fabric8-backed dependency lifecycle. Creation is idempotent and identity-verified: the
 * credential secrets are generated once and never read back (resources reference them by
 * name), the MySQL claim is registered in the runtime store immediately after creation so the
 * permanent deletion flow can own it, and an existing data claim without its credential secret
 * fails closed as RECOVERY_REQUIRED instead of re-initializing the database.
 */
public class Fabric8ProjectDependencies implements ProjectDependencies {
    private static final int PASSWORD_BYTES = 24;

    private final KubernetesClient client;
    private final String namespace;
    private final DependencyResourceFactory factory;
    private final ProjectRuntimeStore runtimeStore;
    private final SecureRandom random = new SecureRandom();

    public Fabric8ProjectDependencies(KubernetesClient client, String namespace,
                                      DependencyResourceFactory factory, ProjectRuntimeStore runtimeStore) {
        this.client = client;
        this.namespace = namespace;
        this.factory = factory;
        this.runtimeStore = runtimeStore;
    }

    @Override public void ensure(String projectId, ProjectRuntimeSpec spec) {
        if (spec.mysql()) {
            ensureMysql(projectId, spec);
        }
        if (spec.redis()) {
            ensureRedis(projectId, spec);
        }
    }

    private void ensureMysql(String projectId, ProjectRuntimeSpec spec) {
        Secret secret = findSecret(projectId, DependencyResourceFactory.mysqlSecretName(projectId));
        PersistentVolumeClaim claim = findPvc(projectId, DependencyResourceFactory.mysqlPvcName(projectId));
        if (secret == null && claim != null) {
            // Re-initializing against the surviving data would either reset it or strand the
            // old account credentials; both are forbidden, so recovery must take over.
            throw new ApiException("DEPENDENCY_RECOVERY_REQUIRED", 409,
                "MySQL data volume exists without its credential secret; recovery is required");
        }
        if (secret == null) {
            createIfAbsent(projectId, factory.mysqlAuthSecret(projectId,
                DependencyResourceFactory.MYSQL_USERNAME, randomPassword(), randomPassword()));
        }
        if (claim == null) {
            createIfAbsent(projectId, factory.mysqlClaim(projectId));
        }
        // Re-initialization of the database itself happens inside the image entrypoint exactly
        // once per empty data directory; the container env reads the secret, never a backend value.
        createIfAbsent(projectId, factory.mysql(projectId, spec));
        createIfAbsent(projectId, factory.mysqlService(projectId));
        createIfAbsent(projectId, factory.dependencyNetworkPolicy(projectId));
        rememberMysqlClaim(projectId);
    }

    private void ensureRedis(String projectId, ProjectRuntimeSpec spec) {
        Secret secret = findSecret(projectId, DependencyResourceFactory.redisSecretName(projectId));
        if (secret == null) {
            // Cache-only semantics: a lost Redis credential is re-created (cache is not data).
            createIfAbsent(projectId, factory.redisAuthSecret(projectId, randomPassword()));
        }
        createIfAbsent(projectId, factory.redis(projectId, spec));
        createIfAbsent(projectId, factory.redisService(projectId));
        createIfAbsent(projectId, factory.dependencyNetworkPolicy(projectId));
    }

    /** Persist the claim identity BEFORE anything else can depend on it, so permanent deletion stays possible. */
    private void rememberMysqlClaim(String projectId) {
        if (runtimeStore == null) {
            return;
        }
        PersistentVolumeClaim claim = client.persistentVolumeClaims().inNamespace(namespace)
            .withName(DependencyResourceFactory.mysqlPvcName(projectId)).get();
        if (claim == null) {
            return;
        }
        verifyIdentity(claim, projectId);
        String boundVolume = claim.getSpec() == null ? null : claim.getSpec().getVolumeName();
        String volumeUid = null;
        if (boundVolume != null && !boundVolume.isBlank()) {
            PersistentVolume volume = client.persistentVolumes().withName(boundVolume).get();
            volumeUid = volume == null || volume.getMetadata() == null ? null : volume.getMetadata().getUid();
        }
        runtimeStore.rememberStorage(projectId, new ProjectRuntimeStore.StorageBinding(
            ProjectDependencies.STORAGE_PURPOSE_MYSQL, claim.getMetadata().getName(),
            claim.getMetadata().getUid(), boundVolume, volumeUid));
    }

    @Override public DependencyStatus status(String projectId, ProjectRuntimeSpec spec) {
        return new DependencyStatus(
            spec.mysql() ? mysqlStatus(projectId) : ABSENT,
            spec.redis() ? redisStatus(projectId) : ABSENT);
    }

    private String mysqlStatus(String projectId) {
        try {
            boolean claim = findPvc(projectId, DependencyResourceFactory.mysqlPvcName(projectId)) != null;
            boolean secret = findSecret(projectId, DependencyResourceFactory.mysqlSecretName(projectId)) != null;
            if (claim && !secret) {
                return RECOVERY_REQUIRED;
            }
            var set = client.apps().statefulSets().inNamespace(namespace)
                .withName(DependencyResourceFactory.mysqlStatefulSetName(projectId)).get();
            if (set != null) {
                verifyIdentity(set, projectId);
                if (readyReplicas(set.getStatus() == null ? null : set.getStatus().getReadyReplicas())) {
                    return READY;
                }
                return PROVISIONING;
            }
            return claim || secret ? PROVISIONING : ABSENT;
        } catch (RuntimeException ex) {
            // A transport or permission failure is unknown, never ABSENT.
            return UNAVAILABLE;
        }
    }

    private String redisStatus(String projectId) {
        try {
            var deployment = client.apps().deployments().inNamespace(namespace)
                .withName(DependencyResourceFactory.redisDeploymentName(projectId)).get();
            if (deployment != null) {
                verifyIdentity(deployment, projectId);
                if (readyReplicas(deployment.getStatus() == null ? null : deployment.getStatus().getReadyReplicas())) {
                    return READY;
                }
                return PROVISIONING;
            }
            boolean secret = findSecret(projectId, DependencyResourceFactory.redisSecretName(projectId)) != null;
            return secret ? PROVISIONING : ABSENT;
        } catch (RuntimeException ex) {
            return UNAVAILABLE;
        }
    }

    private static boolean readyReplicas(Integer readyReplicas) {
        return readyReplicas != null && readyReplicas >= 1;
    }

    @Override public List<EnvVar> applicationEnvironment(String projectId, ProjectRuntimeSpec spec) {
        List<EnvVar> env = new ArrayList<>();
        env.add(new EnvVarBuilder().withName("SERVER_PORT")
            .withValue(String.valueOf(spec.primaryPort())).build());
        if (spec.mysql()) {
            env.add(valueEnv("MANAO_MYSQL_HOST", DependencyResourceFactory.mysqlServiceName(projectId)));
            env.add(valueEnv("MANAO_MYSQL_PORT", "3306"));
            env.add(valueEnv("MANAO_MYSQL_DATABASE", DependencyResourceFactory.MYSQL_DATABASE));
            env.add(secretEnv("MANAO_MYSQL_USERNAME", DependencyResourceFactory.mysqlSecretName(projectId), "username"));
            env.add(secretEnv("MANAO_MYSQL_PASSWORD", DependencyResourceFactory.mysqlSecretName(projectId), "password"));
        }
        if (spec.redis()) {
            env.add(valueEnv("MANAO_REDIS_HOST", DependencyResourceFactory.redisServiceName(projectId)));
            env.add(valueEnv("MANAO_REDIS_PORT", "6379"));
            env.add(secretEnv("MANAO_REDIS_PASSWORD", DependencyResourceFactory.redisSecretName(projectId), "password"));
        }
        return List.copyOf(env);
    }

    private static EnvVar valueEnv(String name, String value) {
        return new EnvVarBuilder().withName(name).withValue(value).build();
    }

    private static EnvVar secretEnv(String name, String secretName, String key) {
        return new EnvVarBuilder().withName(name)
            .withNewValueFrom().withNewSecretKeyRef()
            .withName(secretName).withKey(key)
            .endSecretKeyRef().endValueFrom().build();
    }

    /** 32 URL-safe characters from the secure random source; generated once per secret. */
    private String randomPassword() {
        byte[] bytes = new byte[PASSWORD_BYTES];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** Idempotent create with the gateway's identity semantics; an existing resource is reused only when it belongs to this project. */
    private <T extends HasMetadata> void createIfAbsent(String projectId, T resource) {
        Resource<T> handle = client.resource(resource).inNamespace(namespace);
        T existing = handle.get();
        if (existing != null) {
            verifyIdentity(existing, projectId);
            return;
        }
        try {
            handle.create();
        } catch (KubernetesClientException ex) {
            if (ex.getCode() != 409) {
                throw ex;
            }
            T after = handle.get();
            if (after == null) {
                throw ex;
            }
            verifyIdentity(after, projectId);
        }
    }

    private Secret findSecret(String projectId, String name) {
        Secret secret = client.secrets().inNamespace(namespace).withName(name).get();
        if (secret != null) {
            verifyIdentity(secret, projectId);
        }
        return secret;
    }

    private PersistentVolumeClaim findPvc(String projectId, String name) {
        PersistentVolumeClaim claim = client.persistentVolumeClaims().inNamespace(namespace).withName(name).get();
        if (claim != null) {
            verifyIdentity(claim, projectId);
        }
        return claim;
    }

    /** Name lookups are re-verified against the server-generated project label, fail closed on mismatch. */
    private static void verifyIdentity(HasMetadata resource, String projectId) {
        Map<String, String> labels = resource.getMetadata() == null ? null : resource.getMetadata().getLabels();
        if (labels == null || !projectId.equals(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID))) {
            throw new IllegalStateException("existing resource " + resource.getMetadata().getName()
                + " does not match the project identity");
        }
    }
}
