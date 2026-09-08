package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import com.manao.poc4.Poc4BackendApplication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;

class ConfigurationTest {

    @TempDir
    Path temporaryDirectory;

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
        // Profile-default assertions must not inherit the operator or disposable MySQL test URL.
        .withInitializer(context -> context.getEnvironment().getPropertySources().remove(
            org.springframework.core.env.StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME))
        .withInitializer(new ConfigDataApplicationContextInitializer())
        .withUserConfiguration(Poc4BackendApplication.class)
        .withPropertyValues(
            "spring.main.web-application-type=none",
            "spring.main.banner-mode=off",
            "logging.level.root=OFF",
            "spring.autoconfigure.exclude=" + DataSourceAutoConfiguration.class.getName(),
            "management.endpoint.health.group.readiness.include=readinessState,kubernetes");

    @Test
    void localClusterAndClusterLoadDistinctDatasourceAndKubernetesSettings() {
        localContextRunner()
            .run(local -> {
                BackendProperties localProperties = local.getBean(BackendProperties.class);
                assertThat(localProperties.profile()).isEqualTo(BackendProfile.LOCAL_CLUSTER);
                assertThat(local.getEnvironment().getProperty("spring.datasource.url"))
                    .isEqualTo("jdbc:mysql://127.0.0.1:3306/manao_poc4");
                assertThat(localProperties.kubernetes().masterUrl()).isEqualTo("https://127.0.0.1:6443");
                assertThat(localProperties.kubernetes().inCluster()).isFalse();
                assertThat(localProperties.kubernetes().serviceAccount()).isFalse();
            });

        clusterContextRunner()
            .run(cluster -> {
                BackendProperties clusterProperties = cluster.getBean(BackendProperties.class);
                assertThat(clusterProperties.profile()).isEqualTo(BackendProfile.CLUSTER);
                assertThat(cluster.getEnvironment().getProperty("spring.datasource.url"))
                    .isEqualTo("jdbc:mysql://mysql:3306/manao_poc4");
                assertThat(clusterProperties.kubernetes().masterUrl()).isEmpty();
                assertThat(clusterProperties.kubernetes().inCluster()).isTrue();
                assertThat(clusterProperties.kubernetes().serviceAccount()).isTrue();
            });
    }

    @Test
    void localClusterUsesTheBrowserBackendPort() {
        localContextRunner().run(context ->
            assertThat(context.getEnvironment().getProperty("server.port")).isEqualTo("18080"));
    }

    @Test
    void exposesTheFixedExecutionAndWorkspacePolicy() {
        localContextRunner()
            .run(context -> {
                BackendProperties properties = context.getBean(BackendProperties.class);
                assertThat(properties.fixedCommand()).isEqualTo("mvn clean test");
                assertThat(properties.javaVersion()).isEqualTo("17");
                assertThat(properties.mavenVersion()).isEqualTo("3.9.11");
                assertThat(properties.timeout()).hasSeconds(1800);
                assertThat(properties.resources().cpuCores()).isEqualTo(8);
                assertThat(properties.resources().memory()).isEqualTo("16Gi");
                assertThat(properties.resources().ephemeralStorage()).isEqualTo("10Gi");
                assertThat(properties.workspace().pvcSize()).isEqualTo("10Gi");
                assertThat(properties.workspace().accessMode()).isEqualTo("ReadWriteMany");
                assertThat(properties.workspace().bridgePortStart()).isEqualTo(18100);
                assertThat(properties.workspace().bridgePortEnd()).isEqualTo(18199);
                assertThat(properties.workspace().agentPort()).isEqualTo(8080);
            });
    }

