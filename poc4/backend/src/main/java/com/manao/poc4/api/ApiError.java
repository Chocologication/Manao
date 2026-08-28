package com.manao.poc4.api;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** The only error fields exposed to the browser. */
public record ApiError(String code, String message, String traceId) {
    private static final Set<String> CODES = Set.of(
        "UNAUTHENTICATED", "FORBIDDEN", "PROJECT_LIMIT_REACHED", "VALIDATION_ERROR", "INTERNAL_ERROR",
        "INVALID_PATH", "FILE_TOO_LARGE", "BINARY_FILE", "PROJECT_LOCKED", "WORKSPACE_REVISION_CONFLICT",
        "ENTRY_ALREADY_EXISTS", "ENTRY_NOT_FOUND", "DIRECTORY_NOT_EMPTY", "RUN_ALREADY_ACTIVE",
        "RUN_STATE_CONFLICT", "RUN_NOT_FOUND", "LOG_TICKET_NOT_AVAILABLE", "TERMINAL_NOT_AVAILABLE",
        "TERMINAL_SESSION_ALREADY_ACTIVE", "TERMINAL_TICKET_NOT_AVAILABLE");
    private static final Pattern TRACE_ID = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}");

    public ApiError {
        if (!CODES.contains(code)) code = "INTERNAL_ERROR";
        message = sanitizeMessage(message);
        if (traceId == null || !TRACE_ID.matcher(traceId).matches()) traceId = UUID.randomUUID().toString();
    }

    public Map<String, Object> toMap() {
        return Map.of("code", code, "message", message, "traceId", traceId);
    }

    private static String sanitizeMessage(String message) {
        if (message == null || message.isBlank() || message.length() > 256 || message.chars().anyMatch(Character::isISOControl)) return "Request failed";
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        for (String forbidden : new String[]{"jwt", "token", "password", "pvc", "pod", "job", "command", "requestid", "request-id", "path", "stacktrace", "exception", "jdbc:", "resource"}) {
            if (lower.contains(forbidden)) return "Request failed";
        }
        if (message.contains("/") || message.contains("\\") || message.contains("..")) return "Request failed";
        return message;
    }
}
