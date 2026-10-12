package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.util.PropertyPlaceholderHelper;

/**
 * Pins the deployment-facing default of the dependency resolution budget: the agent's
 * {@code resolutionSeconds} resolves to the design's 20s initial value when its environment
 * variable is absent, and it is the documented pair of the backend's
 * {@code MANAO_PYTHON_DEPENDENCY_RESOLUTION_SECONDS} (see both application.yml files — the two
 * MUST be overridden together, because the backend derives its prepare request timeout from
 * this budget plus a bounded margin).
 */
class PythonDependencyBudgetConfigTest {
    private static final String AGENT_KEY = "manao.agent.pythonDependency.resolutionSeconds";
    private static final String AGENT_ENV = "MANAO_AGENT_PYTHON_DEPENDENCY_RESOLUTION_SECONDS";

    @Test
    void agentBudgetDefaultReadsTheDesignInitialTwentySeconds() {
        Properties yaml = yamlProperties();
        String raw = yaml.getProperty(AGENT_KEY);
        assertThat(raw).as("application.yml must configure the resolution budget").isNotNull();
        // The deployment-facing default lives in the placeholder itself.
        assertThat(raw).startsWith("${" + AGENT_ENV + ":").endsWith("}");

        // With the environment variable absent the property resolves to the default: 20.
        PropertyPlaceholderHelper resolver = new PropertyPlaceholderHelper("${", "}", ":", true);
        String resolved = resolver.replacePlaceholders(raw, name -> null);
        assertThat(resolved).isEqualTo("20");
    }

    private Properties yamlProperties() {
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        yaml.afterPropertiesSet();
        return yaml.getObject();
    }
}
