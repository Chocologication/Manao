package com.manao.poc4.workspace;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
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
    private final ProjectLifecycleGate lifecycle;
    /** Acceptance-only canary package name; empty (the default) can never trip the fault. */
    private final String dependencyPendingFaultPackage;

    public WorkspaceOperationService(WorkspaceStore store, WorkspaceAgent agent) {
        this(store, agent, new ProjectLifecycleGate());
    }

    public WorkspaceOperationService(WorkspaceStore store, WorkspaceAgent agent, ProjectLifecycleGate lifecycle) {
        this(store, agent, lifecycle, "");
    }

    public WorkspaceOperationService(WorkspaceStore store, WorkspaceAgent agent, ProjectLifecycleGate lifecycle,
                                     String dependencyPendingFaultPackage) {
        this.store = store;
        this.agent = agent;
        this.lifecycle = lifecycle;
        this.dependencyPendingFaultPackage = dependencyPendingFaultPackage == null
            ? "" : dependencyPendingFaultPackage.trim();
    }

    /** Applies one mutation and returns the new revision. */
    public long apply(String projectId, String type, String path, String nextPath, String kind,
                      byte[] content, long expectedRevision) {
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            return applyLocked(projectId, type, path, nextPath, kind, content, expectedRevision);
        }
    }

    private long applyLocked(String projectId, String type, String path, String nextPath, String kind,
                             byte[] content, long expectedRevision) {
        String operationId = UUID.randomUUID().toString();
        Digests digests = computeDigests(projectId, type, path, nextPath, kind, content);
        return executePendingMutation(projectId, type, path, nextPath, kind, content,
            expectedRevision, operationId, digests);
    }

    /**
     * The AI agent's file-save entry: the same two-phase SAVE protocol as {@link #apply}, under
     * the caller's pre-allocated stable operationId plus replay settlement. A replayed call must
     * never be treated as a new write — an already COMMITTED operation answers its original
     * revision without touching the agent again, and a PENDING one is settled from the agent's
     * durable receipt alone (no digest recomputation, no second mutate). For a first execution,
     * {@code expectedSha256} pins the optimistic-write contract: non-null must match the live
     * file's sha256, null must find the path absent — the agent's definite 404 for a missing
     * file is converted to the explicit absent digest HERE ONLY (the browser save keeps
     * refusing it), and the agent's SAVE then creates the file and its parent directories.
     * Deterministic rejections throw before any durable registration; ambiguity fails closed.
     * The caller must hold the project lifecycle lease (reentrant), as {@link #apply} does.
     */
    public long applyAgentSave(String projectId, String operationId, String path, byte[] content,
                               long expectedRevision, String expectedSha256) {
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            // Replay check FIRST: a registered operation must never be re-digested as a new write.
            Optional<WorkspaceStore.OperationRecord> registered = store.findOperation(projectId, operationId);
            if (registered.isPresent()) {
                return settleRegisteredAgentSave(projectId, registered.get());
            }
            Digests digests;
            try {
                digests = computeDigests(projectId, "SAVE", path, null, null, content);
            } catch (ApiException ex) {
                if (!"ENTRY_NOT_FOUND".equals(ex.code())) {
                    throw ex;
                }
                // The agent transport reports a missing file as a definite ENTRY_NOT_FOUND (HTTP
                // 404), not a null meta. Only this AI save entry converts that verified absence
                // into the explicit absent digest so first-time creation works; the browser save
                // keeps refusing it. With expectedSha256 set, the comparison below still refuses
                // (absent never equals the pinned file digest) and Pi re-reads.
                digests = new Digests(entryDigest("absent", path, null),
                    entryDigest("file", path, sha256Hex(content)));
            }
            String expectedBefore = expectedSha256 == null
                ? entryDigest("absent", path, null)
                : entryDigest("file", path, expectedSha256);
            if (!expectedBefore.equals(digests.before())) {
                throw new ApiException("FILE_SHA_CONFLICT", 409,
                    "The file changed since it was read; reload it before writing");
            }
            return executePendingMutation(projectId, "SAVE", path, null, null, content,
                expectedRevision, operationId, digests);
        }
    }

    /** Settles a replayed agent save from its durable record and the agent's receipt alone. */
    private long settleRegisteredAgentSave(String projectId, WorkspaceStore.OperationRecord operation) {
        if ("COMMITTED".equals(operation.state())) {
            return operation.expectedRevision() + 1;
        }
        // PENDING: the write may or may not have applied — only the agent receipt decides.
        Optional<WorkspaceAgent.FetchedReceipt> receipt = agent.receipt(projectId, operation.id());
        if (receipt.isEmpty() || !receiptMatches(operation, receipt.get())) {
            throw failClosed(projectId, operation.id(), "RECONCILE", null);
        }
        if (!store.commitOperation(operation.id(), projectId, operation.expectedRevision())) {
            throw failClosed(projectId, operation.id(), "COMMIT", null);
        }
        return operation.expectedRevision() + 1;
    }

    /** Shared mutation tail: register PENDING, drive the agent's atomic write, verify, commit. */
    private long executePendingMutation(String projectId, String type, String path, String nextPath, String kind,
                                        byte[] content, long expectedRevision, String operationId, Digests digests) {
        String receiptPath = RECEIPT_PATH_PREFIX + operationId + ".json";
        String receiptJson = receiptJson(operationId, type, path, nextPath, digests.before(), digests.after());
        String receiptSha256 = sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
        WorkspaceStore.OperationRecord operation = new WorkspaceStore.OperationRecord(
            operationId, projectId, expectedRevision, digests.before(), digests.after(), receiptPath, receiptSha256);

        WorkspaceStore.BeginResult begin = beginWithRecovery(projectId, expectedRevision, operation);
        if (!begin.started()) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT",
                409, "The workspace changed; reload and retry.");
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
     * Registers one operation atomically: the expected-revision and no-pending checks run under
     * the project row lock. When a PENDING operation already exists it is reconciled from its
     * agent receipt first; an unreconcilable scene fails closed and refuses the registration.
     * The caller must hold the project lifecycle lease (reentrant).
     */
    public void registerPending(String projectId, long expectedRevision, WorkspaceStore.OperationRecord operation) {
        if (!beginWithRecovery(projectId, expectedRevision, operation).started()) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT",
                409, "The workspace changed; reload and retry.");
        }
    }

    private WorkspaceStore.BeginResult beginWithRecovery(String projectId, long expectedRevision,
                                                         WorkspaceStore.OperationRecord operation) {
        WorkspaceStore.BeginResult begin = store.beginPendingOperation(projectId, expectedRevision, operation);
        if (begin.projectLocked()) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        if (!begin.started()) {
            if (!reconcilePendingLocked(projectId)) {
                throw failClosed(projectId);
            }
            begin = store.beginPendingOperation(projectId, expectedRevision, operation);
            if (begin.projectLocked()) {
                throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
            }
        }
        return begin;
    }

    /**
     * Refuses while unresolved PENDING operations exist: they are reconciled from their agent
     * receipts first, and a scene that cannot be verified fails closed. The caller must hold the
     * project lifecycle lease (reentrant).
     */
    public void requireNoUnresolvedOperations(String projectId) {
        if (store.pendingOperations(projectId).isEmpty()) return;
        if (!reconcilePendingLocked(projectId)) {
            throw failClosed(projectId);
        }
    }

    /**
     * Reconciles every PENDING operation against agent receipts. Returns false when a fail-closed
     * condition was recorded; callers must not create new operations for the project.
     */
    public boolean reconcilePending(String projectId) {
        try (var lease = lifecycle.tryAcquire(projectId).orElse(null)) {
            if (lease == null) {
                return false;
            }
            return reconcilePendingLocked(projectId);
        }
    }

    /** Task settlement observes only its original receipt, outside the project gate, then rechecks. */
    public boolean reconcileTaskOperation(String projectId,String operationId) {
        var original=store.findOperation(projectId,operationId).orElse(null);
        if(original==null || "COMMITTED".equals(original.state())) return true;
        if(!"PENDING".equals(original.state())) return false;
        var receipt=com.manao.poc4.ai.ReconcileWorkBudget.boundary(() -> agent.receipt(projectId,operationId));
        try(var lease=lifecycle.tryAcquire(projectId).orElse(null)) {
            if(lease==null) return false;
            var current=store.findOperation(projectId,operationId).orElse(null);
            if(current==null) return false;
            if("COMMITTED".equals(current.state())) return true;
            if(!original.equals(current) || receipt.isEmpty() || !receiptMatches(current,receipt.get())) return false;
            return store.commitOperation(current.id(),projectId,current.expectedRevision());
        }
    }

    private boolean reconcilePendingLocked(String projectId) {
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

    /**
     * Acceptance-only fault injection (Task 11 provisioning, deploy README 11.4): when the
     * operator armed {@code MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE} with exactly this
     * normalized request package name, the first-party dependency commit fails closed —
     * producing the production reconciliation scene (durable PENDING row, FAILED project,
     * agent journal) that the e2e FAILED-recovery case pairs with. Reusing {@link #failClosed}
     * keeps the wire answer, the project failure and the surviving row identical to a real
     * interrupted commit; callers invoke it AFTER the durable registration and BEFORE the
     * commit, and the reconcile/redrive path never calls it, so recovery always completes.
     * Empty (the deployment default) can never trip.
     */
    public void tripDependencyPendingFaultIfArmed(String projectId, String operationId, String packageName) {
        if (packageName != null && !dependencyPendingFaultPackage.isEmpty()
                && packageName.equals(dependencyPendingFaultPackage)) {
            throw failClosed(projectId, operationId, "FAULT_INJECTION", null);
        }
    }

    /**
     * Drives the FIRST agent commit of a freshly registered dependency operation and commits it
     * with the normal conditional commit; the project is READY at this point by contract.
     */
    public long commitNewPythonDependency(WorkspaceStore.OperationRecord operation, String receiptJson,
                                          String requestSha256) {
        return commitPythonDependency(operation, receiptJson, requestSha256, false);
    }

    /**
     * Re-drives the SAME commit of an already registered dependency operation (lost response,
     * restart or explicit reconcile): the registered row alone supplies identity, digests and
     * receipt, and the reconciled commit may additionally lift exactly this operation's
     * WORKSPACE_RECONCILIATION_REQUIRED failure. The agent serializes retries onto the same
     * journal, so uv is never run twice.
     */
    public long reconcilePythonDependency(WorkspaceStore.OperationRecord operation, String receiptJson,
                                          String requestSha256) {
        return commitPythonDependency(operation, receiptJson, requestSha256, true);
    }

    /** Shared dependency commit phase: agent commit → response verification → receipt verification → conditional DB commit. */
    private long commitPythonDependency(WorkspaceStore.OperationRecord operation, String receiptJson,
                                        String requestSha256, boolean reconciled) {
        String phase = "COMMIT";
        try {
            WorkspaceAgent.PreparedPythonDependencies result = agent.commit(operation.projectId(),
                new WorkspaceAgent.PythonDependencyCommit(
                    new WorkspaceAgent.PreparedPythonDependencies(operation.id(), requestSha256,
                        operation.beforeSha256(), operation.afterSha256()),
                    receiptJson, operation.receiptSha256()));
            phase = "VERIFY_RESULT";
            verifyDependencyResult(operation, result, requestSha256);
            phase = "VERIFY_RECEIPT";
            // The commit response alone is not authority: the agent's final durable receipt must
            // exist and match the registered identity and digests before the database commits.
            Optional<WorkspaceAgent.FetchedReceipt> receipt = agent.receipt(operation.projectId(), operation.id());
            if (receipt.isEmpty() || !receiptMatches(operation, receipt.get())) {
                throw new IllegalStateException("workspace receipt does not match the pending operation");
            }
        } catch (WorkspaceAgentException ex) {
            throw failClosed(operation.projectId(), operation.id(), phase, ex);
        } catch (RuntimeException ex) {
            throw failClosed(operation.projectId(), operation.id(), phase, ex);
        }
        boolean committed = reconciled
            ? store.commitReconciledOperation(operation.id(), operation.projectId(), operation.expectedRevision())
            : store.commitOperation(operation.id(), operation.projectId(), operation.expectedRevision());
        if (!committed) {
            throw failClosed(operation.projectId(), operation.id(), "COMMIT", null);
        }
        return operation.expectedRevision() + 1;
    }

    /** The commit response must echo the registered identity and digests exactly. */
    private void verifyDependencyResult(WorkspaceStore.OperationRecord operation,
                                        WorkspaceAgent.PreparedPythonDependencies result, String requestSha256) {
        boolean matches = result != null
            && operation.id().equals(result.operationId())
            && requestSha256.equals(result.requestSha256())
            && operation.beforeSha256().equals(result.beforeSha256())
            && operation.afterSha256().equals(result.afterSha256());
        if (!matches) {
            throw new IllegalStateException("dependency commit does not match the pending operation");
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
        // The operation row/journal may exist and files may already be applied: the answer names
        // the unresolved operation instead of the proven pre-flight lock.
        return new ApiException("WORKSPACE_RECONCILIATION_REQUIRED", 409,
            "Workspace needs reconciliation; the operation result is not confirmed");
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

    /** Deterministic dependency receipt: the same identity format with the fixed two-file fields. */
    static String dependencyReceiptJson(String operationId, String beforeSha256, String afterSha256) {
        return receiptJson(operationId, "PYTHON_DEPENDENCIES", "pyproject.toml", "uv.lock", beforeSha256, afterSha256);
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
