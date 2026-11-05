package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.project.RuntimeTemplate;
import com.manao.poc4.run.RunPolicy;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Derives task authority only from backend-owned project configuration and runtime policy. */
public final class AgentProjectEnvironmentService {
    private final ProjectRuntimeStore projects;
    private final RunPolicy policy;

    public AgentProjectEnvironmentService(ProjectRuntimeStore projects, RunPolicy policy) {
        this.projects = Objects.requireNonNull(projects);
        this.policy = Objects.requireNonNull(policy);
    }

    public AgentProjectEnvironment forProject(String projectId) {
        var spec = projects.loadSpec(projectId);
        if (spec == null) throw missing();
        spec.validate(Set.of());
        var runtime = policy.forProject(spec);
        var template = RuntimeTemplate.fromId(spec.templateId());
        boolean python = "python".equals(template.language());
        String pythonVersion = runtime.runtime() instanceof RunPolicy.RuntimeInfo.Python value
            ? value.pythonVersion() : null;
        return new AgentProjectEnvironment(1, template.id(), runtime.runtime().language(),
            AgentProjectEnvironment.frameworkFor(template), runtime.isService() ? "service" : "task",
            AgentProjectEnvironment.entrypointFor(template), pythonVersion,
            runtime.isService() ? spec.primaryPort() : null,
            runtime.isService() ? python ? "/health/ready" : "/actuator/health" : null,
            spec.mysql(), spec.redis(), python ? "python-v1" : "java-v1",
            AgentProjectEnvironment.goalsFor(template), python ? List.of("main", "test") : List.of(),
            AgentProjectEnvironment.toolsFor(template));
    }

    static ApiException missing() {
        return new ApiException("AI_ENVIRONMENT_MISSING", 409, "A trusted task project environment is required");
    }
}
