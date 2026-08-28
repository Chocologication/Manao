package com.manao.poc4.api;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

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
        message = safeMessage(code);
        traceId = UUID.randomUUID().toString();
    }

    public Map<String, Object> toMap() {
        return Map.of("code", code, "message", message, "traceId", traceId);
    }

    private static String safeMessage(String code) {
        return switch (code) {
            case "UNAUTHENTICATED" -> "Authentication required";
            case "FORBIDDEN" -> "Access denied";
            case "PROJECT_LIMIT_REACHED" -> "Project limit reached";
            case "VALIDATION_ERROR" -> "Request validation failed";
            case "ENTRY_NOT_FOUND" -> "Project not found";
            default -> "Request failed";
        };
    }
}
