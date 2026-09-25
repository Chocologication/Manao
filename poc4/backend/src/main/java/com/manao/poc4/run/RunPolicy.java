package com.manao.poc4.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.BackendProperties;
import com.manao.poc4.config.BackendProperties.ResourceLimits;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.RuntimeTemplate;

/**
 * Fixed execution policy snapshot persisted with every Run. Command, runtime and limits are
 * server-derived; the browser contract forbids image or environment fields here.
 *
 * <p>The snapshot records its {@code templateId} and a language-discriminated {@code runtime}:
 * Java writes Java/Maven fields, Python writes Python/uv fields — a Python response never
 * fabricates a Java version. New-format rows must agree with their template on language,
 * execution kind and display command; unknown or conflicting data is rejected instead of
 * falling back to Java.</p>
 *
 * <p>Rows written before the template contract carry no templateId; they are interpreted by
 * their execution kind as historical Java runs (TASK console, SERVICE web) and keep their
 * historical command display — history is never rewritten.</p>
 */
public record RunPolicy(String templateId, RuntimeInfo runtime, String command, int timeoutSeconds,
                        String executionKind, int startupTimeoutSeconds, int serviceLifetimeSeconds,
                        Resources requests, Resources limits) {
    private static final ObjectMapper JSON = new ObjectMapper();

    public static final String EXECUTION_KIND_TASK = "TASK";
    public static final String EXECUTION_KIND_SERVICE = "SERVICE";
    /** The fixed lifetime armed at first readiness; the receipt rule and the store share it. */
    public static final long WEB_SERVICE_LIFETIME_SECONDS = 7200L;

    public record Resources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    /** The language-discriminated runtime identity of a snapshot; one JSON shape per language. */
    public sealed interface RuntimeInfo {
        String language();

        void writeTo(ObjectNode runtimeNode);

        static RuntimeInfo fromJson(JsonNode runtimeNode) {
            String language = runtimeNode.path("language").asText("");
            return switch (language) {
                case "java" -> new Java(runtimeNode.path("javaMajor").asInt(),
                    runtimeNode.path("mavenMajor").asInt());
                case "python" -> new Python(runtimeNode.path("pythonVersion").asText(),
                    runtimeNode.path("packageManager").asText());
                default -> throw new IllegalStateException("stored policy runtime language is unknown: " + language);
            };
        }

        /** Legacy rows predate the language discriminator; only confirmed Java snapshots are readable. */
        static RuntimeInfo fromLegacyJson(JsonNode runtimeNode) {
            if (!runtimeNode.has("javaMajor") || !runtimeNode.has("mavenMajor")) {
                throw new IllegalStateException("stored policy snapshot has no runtime information");
            }
            return new Java(runtimeNode.path("javaMajor").asInt(), runtimeNode.path("mavenMajor").asInt());
        }

        record Java(int javaMajor, int mavenMajor) implements RuntimeInfo {
            @Override public String language() { return "java"; }

            @Override public void writeTo(ObjectNode runtimeNode) {
                runtimeNode.put("language", "java");
                runtimeNode.put("javaMajor", javaMajor);
                runtimeNode.put("mavenMajor", mavenMajor);
            }
        }

        record Python(String pythonVersion, String packageManager) implements RuntimeInfo {
            /** The fixed toolchain of this stage; the launcher images pin the same versions. */
            public static final Python DEFAULT = new Python("3.13", "uv");

            @Override public String language() { return "python"; }

            @Override public void writeTo(ObjectNode runtimeNode) {
                runtimeNode.put("language", "python");
                runtimeNode.put("pythonVersion", pythonVersion);
                runtimeNode.put("packageManager", packageManager);
            }
        }
    }

    public RunPolicy {
        templateId = templateId == null || templateId.isBlank() ? null : templateId;
        if (runtime == null) {
            throw new IllegalStateException("run policy runtime information is missing");
        }
        if (!EXECUTION_KIND_TASK.equals(executionKind) && !EXECUTION_KIND_SERVICE.equals(executionKind)) {
            throw new IllegalStateException("stored policy execution kind is unknown: " + executionKind);
        }
        if (templateId == null) {
            // Template-less rows are the historical Java records and nothing else.
            if (!"java".equals(runtime.language())) {
                throw new IllegalStateException("stored policy without a template must be a Java runtime");
            }
        } else {
            RuntimeTemplate template;
            try {
                template = RuntimeTemplate.fromId(templateId);
            } catch (ApiException ex) {
                throw new IllegalStateException("stored policy template is unknown: " + templateId);
            }
            if (!template.language().equals(runtime.language())) {
                throw new IllegalStateException("stored policy runtime language conflicts with template " + templateId);
            }
            if (template.isService() != EXECUTION_KIND_SERVICE.equals(executionKind)) {
                throw new IllegalStateException("stored policy execution kind conflicts with template " + templateId);
            }
            if (!template.displayCommand().equals(command)) {
                throw new IllegalStateException("stored policy command conflicts with template " + templateId);
            }
        }
    }

    /** The fixed template behind this policy; template-less rows keep their historical Java semantics. */
    public RuntimeTemplate template() {
        if (templateId != null) {
            return RuntimeTemplate.fromId(templateId);
        }
        return isService() ? RuntimeTemplate.JAVA_SPRING_BOOT_WEB : RuntimeTemplate.JAVA_CONSOLE;
    }

    public boolean isService() {
        return EXECUTION_KIND_SERVICE.equals(executionKind);
    }

    /**
     * The project-specific snapshot: fixed command and runtime per the project's template, with
     * the budgets and resources of this (server default) policy.
     */
    public RunPolicy forProject(ProjectRuntimeSpec spec) {
        RuntimeTemplate template = RuntimeTemplate.fromId(spec.templateId());
        RuntimeInfo projectRuntime = switch (template) {
            case JAVA_CONSOLE, JAVA_SPRING_BOOT_WEB -> javaRuntime();
            case PYTHON_CONSOLE, PYTHON_FASTAPI_WEB -> RuntimeInfo.Python.DEFAULT;
        };
        return new RunPolicy(template.id(), projectRuntime, template.displayCommand(), timeoutSeconds,
            template.isService() ? EXECUTION_KIND_SERVICE : EXECUTION_KIND_TASK, startupTimeoutSeconds,
            template.isService() ? (int) WEB_SERVICE_LIFETIME_SECONDS : 0, requests, limits);
    }

    private RuntimeInfo.Java javaRuntime() {
        if (runtime instanceof RuntimeInfo.Java java) {
            return java;
        }
        throw new IllegalStateException("the base run policy carries no Java runtime");
    }

    public String toJson() {
        try {
            var root = JSON.createObjectNode();
            if (templateId != null) {
                root.put("templateId", templateId);
            }
            root.put("command", command);
            runtime.writeTo(root.putObject("runtime"));
            root.put("timeoutSeconds", timeoutSeconds);
            root.put("executionKind", executionKind);
            root.put("startupTimeoutSeconds", startupTimeoutSeconds);
            root.put("serviceLifetimeSeconds", serviceLifetimeSeconds);
            var resources = root.putObject("resources");
            resources.set("requests", resourcesNode(requests));
            resources.set("limits", resourcesNode(limits));
            return JSON.writeValueAsString(root);
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize run policy", ex);
        }
    }

    /**
     * Reads the persisted snapshot. Template-less rows stay historical Java runs decided by the
     * execution kind; new-format rows are consistency-checked against their template above.
     */
    public static RunPolicy fromJson(String json) {
        try {
            JsonNode root = JSON.readTree(json);
            String executionKind = root.path("executionKind").asText(EXECUTION_KIND_TASK);
            if (!EXECUTION_KIND_TASK.equals(executionKind) && !EXECUTION_KIND_SERVICE.equals(executionKind)) {
                throw new IllegalStateException("stored policy execution kind is unknown: " + executionKind);
            }
            String templateId = root.path("templateId").asText("");
            RuntimeInfo runtime = templateId.isEmpty()
                ? RuntimeInfo.fromLegacyJson(root.path("runtime"))
                : RuntimeInfo.fromJson(root.path("runtime"));
            return new RunPolicy(
                templateId.isEmpty() ? null : templateId,
                runtime,
                root.path("command").asText(),
                root.path("timeoutSeconds").asInt(),
                executionKind,
                root.path("startupTimeoutSeconds").asInt(0),
                root.path("serviceLifetimeSeconds").asInt(0),
                new Resources(root.path("resources").path("requests").path("cpuMillis").asLong(),
                    root.path("resources").path("requests").path("memoryBytes").asLong(),
                    root.path("resources").path("requests").path("ephemeralStorageBytes").asLong()),
                new Resources(root.path("resources").path("limits").path("cpuMillis").asLong(),
                    root.path("resources").path("limits").path("memoryBytes").asLong(),
                    root.path("resources").path("limits").path("ephemeralStorageBytes").asLong()));
        } catch (IllegalStateException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new IllegalStateException("stored policy snapshot is unreadable", ex);
        }
    }

    public static RunPolicy fromProperties(BackendProperties properties) {
        ResourceLimits limits = properties.resources();
        return new RunPolicy(
            RuntimeTemplate.JAVA_CONSOLE.id(),
            new RuntimeInfo.Java(Integer.parseInt(properties.javaVersion()),
                Integer.parseInt(properties.mavenVersion().split("\\.")[0])),
            RuntimeTemplate.JAVA_CONSOLE.displayCommand(),
            (int) properties.timeout().toSeconds(),
            EXECUTION_KIND_TASK,
            (int) properties.timeout().toSeconds(),
            0,
            new Resources(1000, gib(1), gib(1)),
            new Resources(limits.cpuCores() * 1000L, parseBytes(limits.memory()), parseBytes(limits.ephemeralStorage())));
    }

    private static com.fasterxml.jackson.databind.node.ObjectNode resourcesNode(Resources value) {
        var node = JSON.createObjectNode();
        node.put("cpuMillis", value.cpuMillis());
        node.put("memoryBytes", value.memoryBytes());
        node.put("ephemeralStorageBytes", value.ephemeralStorageBytes());
        return node;
    }

    static long parseBytes(String quantity) {
        String value = quantity.trim().toUpperCase();
        long multiplier = 1;
        if (value.endsWith("GI")) { multiplier = 1024L * 1024 * 1024; value = value.substring(0, value.length() - 2); }
        else if (value.endsWith("MI")) { multiplier = 1024L * 1024; value = value.substring(0, value.length() - 2); }
        else if (value.endsWith("KI")) { multiplier = 1024L; value = value.substring(0, value.length() - 2); }
        return Long.parseLong(value) * multiplier;
    }

    private static long gib(long value) { return value * 1024L * 1024 * 1024; }
}
