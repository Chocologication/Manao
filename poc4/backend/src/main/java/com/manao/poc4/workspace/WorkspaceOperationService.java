package com.manao.poc4.workspace;

import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Two-phase workspace write protocol: persist a PENDING operation, drive the agent's atomic write
 * with a pre-committed deterministic receipt, then conditionally commit and advance the MySQL
 * revision. Any ambiguity fails closed: the project is marked FAILED with
 * WORKSPACE_RECONCILIATION_REQUIRED and blocks further writes and runs.
 */
public final class WorkspaceOperationService {
    private static final Logger LOG = LoggerFactory.getLogger(WorkspaceOperationService.class);
    public static final String RECEIPT_PATH_PREFIX = WorkspacePathPolicy.INTERNAL_DIRECTORY + "/receipts/";

    /** Error codes that prove the agent rejected the request before any write happened. */
    private static final java.util.Set<String> DEFINITE_REJECTIONS = java.util.Set.of(
        "INVALID_PATH", "VALIDATION_ERROR", "FILE_TOO_LARGE", "BINARY_FILE", "UNSUPPORTED_ENCODING");

    private final WorkspaceStore store;
    private final WorkspaceAgent agent;

    public WorkspaceOperationService(WorkspaceStore store, WorkspaceAgent agent) {
        this.store = store;
        this.agent = agent;
    }

    /** Applies one mutation and returns the new revision. */
    public long apply(String projectId, String type, String path, String nextPath, String kind,
                      byte[] content, long expectedRevision) {
        String operationId = UUID.randomUUID().toString();
        Digests digests = computeDigests(projectId, type, path, nextPath, kind, content);
        String receiptPath = RECEIPT_PATH_PREFIX + operationId + ".json";
        String receiptJson = receiptJson(operationId, type, path, nextPath, digests.before(), digests.after());
        String receiptSha256 = sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
        WorkspaceStore.OperationRecord operation = new WorkspaceStore.OperationRecord(
            operationId, projectId, expectedRevision, digests.before(), digests.after(), receiptPath, receiptSha256);

        WorkspaceStore.BeginResult begin = store.beginPendingOperation(projectId, expectedRevision, operation);
        if (!begin.started()) {
            if (!reconcilePending(projectId)) {
                throw failClosed(projectId);
            }
            begin = store.beginPendingOperation(projectId, expectedRevision, operation);
            if (!begin.started()) {
                throw new ApiException("WORKSPACE_REVISION_CONFLICT",
                    409, "The workspace changed; reload and retry.");
            }
        }
        String phase = "MUTATE";
        try {
            WorkspaceAgent.MutationResult result = agent.mutate(projectId, new WorkspaceAgent.Command(
                type, path, nextPath == null ? "" : nextPath, kind, operationId, content,
                digests.before(), digests.after(), receiptJson, receiptSha256));
            phase = "VERIFY_RESULT";
            verifyResult(operation, result);
        } catch (WorkspaceAgentException ex) {
            if (isDefinite(ex)) {
                if (endStateHolds(projectId, type, path, nextPath, digests.after())) {
                    if (store.commitOperation(operationId, projectId, expectedRevision)) {
                        return expectedRevision + 1;
                    }
                } else {
                    store.deleteOperation(operationId);
                    throw new ApiException(browseCode(ex.code()), httpStatus(ex.code()), safeMessage(ex.code()));
                }
            }
            throw failClosed(projectId, operationId, phase, ex);
        } catch (RuntimeException ex) {
            throw failClosed(projectId, operationId, phase, ex);
        }
        if (!store.commitOperation(operationId, projectId, expectedRevision)) {
            throw failClosed(projectId, operationId, "COMMIT", null);
        }
        return expectedRevision + 1;
    }

    /**
     * Reconciles every PENDING operation against agent receipts. Returns false when a fail-closed
     * condition was recorded; callers must not create new operations for the project.
     */
    public boolean reconcilePending(String projectId) {
        List<WorkspaceStore.OperationRecord> pending = store.pendingOperations(projectId);
        if (pending.isEmpty()) return true;
        for (WorkspaceStore.OperationRecord operation : pending) {
            Optional<WorkspaceAgent.FetchedReceipt> receipt = agent.receipt(projectId, operation.id());
            if (receipt.isEmpty() || !receiptMatches(operation, receipt.get())) {
                store.markProjectFailed(projectId, "WORKSPACE_RECONCILIATION_REQUIRED");
                return false;
            }
            if (!store.commitOperation(operation.id(), projectId, operation.expectedRevision())) {
                store.markProjectFailed(projectId, "WORKSPACE_RECONCILIATION_REQUIRED");
                return false;
            }
        }
        return true;
    }

