package com.manao.poc4.api;

import java.util.Map;
import java.util.Set;

/** The only error fields exposed to the browser. */
public record ApiError(String code, String message, String traceId) {
    private static final Set<String> CODES = Set.of(
        "UNAUTHENTICATED", "FORBIDDEN", "PROJECT_LIMIT_REACHED", "VALIDATION_ERROR", "INTERNAL_ERROR",
        "INVALID_PATH", "FILE_TOO_LARGE", "BINARY_FILE", "PROJECT_LOCKED", "WORKSPACE_REVISION_CONFLICT",
        "ENTRY_ALREADY_EXISTS", "ENTRY_NOT_FOUND", "DIRECTORY_NOT_EMPTY", "RUN_ALREADY_ACTIVE",
        "RUN_STATE_CONFLICT", "RUN_NOT_FOUND", "LOG_TICKET_NOT_AVAILABLE", "TERMINAL_NOT_AVAILABLE",
        "TERMINAL_SESSION_ALREADY_ACTIVE", "TERMINAL_TICKET_NOT_AVAILABLE");

    public ApiError {
        if (!CODES.contains(code)) code = "INTERNAL_ERROR";
        message = sanitizeMessage(message);
        if (traceId == null || traceId.isBlank() || traceId.length() > 128) traceId = "unknown";
    }

    public Map<String, Object> toMap() {
        return Map.of("code", code, "message", message, "traceId", traceId);
    }

    private static String sanitizeMessage(String message) {
        if (message == null || message.isBlank() || message.length() > 256 || message.chars().anyMatch(Character::isISOControl)) return "Request failed";
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        for (String forbidden : new String[]{"jwt", "password", "pvc", "pod", "job", "command", "stacktrace", "exception", "jdbc:"}) {
            if (lower.contains(forbidden)) return "Request failed";
        }
        return message;
    }
}
