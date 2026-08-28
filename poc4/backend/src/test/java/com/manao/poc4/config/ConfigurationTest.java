package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;
import com.manao.poc4.Poc4BackendApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;

class ConfigurationTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
        .withInitializer(new ConfigDataApplicationContextInitializer())
        .withUserConfiguration(Poc4BackendApplication.class)
        .withPropertyValues(
            "spring.main.web-application-type=none",
            "spring.autoconfigure.exclude=" + DataSourceAutoConfiguration.class.getName(),
            "management.endpoint.health.group.readiness.include=readinessState,kubernetes");

    @Test
    void localClusterAndClusterLoadDistinctDatasourceAndKubernetesSettings() {
        contextRunner.withPropertyValues("spring.profiles.active=local-cluster")
            .run(local -> {
                BackendProperties localProperties = local.getBean(BackendProperties.class);
                assertThat(localProperties.profile()).isEqualTo(BackendProfile.LOCAL_CLUSTER);
                assertThat(local.getEnvironment().getProperty("spring.datasource.url"))
                    .isEqualTo("jdbc:mysql://127.0.0.1:3306/manao_poc4");
                assertThat(localProperties.kubernetes().masterUrl()).isEqualTo("https://127.0.0.1:6443");
            });

        contextRunner.withPropertyValues("spring.profiles.active=cluster")
            .run(cluster -> {
                BackendProperties clusterProperties = cluster.getBean(BackendProperties.class);
                assertThat(clusterProperties.profile()).isEqualTo(BackendProfile.CLUSTER);
                assertThat(cluster.getEnvironment().getProperty("spring.datasource.url"))
                    .isEqualTo("jdbc:mysql://mysql:3306/manao_poc4");
                assertThat(clusterProperties.kubernetes().masterUrl()).isEmpty();
            });
    }

    @Test
    void browserFieldsCannotOverrideTheFixedServerPolicy() {
        contextRunner.withPropertyValues(
                "spring.profiles.active=local-cluster",
                "manao.poc4.backend.fixed-command=browser-command")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    @Test
    void unknownPolicyPropertyFailsStartup() {
        contextRunner.withPropertyValues(
                "spring.profiles.active=local-cluster",
                "manao.poc4.backend.unknown-policy=changed")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }
}
