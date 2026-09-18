package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manao.poc4.Poc4BackendApplication;
import io.fabric8.kubernetes.client.ConfigBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.CompositeHealth;
import org.springframework.boot.actuate.health.HealthEndpoint;
import org.springframework.boot.actuate.health.HealthIndicator;

@SpringBootTest(classes = Poc4BackendApplication.class,
    properties = {
        "spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration",
        "spring.main.allow-bean-definition-overriding=true",
        "spring.main.banner-mode=off",
        "logging.level.root=OFF",
        "manao.poc4.backend.kubernetes.master-url=https://127.0.0.1:6443"
    })
@AutoConfigureMockMvc
@ActiveProfiles("local-cluster")
@Import(HealthEndpointTest.HealthTestConfiguration.class)
class HealthEndpointTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private HealthEndpoint healthEndpoint;

    @Autowired
    @Qualifier("db")
    private SwitchableHealthIndicator databaseHealth;

    @Autowired
    @Qualifier("kubernetes")
    private SwitchableHealthIndicator kubernetesHealth;

    @BeforeEach
    void setHealthyDependencies() {
        databaseHealth.setAvailable(true);
        kubernetesHealth.setAvailable(true);
    }

    @Test
    void databaseDownKeepsLivenessUpAndMakesReadinessUnavailable() throws Exception {
        databaseHealth.setAvailable(false);
        assertThat(databaseHealth.health().getStatus().getCode()).isEqualTo("DOWN");
        assertThat(((CompositeHealth) healthEndpoint.healthForPath("readiness")).getComponents()
            .get("db").getStatus().getCode()).isEqualTo("DOWN");
        assertLivenessAndReadinessResponses();
    }

    @Test
    void kubernetesDownKeepsLivenessUpAndMakesReadinessUnavailable() throws Exception {
        kubernetesHealth.setAvailable(false);
        assertThat(kubernetesHealth.health().getStatus().getCode()).isEqualTo("DOWN");
        assertThat(((CompositeHealth) healthEndpoint.healthForPath("readiness")).getComponents()
            .get("kubernetes").getStatus().getCode()).isEqualTo("DOWN");
        assertLivenessAndReadinessResponses();
    }

    private void assertLivenessAndReadinessResponses() throws Exception {
        mockMvc.perform(get("/actuator/health/liveness"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("UP"));

        mockMvc.perform(get("/actuator/health/readiness"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.status").value("DOWN"))
            .andExpect(result -> {
                String body = result.getResponse().getContentAsString();
                assertThat(body).doesNotContain("jdbc:", "manao", "pvc", "pod", "exception", "stackTrace", "reason", "connection");
            });
    }

    @TestConfiguration
    static class HealthTestConfiguration {
        @Bean
        KubernetesClient testKubernetesClient() {
            return new KubernetesClientBuilder().withConfig(new ConfigBuilder()
                .withAutoConfigure(false)
                .withMasterUrl("https://127.0.0.1:6443")
                .build()).build();
        }

        @Bean(name = "db")
        SwitchableHealthIndicator databaseHealth() {
            return new SwitchableHealthIndicator();
        }

        @Bean(name = "kubernetes")
        SwitchableHealthIndicator kubernetesHealth() {
            return new SwitchableHealthIndicator();
        }
    }

    static final class SwitchableHealthIndicator implements HealthIndicator {
        private boolean available = true;

        void setAvailable(boolean available) {
            this.available = available;
        }

        @Override
        public Health health() {
            return available
                ? Health.up().build()
                : Health.down().withDetail("connection", "jdbc:mysql://manao-poc4/pvc").build();
        }
    }
}
