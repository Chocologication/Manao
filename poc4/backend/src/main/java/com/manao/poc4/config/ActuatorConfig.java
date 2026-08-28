package com.manao.poc4.config;

import io.fabric8.kubernetes.client.Config;
import io.fabric8.kubernetes.client.ConfigBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;

@Configuration
public class ActuatorConfig {
    @Bean
    @ConditionalOnMissingBean(KubernetesClient.class)
    KubernetesClient kubernetesClient(BackendProperties properties) {
        if (properties.kubernetes().inCluster()) {
            return new KubernetesClientBuilder().withConfig(inClusterConfig(properties)).build();
        }
        return new KubernetesClientBuilder().withConfig(localKubeconfig(properties)).build();
    }

    private Config inClusterConfig(BackendProperties properties) {
        try {
            String token = Files.readString(java.nio.file.Path.of(properties.kubernetes().serviceAccountTokenFile())).trim();
            return new ConfigBuilder().withAutoConfigure(false)
                .withMasterUrl("https://" + properties.kubernetes().apiServerHost() + ":"
                    + properties.kubernetes().apiServerPort())
                .withOauthToken(token)
                .withCaCertFile(properties.kubernetes().serviceAccountCaCertificateFile())
                .withNamespace(properties.kubernetes().namespace())
                .build();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot read cluster ServiceAccount token", ex);
        }
    }

    private Config localKubeconfig(BackendProperties properties) {
        File kubeconfigFile = new File(properties.kubernetes().kubeconfigFile());
        if (!kubeconfigFile.isFile() || !kubeconfigFile.canRead()) {
            throw new IllegalStateException("local Kubernetes kubeconfig must be a readable file");
        }
        Config kubeconfig = Config.fromKubeconfig(kubeconfigFile);
        return new ConfigBuilder(kubeconfig).withAutoConfigure(false)
            .withMasterUrl(properties.kubernetes().masterUrl())
            .withNamespace(properties.kubernetes().namespace())
            .build();
    }

    @Bean(name = "kubernetes")
    @ConditionalOnMissingBean(name = "kubernetes")
    HealthIndicator kubernetesHealthIndicator(KubernetesClient client, BackendProperties properties) {
        return () -> {
            try {
                client.pods().inNamespace(properties.kubernetes().namespace()).list();
                return Health.up().build();
            } catch (RuntimeException ex) {
                return Health.down().withDetail("reason", "Kubernetes API unavailable").build();
            }
        };
    }

    @Bean
    @ConditionalOnWebApplication
    SecurityFilterChain healthEndpointSecurity(HttpSecurity http) throws Exception {
        return http.securityMatcher("/actuator/health/**")
            .authorizeHttpRequests(authorize -> authorize.anyRequest().permitAll())
            .csrf(csrf -> csrf.disable())
            .build();
    }
}