    private boolean receiptMatches(WorkspaceStore.OperationRecord operation, WorkspaceAgent.FetchedReceipt receipt) {
        return receipt.receiptSha256().equals(operation.receiptSha256())
            && receipt.operationId().equals(operation.id())
            && receipt.beforeSha256().equals(operation.beforeSha256())
            && receipt.afterSha256().equals(operation.afterSha256());
    }

    private void verifyResult(WorkspaceStore.OperationRecord operation, WorkspaceAgent.MutationResult result) {
        boolean matches = result.operationId().equals(operation.id())
            && result.beforeSha256().equals(operation.beforeSha256())
            && result.afterSha256().equals(operation.afterSha256())
            && result.receiptPath().equals(operation.receiptPath())
            && result.receiptSha256().equals(operation.receiptSha256());
        if (!matches) {
            throw new IllegalStateException("workspace receipt does not match the pending operation");
        }
    }

    private record Digests(String before, String after) { }

    /** Computes the deterministic before/after entry digests from agent-provided current state. */
    private Digests computeDigests(String projectId, String type, String path, String nextPath, String kind,
                                   byte[] content) {
        try {
            return switch (type) {
                case "SAVE" -> {
                    WorkspaceAgent.FileMeta meta = agent.meta(projectId, path);
                    yield new Digests(meta == null ? entryDigest("absent", path, null)
                            : entryDigest("file", path, meta.sha256()),
                        entryDigest("file", path, sha256Hex(content == null ? new byte[0] : content)));
                }
                case "CREATE" -> new Digests(entryDigest("absent", path, null), "file".equals(kind)
                    ? entryDigest("file", path, sha256Hex(new byte[0]))
                    : entryDigest("directory", path, null));
                case "RENAME" -> {
                    WorkspaceAgent.FileMeta meta = agent.meta(projectId, path);
                    if (meta == null) {
                        throw new WorkspaceAgentException(404, "ENTRY_NOT_FOUND", "entry does not exist");
                    }
                    if ("inode/directory".equals(meta.mediaType())) {
                        yield new Digests(entryDigest("directory", path, null), entryDigest("directory", nextPath, null));
                    }
                    yield new Digests(entryDigest("file", path, meta.sha256()), entryDigest("file", nextPath, meta.sha256()));
                }
                case "DELETE" -> {
                    WorkspaceAgent.FileMeta meta = agent.meta(projectId, path);
                    if (meta == null) {
                        throw new WorkspaceAgentException(404, "ENTRY_NOT_FOUND", "entry does not exist");
                    }
                    yield new Digests("inode/directory".equals(meta.mediaType())
                            ? entryDigest("directory", path, null) : entryDigest("file", path, meta.sha256()),
                        entryDigest("absent", path, null));
                }
                default -> throw new ApiException("VALIDATION_ERROR", 422, "Unsupported mutation");
            };
        } catch (WorkspaceAgentException ex) {
            if (isDefinite(ex)) {
                throw new ApiException(browseCode(ex.code()), httpStatus(ex.code()), safeMessage(ex.code()));
            }
            throw failClosed(projectId);
        }
    }

    private boolean endStateHolds(String projectId, String type, String path, String nextPath, String afterDigest) {
        try {
            switch (type) {
                case "SAVE", "CREATE" -> {
                    WorkspaceAgent.FileMeta meta = agent.meta(projectId, path);
                    if (meta == null) return false;
                    String digest = "inode/directory".equals(meta.mediaType())
                        ? entryDigest("directory", path, null)
                        : entryDigest("file", path, meta.sha256());
                    return digest.equals(afterDigest);
                }
                case "RENAME" -> {
                    WorkspaceAgent.FileMeta target = agent.meta(projectId, nextPath);
                    if (target == null) return false;
                    String digest = "inode/directory".equals(target.mediaType())
                        ? entryDigest("directory", nextPath, null)
                        : entryDigest("file", nextPath, target.sha256());
                    return digest.equals(afterDigest);
                }
                case "DELETE" -> {
                    agent.meta(projectId, path);
                    return false;
                }
                default -> { return false; }
            }
        } catch (WorkspaceAgentException ex) {
            return "ENTRY_NOT_FOUND".equals(ex.code()) && "DELETE".equals(type);
        }
    }

