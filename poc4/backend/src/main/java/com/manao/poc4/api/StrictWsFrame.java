package com.manao.poc4.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Strict WebSocket frame parser: objects only, exact field allowlists, and typed scalars.
 * Unknown fields, coerced strings, and missing required values fail closed.
 */
public final class StrictWsFrame {
    private StrictWsFrame() { }

    public static ObjectNode object(ObjectMapper json, String payload) {
        JsonNode node;
        try {
            node = json.readTree(payload);
        } catch (Exception ex) {
            throw new IllegalArgumentException("invalid json");
        }
        if (node == null || !node.isObject()) {
            throw new IllegalArgumentException("frame must be an object");
        }
        return (ObjectNode) node;
    }

    public static void requireExactFields(ObjectNode node, String... fields) {
        Set<String> expected = new LinkedHashSet<>(Arrays.asList(fields));
        Set<String> actual = new LinkedHashSet<>();
        node.fieldNames().forEachRemaining(actual::add);
        if (!actual.equals(expected)) {
            throw new IllegalArgumentException("unexpected fields");
        }
    }

    public static String requireText(ObjectNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual()) {
            throw new IllegalArgumentException(field + " must be a string");
        }
        String text = value.asText();
        if (text.isEmpty()) {
            throw new IllegalArgumentException(field + " must be a non-empty string");
        }
        return text;
    }

    public static int requireInt(ObjectNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return value.intValue();
    }

    public static Long requireNullableNonNegativeLong(ObjectNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isIntegralNumber() || !value.canConvertToLong()) {
            throw new IllegalArgumentException(field + " must be an integer or null");
        }
        long parsed = value.longValue();
        if (parsed < 0) {
            throw new IllegalArgumentException(field + " must be non-negative");
        }
        return parsed;
    }
}
