package com.manao.poc4.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.AgentTaskOccupancy;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.project.RuntimeTemplate;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Browser-facing Python dependency orchestration (design 6.1/6.2). This service owns the Python
 * request rules — owner, template, revision, run-lock, pending checks, package normalization and
 * the request digests (protocol 1 single-package, protocol 2 batch import) — and the agent
 * prepare/commit calls; {@link WorkspaceOperationService} owns the lifecycle lease, receipts,
 * durable operation state and revision. The call order is fixed: a registered operation id is
 * always answered before the current revision can misjudge a lost-response retry, and the durable
 * registration happens between prepare and commit so the agent journal alone can never apply
 * anything. The single change and the whole-batch import share this one chain.
 */
public final class PythonDependencyService {
    static final String OPERATION_KIND = "PYTHON_DEPENDENCIES";
    static final String RECONCILIATION_FAILURE = "WORKSPACE_RECONCILIATION_REQUIRED";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern ACTION = Pattern.compile("ADD|REMOVE");
    /** Post-normalization package name: lowercase alnum at both ends, hyphens inside, 1–128 chars. */
    private static final Pattern PACKAGE_NAME = Pattern.compile("[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?");
    /** Exact versions only (no ranges, no wildcard matchers). */
    private static final Pattern EXACT_VERSION = Pattern.compile("[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    /** Batch import limits: the normalized UTF-8 byte budget and the valid-requirement cap. */
    static final int MAX_BATCH_BYTES = 64 * 1024;
    static final int MAX_BATCH_REQUIREMENTS = 50;
    /** The batch digest mode field: requirements.txt import with ADD semantics only. */
    static final String BATCH_MODE = "BATCH_REQUIREMENTS";

    private final WorkspaceStore store;
    private final WorkspaceOperationService operations;
    private final WorkspaceAgent agent;
    private final ProjectLifecycleGate lifecycle;
    private final ProjectRuntimeStore runtimeStore;
    private final AgentTaskOccupancy agentTasks;

    public PythonDependencyService(WorkspaceStore store, WorkspaceOperationService operations,
                                   WorkspaceAgent agent, ProjectLifecycleGate lifecycle,
                                   ProjectRuntimeStore runtimeStore, AgentTaskOccupancy agentTasks) {
        this.store = store;
        this.operations = operations;
        this.agent = agent;
        this.lifecycle = lifecycle;
        this.runtimeStore = runtimeStore;
        this.agentTasks = agentTasks;
    }

    /** The status a browser polls: PENDING, COMMITTED (with its revision) or UNCONFIRMED. */
    public record Status(String operationId, String state, Long resultWorkspaceRevision) { }

    /** First POST: prepare and commit one dependency change under its browser-chosen identity. */
    public Status change(String ownerId, String projectId, String operationId,
                         WorkspaceAgent.DependencyChange change, String expectedRevision) {
        // Ownership is proven BEFORE the lease is touched: a non-owner never learns whether the
        // project is busy. The durable row is re-read under the lease to close the gap.
        requireOwner(ownerId, projectId);
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            requireOwner(ownerId, projectId);
            agentTasks.requireBrowserWritable(projectId);
            return changeLocked(projectId, operationId,
                parseRequest(projectId, operationId, change, expectedRevision));
        }
    }