    @Test
    void environmentAndBrowserPolicyOverridesDoNotChangeFixedValues() {
        localContextRunner().withPropertyValues(
                "manao.poc4.backend.java-version=21",
                "manao.poc4.backend.maven-version=3.8.8",
                "manao.poc4.backend.timeout=1s",
                "manao.poc4.backend.resources.cpu-cores=1",
                "manao.poc4.backend.resources.memory=1Gi",
                "manao.poc4.backend.resources.ephemeral-storage=1Gi",
                "manao.poc4.backend.workspace.pvc-size=1Gi",
                "manao.poc4.backend.workspace.access-mode=ReadWriteOnce",
                "manao.poc4.backend.workspace.bridge-port-start=1",
                "manao.poc4.backend.workspace.bridge-port-end=2",
                "manao.poc4.backend.workspace.agent-port=1")
            .run(context -> {
                assertThat(context.getStartupFailure()).isNull();
                BackendProperties properties = context.getBean(BackendProperties.class);
                assertThat(properties.fixedCommand()).isEqualTo("mvn clean test");
                assertThat(properties.javaVersion()).isEqualTo("17");
                assertThat(properties.mavenVersion()).isEqualTo("3.9.11");
                assertThat(properties.timeout()).hasSeconds(1800);
                assertThat(properties.resources().cpuCores()).isEqualTo(8);
                assertThat(properties.resources().memory()).isEqualTo("16Gi");
                assertThat(properties.resources().ephemeralStorage()).isEqualTo("10Gi");
                assertThat(properties.workspace().pvcSize()).isEqualTo("10Gi");
                assertThat(properties.workspace().accessMode()).isEqualTo("ReadWriteMany");
                assertThat(properties.workspace().bridgePortStart()).isEqualTo(18100);
                assertThat(properties.workspace().bridgePortEnd()).isEqualTo(18199);
                assertThat(properties.workspace().agentPort()).isEqualTo(8080);
            });
    }

    @Test
    void clusterRequiresExplicitInClusterServiceAccountSemantics() {
        clusterContextRunner()
            .run(context -> assertThat(context.getStartupFailure()).isNull());

        clusterContextRunner().withPropertyValues(
                "manao.poc4.backend.kubernetes.in-cluster=false")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());

        localContextRunner().withPropertyValues(
                "manao.poc4.backend.kubernetes.in-cluster=true")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    @Test
    void clusterStartupFailsWithoutMountedServiceAccountCredentials() {
        contextRunner.withPropertyValues("spring.profiles.active=cluster")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    @Test
    void localStartupFailsWithoutExternalEndpointAndKubeconfig() {
        contextRunner.withPropertyValues("spring.profiles.active=local-cluster")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    @Test
    void browserFieldsCannotOverrideTheFixedServerPolicy() {
        localContextRunner().withPropertyValues(
                "manao.poc4.backend.fixed-command=browser-command")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    @Test
    void unknownPolicyPropertyFailsStartup() {
        localContextRunner().withPropertyValues(
                "manao.poc4.backend.unknown-policy=changed")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }

    private ApplicationContextRunner clusterContextRunner() {
        try {
            Path token = temporaryDirectory.resolve("service-account-token");
            Path certificate = temporaryDirectory.resolve("service-account-ca.crt");
            Files.writeString(token, "test-token");
            Files.writeString(certificate, "test-ca");
            return contextRunner.withPropertyValues(
                "spring.profiles.active=cluster",
                "manao.poc4.backend.kubernetes.api-server-host=10.0.0.1",
                "manao.poc4.backend.kubernetes.api-server-port=443",
                "manao.poc4.backend.kubernetes.service-account-token-file=" + token,
                "manao.poc4.backend.kubernetes.service-account-ca-certificate-file=" + certificate);
        } catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private ApplicationContextRunner localContextRunner() {
        try {
            Path kubeconfig = temporaryDirectory.resolve("kubeconfig.yaml");
            Files.writeString(kubeconfig, """
                apiVersion: v1
                kind: Config
                clusters:
                - name: test-cluster
                  cluster:
                    server: https://127.0.0.1:6443
                contexts:
                - name: test-context
                  context:
                    cluster: test-cluster
                    user: test-user
                current-context: test-context
                users:
                - name: test-user
                  user:
                    token: test-token
                """);
            return contextRunner.withPropertyValues(
                "spring.profiles.active=local-cluster",
                "manao.poc4.backend.kubernetes.master-url=https://127.0.0.1:6443",
                "KUBECONFIG=" + kubeconfig);
        } catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
