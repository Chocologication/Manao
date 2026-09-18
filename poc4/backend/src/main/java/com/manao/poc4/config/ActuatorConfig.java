package com.manao.poc4.config;

import io.fabric8.kubernetes.client.KubernetesClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;

/**
 * Actuator wiring. The single {@link KubernetesClient} bean lives in WorkspaceConfig; this
 * config consumes it lazily so bean-definition ordering can never produce a duplicate
 * 'kubernetesClient' registration (real-startup failure fixed by this layout).
 */
@Configuration
public class ActuatorConfig {

    @Bean(name = "kubernetes")
    @ConditionalOnMissingBean(name = "kubernetes")
    HealthIndicator kubernetesHealthIndicator(ObjectProvider<KubernetesClient> clientProvider,
                                              BackendProperties properties) {
        return () -> {
            try {
                KubernetesClient client = clientProvider.getIfAvailable();
                if (client == null) {
                    return Health.down().withDetail("reason", "Kubernetes client unavailable").build();
                }
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
