package com.manao.poc4.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.config.BackendProperties;
import com.manao.poc4.config.BackendProperties.ResourceLimits;

/**
 * Fixed execution policy snapshot persisted with every Run. Command, runtime and limits are
 * server-derived; the browser contract forbids image or environment fields here.
 *
 * <p>The execution kind splits the two run shapes: TASK keeps the single overall
 * {@code timeoutSeconds} deadline, while SERVICE (bounded web session) derives the Job backstop
 * from {@code startupTimeoutSeconds} (from Run creation) plus the immutable
 * {@code serviceLifetimeSeconds} that starts at first readiness. Legacy records without these
 * fields are interpreted as TASK, never mixing the old total-timeout semantics into services.</p>
 */
public record RunPolicy(String command, int javaMajor, int mavenMajor, int timeoutSeconds,
                        String executionKind, int startupTimeoutSeconds, int serviceLifetimeSeconds,
                        Resources requests, Resources limits) {
    private static final ObjectMapper JSON = new ObjectMapper();

    public static final String EXECUTION_KIND_TASK = "TASK";
    public static final String EXECUTION_KIND_SERVICE = "SERVICE";
    /** The fixed lifetime armed at first readiness; the receipt rule and the store share it. */
    public static final long WEB_SERVICE_LIFETIME_SECONDS = 7200L;

    public record Resources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    public boolean isService() {
        return EXECUTION_KIND_SERVICE.equals(executionKind);
    }

    /** The SERVICE variant of this policy: startup budget from creation, fixed readiness lifetime. */
    public RunPolicy forService() {
        return new RunPolicy(command, javaMajor, mavenMajor, timeoutSeconds, EXECUTION_KIND_SERVICE,
            timeoutSeconds, (int) WEB_SERVICE_LIFETIME_SECONDS, requests, limits);
    }

    public String toJson() {
        try {
            var root = JSON.createObjectNode();
            root.put("command", command);
            var runtime = root.putObject("runtime");
            runtime.put("javaMajor", javaMajor);
            runtime.put("mavenMajor", mavenMajor);
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

    /** Reads the persisted snapshot; legacy rows (no execution fields) stay TASK runs. */
    public static RunPolicy fromJson(String json) {
        try {
            JsonNode root = JSON.readTree(json);
            String executionKind = root.path("executionKind").asText(EXECUTION_KIND_TASK);
            if (!EXECUTION_KIND_TASK.equals(executionKind) && !EXECUTION_KIND_SERVICE.equals(executionKind)) {
                throw new IllegalStateException("stored policy execution kind is unknown: " + executionKind);
            }
            return new RunPolicy(
                root.path("command").asText(),
                root.path("runtime").path("javaMajor").asInt(),
                root.path("runtime").path("mavenMajor").asInt(),
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
            properties.fixedCommand(),
            Integer.parseInt(properties.javaVersion()),
            Integer.parseInt(properties.mavenVersion().split("\\.")[0]),
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
