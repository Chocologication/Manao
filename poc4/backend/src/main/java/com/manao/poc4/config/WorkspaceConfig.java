package com.manao.poc4.config;

import com.manao.poc4.kubernetes.Fabric8KubernetesGateway;
import com.manao.poc4.kubernetes.KubernetesGateway;
import com.manao.poc4.kubernetes.WorkspaceApiClient;
import com.manao.poc4.project.ProjectProvisioningService;
import com.manao.poc4.recovery.ProjectRecoveryService;
import com.manao.poc4.workspace.Ed25519Keys;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceCapabilitySigner;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceTemplate;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Conditional;

/**
 * Workspace and Kubernetes wiring. Guarded on the DataSource so contract tests can load the
 * application configuration without MySQL or cluster access.
 */
@Configuration
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class WorkspaceConfig {

    @Bean
    KubernetesClient kubernetesClient(BackendProperties properties) {
        BackendProperties.Kubernetes kubernetes = properties.kubernetes();
        if (properties.profile() == BackendProfile.LOCAL_CLUSTER) {
            // 6A: temporary kubeconfig whose server points at the SSH-forwarded local API endpoint.
            try {
                String kubeconfig = java.nio.file.Files.readString(java.nio.file.Path.of(kubernetes.kubeconfigFile()));
                io.fabric8.kubernetes.client.Config config = io.fabric8.kubernetes.client.Config.fromKubeconfig(null, kubeconfig, null);
                return new KubernetesClientBuilder().withConfig(config).build();
            } catch (java.io.IOException ex) {
                throw new IllegalStateException("kubeconfig for the local-cluster profile is unreadable", ex);
            }
        }
        return new KubernetesClientBuilder().build();
    }

    @Bean
    WorkspaceCapabilitySigner workspaceCapabilitySigner(
        @Value("${MANAO_WORKSPACE_CAPABILITY_PRIVATE_KEY:}") String privateKeyBase64,
        @Value("${MANAO_WORKSPACE_CAPABILITY_PUBLIC_KEY:}") String publicKeyBase64) {
        if (privateKeyBase64.isBlank() || publicKeyBase64.isBlank()) {
            throw new IllegalStateException("workspace capability key pair is required");
        }
        WorkspaceCapabilitySigner signer = new WorkspaceCapabilitySigner(
            Ed25519Keys.decodeBase64(privateKeyBase64), Clock.systemUTC());
        verifyKeyPair(signer, Ed25519Keys.decodeBase64(publicKeyBase64));
        return signer;
    }

    @Bean
    WorkspaceAgent workspaceAgent(BackendProperties properties, WorkspaceCapabilitySigner signer) {
        // 6B resolves the workspace Service directly in-namespace; the 6A profile swaps this
        // resolver for the managed port-forward bridge in Task 9.
        WorkspaceApiClient.EndpointResolver resolver = WorkspaceApiClient.clusterInternal(
            properties.kubernetes().namespace(), properties.workspace().agentPort());
        return new WorkspaceApiClient(resolver, signer);
    }

    @Bean
    KubernetesGateway kubernetesGateway(KubernetesClient client, BackendProperties properties) {
        return new Fabric8KubernetesGateway(client, properties.kubernetes().namespace());
    }

    @Bean
    WorkspaceOperationService workspaceOperationService(WorkspaceStore store, WorkspaceAgent agent) {
        return new WorkspaceOperationService(store, agent);
    }

    @Bean
    WorkspaceService workspaceService(WorkspaceStore store, WorkspaceOperationService operations, WorkspaceAgent agent) {
        return new WorkspaceService(store, operations, agent);
    }

    @Bean
    com.manao.poc4.kubernetes.WorkspaceResourceFactory workspaceResourceFactory(BackendProperties properties) {
        return new com.manao.poc4.kubernetes.WorkspaceResourceFactory(
            properties.kubernetes().namespace(),
            properties.workspace().storageClassName(),
            properties.workspace().agentImage(),
            properties.workspace().initializerImage());
    }

    @Bean
    ProjectProvisioningService projectProvisioningService(WorkspaceStore store, KubernetesGateway gateway,
                                                          WorkspaceService workspace,
                                                          com.manao.poc4.kubernetes.WorkspaceResourceFactory factory,
                                                          @Value("${MANAO_WORKSPACE_CAPABILITY_PUBLIC_KEY:}") String publicKeyBase64) {
        return new ProjectProvisioningService(store, gateway, workspace, factory,
            new WorkspaceTemplate(), publicKeyBase64);
    }

    @Bean
    ProjectRecoveryService projectRecoveryService(WorkspaceStore store, WorkspaceAgent agent,
                                                  KubernetesGateway gateway) {
        return new ProjectRecoveryService(store, agent, gateway, Clock.systemUTC(), Duration.ofMinutes(10));
    }

    @Bean
    com.manao.poc4.run.RunStore runStore(org.springframework.jdbc.core.JdbcTemplate jdbc) {
        return new com.manao.poc4.run.JdbcRunStore(jdbc);
    }

    @Bean
    com.manao.poc4.run.RunPolicy runPolicy(BackendProperties properties) {
        return com.manao.poc4.run.RunPolicy.fromProperties(properties);
    }

    @Bean
    com.manao.poc4.kubernetes.JobResourceFactory jobResourceFactory(BackendProperties properties,
                                                                    @Value("${MANAO_MAVEN_RUNNER_IMAGE:}") String mavenImage) {
        com.manao.poc4.run.RunPolicy policy = com.manao.poc4.run.RunPolicy.fromProperties(properties);
        return new com.manao.poc4.kubernetes.JobResourceFactory(
            properties.kubernetes().namespace(),
            policy.timeoutSeconds(),
            new com.manao.poc4.kubernetes.JobResourceFactory.RunResources(policy.requests().cpuMillis(),
                policy.requests().memoryBytes(), policy.requests().ephemeralStorageBytes()),
            new com.manao.poc4.kubernetes.JobResourceFactory.RunResources(policy.limits().cpuMillis(),
                policy.limits().memoryBytes(), policy.limits().ephemeralStorageBytes()),
            requiredMavenImage(mavenImage));
    }

    @Bean
    com.manao.poc4.kubernetes.ResourceIdentityVerifier resourceIdentityVerifier() {
        return new com.manao.poc4.kubernetes.ResourceIdentityVerifier();
    }

    @Bean
    com.manao.poc4.kubernetes.JobCoordinator jobCoordinator(org.springframework.beans.factory.ObjectProvider<KubernetesClient> client,
                                                            com.manao.poc4.kubernetes.JobResourceFactory factory,
                                                            com.manao.poc4.kubernetes.ResourceIdentityVerifier verifier,
                                                            BackendProperties properties) {
        KubernetesClient kubernetesClient = client.getIfAvailable();
        if (kubernetesClient == null) {
            throw new IllegalStateException("Kubernetes client is required for Job coordination");
        }
        return new com.manao.poc4.kubernetes.Fabric8JobCoordinator(kubernetesClient, factory, verifier,
            properties.kubernetes().namespace());
    }

    @Bean
    com.manao.poc4.run.RunService runService(com.manao.poc4.run.RunStore store,
                                             com.manao.poc4.kubernetes.JobCoordinator coordinator,
                                             com.manao.poc4.run.RunPolicy policy) {
        return new com.manao.poc4.run.RunService(store, coordinator, policy);
    }

    @Bean
    com.manao.poc4.run.RunRecoveryService runRecoveryService(com.manao.poc4.run.RunStore store,
                                                             com.manao.poc4.kubernetes.JobCoordinator coordinator) {
        return new com.manao.poc4.run.RunRecoveryService(store, coordinator);
    }

    private static String requiredMavenImage(String mavenImage) {
        if (mavenImage == null || mavenImage.isBlank()) {
            throw new IllegalStateException("MANAO_MAVEN_RUNNER_IMAGE is required for Maven runs");
        }
        return mavenImage;
    }

    private static void verifyKeyPair(WorkspaceCapabilitySigner signer, byte[] rawPublicKey) {
        try {
            String header = signer.sign("GET", "/probe", new byte[0], "probe");
            String[] parts = header.split("\\.");
            String canonical = "v1\nGET\n/probe\n" + WorkspaceCapabilitySigner.sha256Hex(new byte[0])
                + "\nprobe\n" + parts[2] + "\n" + parts[3];
            java.security.Signature verifier = java.security.Signature.getInstance("Ed25519");
            verifier.initVerify(Ed25519Keys.publicKeyFromRaw(rawPublicKey));
            verifier.update(canonical.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (!verifier.verify(java.util.Base64.getUrlDecoder().decode(parts[4]))) {
                throw new IllegalStateException("workspace capability key pair is not a matching Ed25519 pair");
            }
        } catch (IllegalStateException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new IllegalStateException("workspace capability key pair is not a matching Ed25519 pair", ex);
        }
    }
}
