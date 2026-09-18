package com.manao.poc4.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.config.BackendProperties;
import com.manao.poc4.config.BackendProperties.ResourceLimits;

/**
 * Fixed execution policy snapshot persisted with every Run. Command, runtime and limits are
 * server-derived; the browser contract forbids image or environment fields here.
 */
public record RunPolicy(String command, int javaMajor, int mavenMajor, int timeoutSeconds,
                        Resources requests, Resources limits) {
    private static final ObjectMapper JSON = new ObjectMapper();

    public record Resources(long cpuMillis, long memoryBytes, long ephemeralStorageBytes) { }

    public String toJson() {
        try {
            var root = JSON.createObjectNode();
            root.put("command", command);
            var runtime = root.putObject("runtime");
            runtime.put("javaMajor", javaMajor);
            runtime.put("mavenMajor", mavenMajor);
            root.put("timeoutSeconds", timeoutSeconds);
            var resources = root.putObject("resources");
            resources.set("requests", resourcesNode(requests));
            resources.set("limits", resourcesNode(limits));
            return JSON.writeValueAsString(root);
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize run policy", ex);
        }
    }

    private static com.fasterxml.jackson.databind.node.ObjectNode resourcesNode(Resources value) {
        var node = JSON.createObjectNode();
        node.put("cpuMillis", value.cpuMillis());
        node.put("memoryBytes", value.memoryBytes());
        node.put("ephemeralStorageBytes", value.ephemeralStorageBytes());
        return node;
    }

    public static RunPolicy fromProperties(BackendProperties properties) {
        ResourceLimits limits = properties.resources();
        return new RunPolicy(
            properties.fixedCommand(),
            Integer.parseInt(properties.javaVersion()),
            Integer.parseInt(properties.mavenVersion().split("\\.")[0]),
            (int) properties.timeout().toSeconds(),
            new Resources(1000, gib(1), gib(1)),
            new Resources(limits.cpuCores() * 1000L, parseBytes(limits.memory()), parseBytes(limits.ephemeralStorage())));
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
