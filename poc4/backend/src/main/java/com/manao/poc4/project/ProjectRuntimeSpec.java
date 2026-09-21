package com.manao.poc4.project;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Immutable project runtime configuration. Public ports keep their declaration order because
 * the first entry decides the primary port. Validation lives inline in this value object;
 * there is no generic validator registry.
 */
public record ProjectRuntimeSpec(String templateId, boolean mysql, boolean redis,
                                 List<Port> publicPorts) {
    public static final String TEMPLATE_JAVA_CONSOLE = "java-console";
    public static final String TEMPLATE_JAVA_SPRING_BOOT_WEB = "java-spring-boot-web";
    private static final Set<String> TEMPLATES = Set.of(TEMPLATE_JAVA_CONSOLE, TEMPLATE_JAVA_SPRING_BOOT_WEB);
    private static final int MAX_PUBLIC_PORTS = 3;
    private static final ObjectMapper JSON = new ObjectMapper();

    public record Port(String name, int targetPort, int publicPort) {}

    public ProjectRuntimeSpec {
        publicPorts = List.copyOf(publicPorts == null ? List.of() : publicPorts);
    }

    /** Legacy name-only requests map to the console template without dependencies or ports. */
    public static ProjectRuntimeSpec console() {
        return new ProjectRuntimeSpec(TEMPLATE_JAVA_CONSOLE, false, false, List.of());
    }

    /** Web-style template with a long-lived service run; console stays a bounded task. */
    public boolean isService() {
        return TEMPLATE_JAVA_SPRING_BOOT_WEB.equals(templateId);
    }

    /** First public mapping decides the primary port; without public ports it stays 8080. */
    public int primaryPort() {
        return publicPorts.isEmpty() ? 8080 : publicPorts.get(0).targetPort();
    }

    public void validate(Set<Integer> reservedPublicPorts) {
        if (!TEMPLATES.contains(templateId)) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        if (publicPorts.size() > MAX_PUBLIC_PORTS) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        // Console projects do not expose public ports; only the web template serves traffic.
        if (!isService() && !publicPorts.isEmpty()) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        Set<String> names = new HashSet<>();
        Set<Integer> publicPortsSeen = new HashSet<>();
        for (Port port : publicPorts) {
            if (port.name() == null || !isValidDnsLabel(port.name()) || !names.add(port.name())) {
                throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            }
            if (port.targetPort() < 1 || port.targetPort() > 65535
                || port.publicPort() < 30000 || port.publicPort() > 31000) {
                throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            }
            if (reservedPublicPorts.contains(port.publicPort())) {
                throw new ApiException("PUBLIC_PORT_RESERVED", 409, "Public port is reserved. Choose another port.");
            }
            if (!publicPortsSeen.add(port.publicPort())) {
                throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            }
        }
    }

    /** Lowercase DNS label: letters, digits and inner hyphens, at most 63 characters. */
    private static boolean isValidDnsLabel(String name) {
        if (name.isEmpty() || name.length() > 63
            || name.startsWith("-") || name.endsWith("-")) {
            return false;
        }
        for (int index = 0; index < name.length(); index++) {
            char current = name.charAt(index);
            boolean lowercase = current >= 'a' && current <= 'z';
            boolean digit = current >= '0' && current <= '9';
            if (!lowercase && !digit && current != '-') {
                return false;
            }
        }
        return true;
    }

    /** Canonical JSON; port order is preserved because the first entry is the primary port. */
    public String toJson() {
        try {
            ObjectNode root = JSON.createObjectNode();
            root.put("templateId", templateId);
            root.put("mysql", mysql);
            root.put("redis", redis);
            ArrayNode ports = root.putArray("publicPorts");
            for (Port port : publicPorts) {
                ObjectNode entry = ports.addObject();
                entry.put("name", port.name());
                entry.put("targetPort", port.targetPort());
                entry.put("publicPort", port.publicPort());
            }
            return JSON.writeValueAsString(root);
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize runtime spec", ex);
        }
    }

    public static ProjectRuntimeSpec parse(String json) {
        if (json == null || json.isBlank()) {
            return console();
        }
        try {
            ObjectNode root = (ObjectNode) JSON.readTree(json);
            String templateId = root.path("templateId").asText(TEMPLATE_JAVA_CONSOLE);
            boolean mysql = root.path("mysql").asBoolean(false);
            boolean redis = root.path("redis").asBoolean(false);
            List<Port> ports = new ArrayList<>();
            var entries = root.path("publicPorts");
            for (int index = 0; index < entries.size(); index++) {
                var entry = entries.get(index);
                ports.add(new Port(entry.path("name").asText(),
                    entry.path("targetPort").asInt(), entry.path("publicPort").asInt()));
            }
            return new ProjectRuntimeSpec(templateId, mysql, redis, ports);
        } catch (Exception ex) {
            throw new IllegalStateException("cannot read runtime spec", ex);
        }
    }

    /** SHA-256 of the canonical JSON; same key with a different digest is a request mismatch. */
    public String creationDigest() {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(toJson().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
