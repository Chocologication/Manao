package com.manao.poc4.config;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.fabric8.kubernetes.client.ConfigBuilder;

@Configuration
public class ActuatorConfig {
    @Bean
    KubernetesClient kubernetesClient(BackendProperties properties) {
        return new KubernetesClientBuilder().withConfig(new ConfigBuilder()
            .withMasterUrl(properties.kubernetes().masterUrl())
            .build()).build();
    }

    @Bean(name = "kubernetes")
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
        return http.authorizeHttpRequests(authorize -> authorize
                .requestMatchers("/actuator/health/**").permitAll()
                .anyRequest().authenticated())
            .csrf(csrf -> csrf.disable())
            .build();
    }
}