    /**
     * First POST: prepare and commit one whole requirements.txt import (ADD semantics only) under
     * its browser-chosen identity. It enters the exact same PENDING→COMMITTED chain as the single
     * change — one operation, one receipt, one revision increment per batch.
     */
    public Status changeBatch(String ownerId, String projectId, String operationId,
                              String requirementsText, String expectedRevision) {
        requireOwner(ownerId, projectId);
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            requireOwner(ownerId, projectId);
            agentTasks.requireBrowserWritable(projectId);
            return changeLocked(projectId, operationId,
                parseBatchRequest(projectId, operationId, requirementsText, expectedRevision));
        }
    }

    /** Read-only status of one operation; only a missing record is UNCONFIRMED. */
    public Status status(String ownerId, String projectId, String operationId) {
        requireOwner(ownerId, projectId);
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            requireOwner(ownerId, projectId);
            return store.findOperation(projectId, operationId)
                .map(operation -> "COMMITTED".equals(operation.state())
                    ? committed(operation) : new Status(operation.id(), "PENDING", null))
                .orElseGet(() -> new Status(operationId, "UNCONFIRMED", null));
        }
    }

    /**
     * Drives one registered operation to its durable result. COMMITTED answers directly;
     * PENDING re-enters the same commit — never a second uv run. Nothing is re-sent for an
     * unrecorded id.
     */
    public Status reconcile(String ownerId, String projectId, String operationId) {
        requireOwner(ownerId, projectId);
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            requireOwner(ownerId, projectId);
            agentTasks.requireBrowserWritable(projectId);
            return store.findOperation(projectId, operationId)
                .map(operation -> "COMMITTED".equals(operation.state())
                    ? committed(operation) : redrive(operation))
                .orElseGet(() -> new Status(operationId, "UNCONFIRMED", null));
        }
    }

    /** The project's pending dependency operation for failure pages without a local operation id. */
    public List<Status> pending(String ownerId, String projectId) {
        requireOwner(ownerId, projectId);
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            requireOwner(ownerId, projectId);
            return store.pendingOperations(projectId).stream()
                .filter(operation -> OPERATION_KIND.equals(operation.operationKind()))
                .map(operation -> new Status(operation.id(), "PENDING", null))
                .toList();
        }
    }

    private Status changeLocked(String projectId, String operationId, Request request) {
        // A registered identity always answers first: a retry of a successful change presents
        // the old revision and must never be misjudged by the revision that has since moved.
        Optional<WorkspaceStore.OperationRecord> registered = store.findOperation(projectId, operationId);
        if (registered.isPresent()) {
            WorkspaceStore.OperationRecord operation = registered.get();
            if (!request.requestSha256().equals(operation.requestSha256())) {
                throw new ApiException("DEPENDENCY_REQUEST_MISMATCH", 409,
                    "This operation id was already used for a different request");
            }
            if ("COMMITTED".equals(operation.state())) {
                return committed(operation);
            }
            return redrive(operation);
        }
        requirePythonTemplate(projectId);
        WorkspaceStore.ProjectRecord project = store.findProject(projectId);
        if (project == null || project.workspaceRevision() != request.expectedRevision()) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "The workspace changed; reload and retry.");
        }
        if (store.hasActiveRun(projectId)) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        operations.requireNoUnresolvedOperations(projectId);

        WorkspaceAgent.PreparedPythonDependencies prepared =
            prepare(projectId, operationId, request.requestSha256(), request);
        String receiptJson = WorkspaceOperationService.dependencyReceiptJson(
            operationId, prepared.beforeSha256(), prepared.afterSha256());
        String receiptSha256 = WorkspaceOperationService.sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
        WorkspaceStore.OperationRecord operation = new WorkspaceStore.OperationRecord(operationId, projectId,
            request.expectedRevision(), prepared.beforeSha256(), prepared.afterSha256(),
            WorkspaceOperationService.RECEIPT_PATH_PREFIX + operationId + ".json", receiptSha256,
            "PENDING", OPERATION_KIND, request.requestSha256());
        operations.registerPending(projectId, request.expectedRevision(), operation);
        // Acceptance-only fault (deploy README 11.4): exactly here the durable state is
        // "PENDING + FAILED + journal present" when the canary matches — the reconcile entry
        // can then finish the registered commit. Redrive never re-enters this line.
        operations.tripDependencyPendingFaultIfArmed(projectId, operationId, request.faultLabel());
        long revision = operations.commitNewPythonDependency(operation, receiptJson, request.requestSha256());
        return new Status(operationId, "COMMITTED", revision);
    }

    /** Re-drives the same commit of a registered PENDING operation from its registered row alone. */
    private Status redrive(WorkspaceStore.OperationRecord operation) {
        requireReconcilableState(store.findProject(operation.projectId()));
        String receiptJson = WorkspaceOperationService.dependencyReceiptJson(
            operation.id(), operation.beforeSha256(), operation.afterSha256());
        long revision = operations.reconcilePythonDependency(operation, receiptJson, operation.requestSha256());
        return new Status(operation.id(), "COMMITTED", revision);
    }

    private Status committed(WorkspaceStore.OperationRecord operation) {
        return new Status(operation.id(), "COMMITTED", operation.expectedRevision() + 1);
    }

    private WorkspaceStore.ProjectRecord requireOwner(String ownerId, String projectId) {
        WorkspaceStore.ProjectRecord project = store.findProjectForOwner(ownerId, projectId);
        if (project == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        return project;
    }

    private void requirePythonTemplate(String projectId) {
        String templateId = runtimeStore.loadSpec(projectId).templateId();
        boolean python;
        try {
            python = "python".equals(RuntimeTemplate.fromId(templateId).language());
        } catch (ApiException ex) {
            python = false; // unknown or legacy snapshot templates never accept dependency changes
        }
        if (!python) {
            throw new ApiException("PYTHON_DEPENDENCY_UNSUPPORTED", 422,
                "Dependency changes are not supported for this project or package");
        }
    }

    /** Only READY, or exactly this operation's reconciliation failure, may drive a registered operation. */
    private void requireReconcilableState(WorkspaceStore.ProjectRecord project) {
        boolean reconcilable = project != null
            && ("READY".equals(project.state())
                || ("FAILED".equals(project.state()) && RECONCILIATION_FAILURE.equals(project.failureReason())));
        if (!reconcilable) {
            // A registered PENDING row exists: the refusal is not a proven pre-flight rejection.
            throw new ApiException(RECONCILIATION_FAILURE, 409,
                "Workspace needs reconciliation; the operation result is not confirmed");
        }
    }

    private WorkspaceAgent.PreparedPythonDependencies prepare(String projectId, String operationId,
                                                             String requestSha256, Request request) {
        try {
            WorkspaceAgent.PreparedPythonDependencies prepared = request.prepare(projectId, operationId, agent);
            // The prepare response is the only source of the journal digests; a foreign echo
            // must never reach the durable registration.
            if (prepared == null || !operationId.equals(prepared.operationId())
                || !requestSha256.equals(prepared.requestSha256())
                || !SHA256.matcher(orEmpty(prepared.beforeSha256())).matches()
                || !SHA256.matcher(orEmpty(prepared.afterSha256())).matches()) {
                throw new ApiException("INTERNAL_ERROR", 503, "Workspace is temporarily unavailable");
            }
            return prepared;
        } catch (WorkspaceAgentException ex) {
            throw prepareFailure(ex);
        }
    }

    /**
     * Prepare never touches the workspace sources, so every fixed agent rejection is a safe
     * correction; ambiguous transport or unknown failures answer without a durable trace. Raw
     * tool output never reaches these responses.
     */
    private static ApiException prepareFailure(WorkspaceAgentException ex) {
        return switch (ex.code()) {
            case "PYTHON_DEPENDENCY_UNSUPPORTED" -> new ApiException("PYTHON_DEPENDENCY_UNSUPPORTED", 422,
                "Dependency changes are not supported for this project or package");
            case "PYTHON_DEPENDENCY_NO_WHEEL" -> new ApiException("PYTHON_DEPENDENCY_NO_WHEEL", 422,
                "No compatible wheel is available for the requested package or version.");
            case "PYTHON_DEPENDENCY_RESOLUTION_FAILED" -> new ApiException("PYTHON_DEPENDENCY_RESOLUTION_FAILED", 503,
                "Dependency resolution failed");
            case "PYTHON_DEPENDENCY_TIMEOUT" -> new ApiException("PYTHON_DEPENDENCY_TIMEOUT", 504,
                "Dependency resolution timed out. Try again later.");
            case "DEPENDENCY_REQUEST_MISMATCH" -> new ApiException("DEPENDENCY_REQUEST_MISMATCH", 409,
                "This operation id was already used for a different request");
            case "VALIDATION_ERROR" -> new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            default -> new ApiException("INTERNAL_ERROR", 503, "Workspace is temporarily unavailable");
        };
    }

    private SingleRequest parseRequest(String projectId, String operationId, WorkspaceAgent.DependencyChange change,
                                       String expectedRevision) {
        if (!WorkspacePathPolicy.isValidOperationId(operationId)) {
            throw validation();
        }
        if (change == null || change.action() == null || !ACTION.matcher(change.action()).matches()) {
            throw validation();
        }
        if (change.packageName() == null) {
            throw validation();
        }
        String packageName = change.packageName().toLowerCase(Locale.ROOT).replaceAll("[-_.]+", "-");
        if (!PACKAGE_NAME.matcher(packageName).matches()) {
            throw validation();
        }
        String version = parseVersion(change);
        long revision = parseRevision(expectedRevision);
        return new SingleRequest(change.action(), packageName, version, revision,
            requestDigest(projectId, change.action(), packageName, version, revision));
    }

    /**
     * The batch validation split: the backend decides ONLY the line endings, the BOM, the
     * normalized UTF-8 byte size and the valid-line count — never a PEP 508 parser, the agent
     * helper owns the syntax. Blank lines and full-line comments do not count toward the cap.
     * The normalized text is BOTH the digest input and the agent payload, so a retry with the
     * same text recomputes the same digest and finds the registered row.
     */
    private BatchRequest parseBatchRequest(String projectId, String operationId, String requirementsText,
                                           String expectedRevision) {
        if (!WorkspacePathPolicy.isValidOperationId(operationId)) {
            throw validation();
        }
        if (requirementsText == null) {
            throw validation();
        }
        String normalized = requirementsText.startsWith("\uFEFF")
            ? requirementsText.substring(1) : requirementsText;
        normalized = normalized.replace("\r\n", "\n");
        if (normalized.getBytes(StandardCharsets.UTF_8).length > MAX_BATCH_BYTES) {
            throw validation();
        }
        int validLines = 0;
        String firstLine = null;
        for (String line : normalized.split("\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            validLines++;
            if (firstLine == null) {
                firstLine = trimmed;
            }
        }
        if (validLines == 0 || validLines > MAX_BATCH_REQUIREMENTS) {
            throw validation();
        }
        long revision = parseRevision(expectedRevision);
        return new BatchRequest(normalized, revision,
            batchRequestDigest(projectId, normalized, revision), firstLine);
    }

    private static String parseVersion(WorkspaceAgent.DependencyChange change) {
        String version = change.version();
        if ("REMOVE".equals(change.action())) {
            if (version != null && !version.isBlank()) {
                throw validation(); // removal is by name only
            }
            return null;
        }
        if (version == null || version.isBlank()) {
            return null; // uv resolves and writes the lock
        }
        if (!EXACT_VERSION.matcher(version).matches()) {
            throw validation();
        }
        return version;
    }

    private static long parseRevision(String expectedRevision) {
        if (expectedRevision != null) {
            try {
                long revision = Long.parseLong(expectedRevision);
                if (revision >= 0) {
                    return revision;
                }
            } catch (NumberFormatException ignored) {
                // fall through to the fixed validation error
            }
        }
        throw validation();
    }

    /**
     * The request digest is the SHA-256 of the fixed-field-order JSON over protocol 1, project,
     * action, normalized package, version and the expected revision — the same bytes for the
     * same intent, a different digest for any different request.
     */
    public static String requestDigest(String projectId, String action, String packageName, String version,
                                       long expectedRevision) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("protocol", 1);
        fields.put("projectId", projectId);
        fields.put("action", action);
        fields.put("packageName", packageName);
        fields.put("version", version);
        fields.put("expectedRevision", expectedRevision);
        try {
            return WorkspaceOperationService.sha256Hex(JSON.writeValueAsBytes(fields));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize the dependency request digest", ex);
        }
    }

    /**
     * The batch digest is the SHA-256 of the fixed-field-order JSON over protocol 2, project,
     * mode, the whole normalized requirements text and the expected revision. The separate
     * protocol version and mode field keep a batch row byte-distinguishable from any protocol 1
     * single-package row, including one bound to the same operation id.
     */
    public static String batchRequestDigest(String projectId, String requirementsText, long expectedRevision) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("protocol", 2);
        fields.put("projectId", projectId);
        fields.put("mode", BATCH_MODE);
        fields.put("requirements", requirementsText);
        fields.put("expectedRevision", expectedRevision);
        try {
            return WorkspaceOperationService.sha256Hex(JSON.writeValueAsBytes(fields));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot serialize the dependency request digest", ex);
        }
    }

    private static ApiException validation() {
        return new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** The validated, normalized request as it travels to the agent and the durable row. */
    private interface Request {
        long expectedRevision();

        String requestSha256();

        /** The equality label the acceptance-only pending fault canary matches on. */
        String faultLabel();

        /** Calls the agent's ONE prepare entry for this request's shape — never a per-line loop. */
        WorkspaceAgent.PreparedPythonDependencies prepare(String projectId, String operationId,
                                                          WorkspaceAgent agent);
    }

    /** The single-package change: one normalized ADD/REMOVE item, digest protocol 1. */
    private record SingleRequest(String action, String packageName, String version, long expectedRevision,
                                 String requestSha256) implements Request {
        @Override public String faultLabel() {
            return packageName;
        }

        @Override public WorkspaceAgent.PreparedPythonDependencies prepare(String projectId, String operationId,
                                                                          WorkspaceAgent agent) {
            return agent.prepare(projectId, operationId, requestSha256,
                new WorkspaceAgent.DependencyChange(action, packageName, version));
        }
    }

    /** The batch import: the whole normalized requirements text with ADD semantics, protocol 2. */
    private record BatchRequest(String requirementsText, long expectedRevision, String requestSha256,
                                String faultLabel) implements Request {
        @Override public WorkspaceAgent.PreparedPythonDependencies prepare(String projectId, String operationId,
                                                                          WorkspaceAgent agent) {
            return agent.prepareBatch(projectId, operationId, requestSha256, requirementsText);
        }
    }
}