    private ApiException failClosed(String projectId) {
        return failClosed(projectId, null, "RECONCILIATION", null);
    }

    private ApiException failClosed(String projectId, String operationId, String phase, RuntimeException failure) {
        String status = "none";
        String code = "none";
        if (failure instanceof WorkspaceAgentException ex) {
            status = ex.status() >= 100 && ex.status() <= 599 ? Integer.toString(ex.status()) : "UNKNOWN";
            code = safeDiagnosticCode(ex.code());
        }
        // Never log the agent body, capability, file content, path, or arbitrary exception message.
        LOG.warn("workspace operation failed closed: projectId={} operationId={} phase={} httpStatus={} agentCode={} transportFailure={}",
            projectId, operationId == null ? "none" : operationId, phase, status, code,
            failure instanceof WorkspaceAgentException ex && ex.transportFailure() != null
                ? ex.transportFailure().name() : "none");
        store.markProjectFailed(projectId, "WORKSPACE_RECONCILIATION_REQUIRED");
        return new ApiException("PROJECT_LOCKED", 409, "Project is locked");
    }

    private String safeDiagnosticCode(String code) {
        if (code == null) return "UNKNOWN";
        return switch (code) {
            case "INVALID_PATH", "VALIDATION_ERROR", "FILE_TOO_LARGE", "BINARY_FILE", "UNSUPPORTED_ENCODING",
                 "ENTRY_NOT_FOUND", "ENTRY_ALREADY_EXISTS", "DIRECTORY_NOT_EMPTY", "IO_ERROR",
                 "CAPABILITY_REJECTED", "OPERATION_CONFLICT" -> code;
            default -> "UNKNOWN";
        };
    }

    private boolean isDefinite(WorkspaceAgentException ex) {
        return DEFINITE_REJECTIONS.contains(ex.code()) || "ENTRY_NOT_FOUND".equals(ex.code())
            || "ENTRY_ALREADY_EXISTS".equals(ex.code()) || "DIRECTORY_NOT_EMPTY".equals(ex.code());
    }

    private String browseCode(String agentCode) {
        return "SIZE_LIMIT_EXCEEDED".equals(agentCode) ? "FILE_TOO_LARGE" : agentCode;
    }

    private int httpStatus(String agentCode) {
        return switch (agentCode) {
            case "ENTRY_NOT_FOUND" -> 404;
            case "ENTRY_ALREADY_EXISTS", "DIRECTORY_NOT_EMPTY" -> 409;
            default -> 422;
        };
    }

    private String safeMessage(String agentCode) {
        return switch (agentCode) {
            case "ENTRY_NOT_FOUND" -> "Entry does not exist";
            case "ENTRY_ALREADY_EXISTS" -> "Entry already exists";
            case "DIRECTORY_NOT_EMPTY" -> "Directory is not empty";
            case "FILE_TOO_LARGE", "SIZE_LIMIT_EXCEEDED" -> "File exceeds the size limit";
            case "BINARY_FILE" -> "Binary content is not supported";
            case "UNSUPPORTED_ENCODING" -> "File encoding is not supported";
            default -> "Invalid file operation";
        };
    }

    static String receiptJson(String operationId, String type, String path, String nextPath,
                              String beforeSha256, String afterSha256) {
        return "{\"operationId\":\"" + operationId + "\",\"type\":\"" + type + "\",\"path\":\"" + path
            + "\",\"nextPath\":\"" + (nextPath == null ? "" : nextPath) + "\",\"beforeSha256\":\"" + beforeSha256
            + "\",\"afterSha256\":\"" + afterSha256 + "\"}";
    }

    public static String entryDigest(String kind, String path, String contentSha256) {
        String payload = kind + "\n" + path + (contentSha256 == null ? "" : "\n" + contentSha256);
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
