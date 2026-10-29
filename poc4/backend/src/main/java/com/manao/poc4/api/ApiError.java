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
        "DEPENDENCY_REQUEST_MISMATCH",
        "AI_TASK_ACTIVE", "AI_TASK_STARTING", "AI_TASK_MISMATCH", "AI_TASK_NOT_FOUND", "AI_TASK_NOT_ACTIVE",
        "AI_CALL_MISMATCH", "AI_CALL_UNSETTLED", "AI_CALL_NEEDS_ATTENTION", "AI_CALL_NOT_FOUND",
        "AI_RESULT_TOO_LARGE",
        "AI_PROGRESS_MISMATCH", "AI_PROGRESS_TOO_LARGE",
        "AI_EPOCH_MISMATCH", "AI_INSTANCE_MISMATCH",
        "AI_REQUEST_TOO_LARGE", "AI_PROJECT_NOT_ENABLED",
        "AI_CONVERSATION_NOT_FOUND", "AI_CONTEXT_CONFLICT", "AI_CONTEXT_UNAVAILABLE",
        "AI_CONTEXT_COMPACTION_FAILED", "AI_CONTEXT_BUSY",
        "AI_WORKER_NOT_CONFIGURED", "AI_WORKER_CONFLICT", "AI_WORKER_UNREACHABLE",
        "AI_WORKER_BAD_RESPONSE", "AI_WORKER_ERROR");

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
            case "AI_TASK_ACTIVE" -> "An AI task owns this project's writes";
            case "AI_TASK_STARTING" -> "Task is starting; try pausing shortly";
            case "AI_TASK_MISMATCH" -> "This task id was already used for a different request";
            case "AI_TASK_NOT_FOUND" -> "Task not found";
            case "AI_TASK_NOT_ACTIVE" -> "Task is not active";
            case "AI_CALL_MISMATCH" -> "This tool call id was already used for a different request";
            case "AI_CALL_UNSETTLED" -> "An earlier tool call has not settled; resolve it before writing";
            case "AI_CALL_NEEDS_ATTENTION" -> "The call outcome is unknown; it needs attention before further writes";
            case "AI_CALL_NOT_FOUND" -> "Call not found";
            case "AI_RESULT_TOO_LARGE" -> "The tool result does not fit the bounded size";
            case "AI_PROGRESS_MISMATCH" -> "This progress seq was already used for a different payload";
            case "AI_PROGRESS_TOO_LARGE" -> "The progress item exceeds the bounded size";
            case "AI_EPOCH_MISMATCH" -> "The worker epoch does not match the task";
            case "AI_INSTANCE_MISMATCH" -> "The task is bound to another worker instance";
            case "AI_REQUEST_TOO_LARGE" -> "The request body exceeds the bounded size";
            case "AI_CONVERSATION_NOT_FOUND" -> "Conversation not found";
            case "AI_CONTEXT_CONFLICT" -> "Conversation context changed";
            case "AI_CONTEXT_UNAVAILABLE" -> "Conversation context is unavailable";
            case "AI_CONTEXT_COMPACTION_FAILED" -> "Conversation compaction failed";
            case "AI_CONTEXT_BUSY" -> "Conversation context is busy";
            case "AI_PROJECT_NOT_ENABLED" -> "Project not found";
            case "AI_WORKER_NOT_CONFIGURED" -> "The worker has no model configuration";
            case "AI_WORKER_CONFLICT" -> "The worker refused the request as a conflict";
            case "AI_WORKER_UNREACHABLE" -> "The worker could not be reached";
            case "AI_WORKER_BAD_RESPONSE" -> "The worker answer was unreadable";
            case "AI_WORKER_ERROR" -> "The worker refused the request";
            default -> "Request failed";
        };
    }
}
