package com.manao.poc4.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
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
 * the request digest — and the agent prepare/commit calls; {@link WorkspaceOperationService}
 * owns the lifecycle lease, receipts, durable operation state and revision. The call order is
 * fixed: a registered operation id is always answered before the current revision can misjudge
 * a lost-response retry, and the durable registration happens between prepare and commit so the
 * agent journal alone can never apply anything.
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

    private final WorkspaceStore store;
    private final WorkspaceOperationService operations;
    private final WorkspaceAgent agent;
    private final ProjectLifecycleGate lifecycle;
    private final ProjectRuntimeStore runtimeStore;

    public PythonDependencyService(WorkspaceStore store, WorkspaceOperationService operations,
                                   WorkspaceAgent agent, ProjectLifecycleGate lifecycle,
                                   ProjectRuntimeStore runtimeStore) {
        this.store = store;
        this.operations = operations;
        this.agent = agent;
        this.lifecycle = lifecycle;
        this.runtimeStore = runtimeStore;
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
            return changeLocked(projectId, operationId, change, expectedRevision);
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

    private Status changeLocked(String projectId, String operationId,
                                WorkspaceAgent.DependencyChange change, String expectedRevision) {
        Request request = parseRequest(projectId, operationId, change, expectedRevision);
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
            prepare(projectId, operationId, request.requestSha256(), request.change());
        String receiptJson = WorkspaceOperationService.dependencyReceiptJson(
            operationId, prepared.beforeSha256(), prepared.afterSha256());
        String receiptSha256 = WorkspaceOperationService.sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
        WorkspaceStore.OperationRecord operation = new WorkspaceStore.OperationRecord(operationId, projectId,
            request.expectedRevision(), prepared.beforeSha256(), prepared.afterSha256(),
            WorkspaceOperationService.RECEIPT_PATH_PREFIX + operationId + ".json", receiptSha256,
            "PENDING", OPERATION_KIND, request.requestSha256());
        operations.registerPending(projectId, request.expectedRevision(), operation);
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
                                                             String requestSha256,
                                                             WorkspaceAgent.DependencyChange change) {
        try {
            WorkspaceAgent.PreparedPythonDependencies prepared =
                agent.prepare(projectId, operationId, requestSha256, change);
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
            case "PYTHON_DEPENDENCY_NO_WHEEL" -> new ApiException("PYTHON_DEPENDENCY_RESOLUTION_FAILED", 422,
                "Dependency resolution failed");
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

    private Request parseRequest(String projectId, String operationId, WorkspaceAgent.DependencyChange change,
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
        return new Request(change.action(), packageName, version, revision,
            requestDigest(projectId, change.action(), packageName, version, revision));
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

    private static ApiException validation() {
        return new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** The validated, normalized request as it travels to the agent and the durable row. */
    private record Request(String action, String packageName, String version, long expectedRevision,
                           String requestSha256) {
        WorkspaceAgent.DependencyChange change() {
            return new WorkspaceAgent.DependencyChange(action, packageName, version);
        }
    }
}
