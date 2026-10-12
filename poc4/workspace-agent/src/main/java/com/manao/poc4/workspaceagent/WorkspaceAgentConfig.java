package com.manao.poc4.workspaceagent;

import java.nio.charset.StandardCharsets;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Agent wiring: project-scoped file service over the injected root plus capability verification. */
@Configuration
public class WorkspaceAgentConfig {

    @Bean
    WorkspaceFileService workspaceFileService(@Value("${manao.agent.root:/workspace}") String root) {
        return new WorkspaceFileService(java.nio.file.Path.of(root));
    }

    @Bean
    PythonDependencyTransaction pythonDependencyTransaction(@Value("${manao.agent.root:/workspace}") String root) {
        return new PythonDependencyTransaction(java.nio.file.Path.of(root));
    }

    /**
     * The editor runs the root-owned dependency helper through the fixed isolated interpreter;
     * the resolution budget is configurable but bounded (enforced by the editor constructor).
     */
    @Bean
    PythonDependencyEditor pythonDependencyEditor(
        @Value("${manao.agent.root:/workspace}") String root,
        PythonDependencyTransaction transaction,
        @Value("${manao.agent.pythonDependency.python:/usr/local/bin/python3}") String python,
        @Value("${manao.agent.pythonDependency.helper:/opt/manao-python/dependency_helper.py}") String helper,
        @Value("${manao.agent.pythonDependency.resolutionSeconds:20}") long resolutionSeconds) {
        return new PythonDependencyEditor(java.nio.file.Path.of(root), transaction, python, helper,
            java.time.Duration.ofSeconds(resolutionSeconds));
    }

    @Bean
    WorkspaceCapabilityVerifier workspaceCapabilityVerifier(
        @Value("${MANAO_AGENT_PROJECT_ID:}") String projectId,
        @Value("${MANAO_AGENT_CAPABILITY_PUBLIC_KEY:}") String publicKeyBase64) {
        if (projectId == null || projectId.isBlank()) {
            throw new IllegalStateException("MANAO_AGENT_PROJECT_ID is required");
        }
        if (publicKeyBase64 == null || publicKeyBase64.isBlank()) {
            throw new IllegalStateException("MANAO_AGENT_CAPABILITY_PUBLIC_KEY is required");
        }
        byte[] rawKey = Ed25519Keys.decodeRawPublicKey(publicKeyBase64);
        return new WorkspaceCapabilityVerifier(projectId.trim(), rawKey, java.time.Clock.systemUTC());
    }

    @Bean
    FilterRegistrationBean<WorkspaceCapabilityFilter> workspaceCapabilityFilter(WorkspaceCapabilityVerifier verifier) {
        FilterRegistrationBean<WorkspaceCapabilityFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new WorkspaceCapabilityFilter(verifier));
        registration.addUrlPatterns("/agent/v1/*");
        registration.setOrder(1);
        return registration;
    }
}
