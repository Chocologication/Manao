package com.manao.poc4.ai;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.RuntimeTemplate;
import com.manao.poc4.run.RunPolicy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/** Immutable, credential-free task authority; JSON order is shared with the worker's golden fixture. */
@JsonPropertyOrder({"schemaVersion", "templateId", "language", "framework", "executionKind", "entrypoint",
    "pythonVersion", "primaryPort", "readinessPath", "mysql", "redis", "filePolicy", "buildGoals",
    "dependencyGroups", "tools"})
public record AgentProjectEnvironment(int schemaVersion, String templateId, String language,
        String framework, String executionKind, String entrypoint, String pythonVersion,
        Integer primaryPort, String readinessPath, boolean mysql, boolean redis, String filePolicy,
        List<String> buildGoals, List<String> dependencyGroups, List<String> tools) {
    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
        .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
        .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);

    public AgentProjectEnvironment {
        RuntimeTemplate template;
        try {
            template = RuntimeTemplate.fromId(templateId);
        } catch (ApiException ex) {
            throw invalid();
        }
        boolean python = "python".equals(template.language());
        if (schemaVersion != 1 || !template.language().equals(language)
                || !frameworkFor(template).equals(framework)
                || !(template.isService() ? "service" : "task").equals(executionKind)
                || !entrypointFor(template).equals(entrypoint)
                || !filePolicyFor(template).equals(filePolicy)
                || !goalsFor(template).equals(buildGoals)
                || !(python ? List.of("main", "test") : List.of()).equals(dependencyGroups)
                || !toolsFor(template).equals(tools)
                || (python ? !RunPolicy.RuntimeInfo.Python.DEFAULT.pythonVersion().equals(pythonVersion)
                           : pythonVersion != null)
                || ((python || template.isNode()) && !template.isService() && (mysql || redis))) {
            throw invalid();
        }
        if (template.isService()) {
            if (primaryPort == null || primaryPort < 1 || primaryPort > 65535
                    || !readinessPathFor(template).equals(readinessPath)) throw invalid();
        } else if (primaryPort != null || readinessPath != null) {
            throw invalid();
        }
        buildGoals = List.copyOf(buildGoals);
        dependencyGroups = List.copyOf(dependencyGroups);
        tools = List.copyOf(tools);
    }

    public String canonicalJson() {
        try {
            return JSON.writeValueAsString(this);
        } catch (java.io.IOException ex) {
            throw new IllegalStateException("cannot serialize project environment", ex);
        }
    }

    public String sha256() {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(canonicalJson().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }

    public static AgentProjectEnvironment fromJson(String json) {
        try {
            var environment = JSON.readValue(json, AgentProjectEnvironment.class);
            if (environment == null) throw invalid();
            return environment;
        } catch (java.io.IOException | IllegalArgumentException ex) {
            throw invalid();
        }
    }

    static String frameworkFor(RuntimeTemplate template) {
        return switch (template) {
            case JAVA_SPRING_BOOT_WEB -> "spring-boot";
            case PYTHON_FASTAPI_WEB -> "fastapi";
            default -> "none";
        };
    }

    static String entrypointFor(RuntimeTemplate template) {
        return switch (template) {
            case JAVA_CONSOLE, JAVA_SPRING_BOOT_WEB -> "com.example.app.App";
            case PYTHON_CONSOLE -> "main.py";
            case PYTHON_FASTAPI_WEB -> "app.main:app";
            case NODE_JAVASCRIPT_CONSOLE, NODE_JAVASCRIPT_WEB -> "src/main.js";
            case NODE_TYPESCRIPT_CONSOLE, NODE_TYPESCRIPT_WEB -> "src/main.ts";
        };
    }

    static String filePolicyFor(RuntimeTemplate template) {
        return template.isNode() ? "node-v1" : "python".equals(template.language()) ? "python-v1" : "java-v1";
    }

    static String readinessPathFor(RuntimeTemplate template) {
        return "java".equals(template.language()) ? "/actuator/health" : "/health/ready";
    }

    static List<String> goalsFor(RuntimeTemplate template) {
        return "python".equals(template.language()) ? List.of("compile", "test")
            : List.of("compile", "test", "package");
    }

    static List<String> toolsFor(RuntimeTemplate template) {
        var tools = new ArrayList<>(List.of("list_files", "read_file", "write_file", "build", "application"));
        if (template.isService()) tools.add("app_http_get");
        tools.add("read_image");
        if ("python".equals(template.language())) tools.add("python_dependencies");
        return List.copyOf(tools);
    }

    static ApiException invalid() {
        return new ApiException("AI_ENVIRONMENT_INVALID", 409, "The task project environment is invalid");
    }
}
