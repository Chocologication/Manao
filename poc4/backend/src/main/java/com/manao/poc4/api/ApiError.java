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
        "TERMINAL_SESSION_ALREADY_ACTIVE", "TERMINAL_TICKET_NOT_AVAILABLE",
        "PROJECT_CREATING", "PROJECT_BUSY", "CLEANUP_INCOMPLETE", "PROJECT_CLEANUP_INCOMPLETE",
        "WORKSPACE_RECONCILIATION_REQUIRED",
        "PUBLIC_PORT_RESERVED", "PUBLIC_PORT_IN_USE", "PUBLIC_PORT_PREFLIGHT_UNAVAILABLE",
        "CREATE_REQUEST_MISMATCH", "DEPENDENCY_NOT_READY",
        "PYTHON_DEPENDENCY_UNSUPPORTED", "PYTHON_DEPENDENCY_NO_WHEEL",
        "PYTHON_DEPENDENCY_RESOLUTION_FAILED", "PYTHON_DEPENDENCY_TIMEOUT",
        "DEPENDENCY_REQUEST_MISMATCH");

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
            case "RUN_ALREADY_ACTIVE" -> "A run is already active";
            case "PROJECT_LOCKED" -> "Project is locked";
            case "WORKSPACE_RECONCILIATION_REQUIRED" ->
                "Workspace needs reconciliation; the operation result is not confirmed";
            case "PROJECT_CREATING" -> "Project is still being created";
            case "PROJECT_BUSY" -> "Project is busy";
            case "CLEANUP_INCOMPLETE", "PROJECT_CLEANUP_INCOMPLETE" -> "Project cleanup is incomplete";
            case "PUBLIC_PORT_RESERVED" -> "Public port is reserved. Choose another port.";
            case "PUBLIC_PORT_IN_USE" -> "Public port is already in use. Choose another port.";
            case "PUBLIC_PORT_PREFLIGHT_UNAVAILABLE" ->
                "Public port availability cannot be verified right now. Try again later.";
            case "CREATE_REQUEST_MISMATCH" -> "Creation request does not match the original request";
            case "DEPENDENCY_NOT_READY" -> "Selected dependencies are not ready yet. Try again once they are ready.";
            case "PYTHON_DEPENDENCY_UNSUPPORTED" ->
                "Dependency changes are not supported for this project or package";
            case "PYTHON_DEPENDENCY_NO_WHEEL" ->
                "No compatible wheel is available for the requested package or version.";
            case "PYTHON_DEPENDENCY_RESOLUTION_FAILED" -> "Dependency resolution failed";
            case "PYTHON_DEPENDENCY_TIMEOUT" -> "Dependency resolution timed out. Try again later.";
            case "DEPENDENCY_REQUEST_MISMATCH" -> "This operation id was already used for a different request";
            default -> "Request failed";
        };
    }
}
