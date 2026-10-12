package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Operation semantics of the dependency service: the fixed request digest, the call order that
 * answers registered identities before the current revision can misjudge a retry, receipt
 * binding to the registered row, and the fail-closed boundaries of the commit phases.
 */
class PythonDependencyOperationTest {
    private static final String ALICE = "alice-id";
    private static final String BOB = "bob-id";
    private static final String PROJECT = "prj-1";
    private static final String OPERATION = "11111111-1111-4111-8111-111111111111";
    private static final String ADD_HTTPX = "2259f25f49e6efd1be44b62909b915e655a563c38aa64abc9b5e3541e87f2e9f";
    private static final String REMOVE_HTTPX = "62f272a6250a947037dd1ffd07bbc1abc94b6ac799d8e915534b94764a08ac4c";
    private static final String BATCH_TEXT = "httpx==0.28.1\nfastapi>=0.141.1\n";
    /** sha256 over {"protocol":2,"projectId":"prj-1","mode":"BATCH_REQUIREMENTS",
     * "requirements":"httpx==0.28.1\nfastapi>=0.141.1\n","expectedRevision":7} — the pinned
     * protocol 2 batch digest. */
    private static final String BATCH_DIGEST = "72a9ffa94d38fe3288d4c6aac005ed3f9280e27351396b8b1d225b872b64d5f2";

    private WorkspaceControllerTest.FakeStore store;
    private WorkspaceControllerTest.StubAgent agent;
    private ProjectLifecycleGate lifecycle;
    private PythonDependencyService dependencies;

    @BeforeEach
    void setUp() {
        store = new WorkspaceControllerTest.FakeStore();
        // Owner validation reads the durable project row; ALICE owns the Python template project.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent = new WorkspaceControllerTest.StubAgent();
        lifecycle = new ProjectLifecycleGate();
        // The fake refuses ungated hasActiveRun callers so the tests prove the dependency flow
        // runs through the SAME lease instance every other workspace consumer uses.
        store.gate = lifecycle;
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, lifecycle);
        dependencies = new PythonDependencyService(store, operations, agent, lifecycle, pythonRuntimeStore());
    }

    /** The Python template runtime store the owner checks read before accepting a change. */
    private static ProjectRuntimeStore pythonRuntimeStore() {
        return new ProjectRuntimeStore() {
            private final Map<String, ProjectRuntimeSpec> specs = new ConcurrentHashMap<>(Map.of(
                PROJECT, new ProjectRuntimeSpec("python-fastapi-web", false, false, List.of())));

            @Override public ProjectRuntimeSpec loadSpec(String projectId) {
                ProjectRuntimeSpec spec = specs.get(projectId);
                return spec == null ? ProjectRuntimeSpec.console() : spec;
            }

            @Override public void setEndpointState(String projectId, String state) { }

            @Override public String endpointState(String projectId) { return "NONE"; }

            @Override public List<PendingEndpoint> projectsWithUnknownEndpoint() { return List.of(); }

            @Override public void rememberStorage(String projectId, StorageBinding binding) { }

            @Override public List<StorageBinding> storageBindings(String projectId) { return List.of(); }
        };
    }

    /** The dependency stack wired with the operator-armed dependency-pending fault value. */
    private PythonDependencyService dependenciesWithArmedFault(String armedPackage) {
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, lifecycle, armedPackage);
        return new PythonDependencyService(store, operations, agent, lifecycle, pythonRuntimeStore());
    }

    private ApiException assertRejected(Runnable call, String code, int status) {
        AtomicReference<ApiException> thrown = new AtomicReference<>();
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ApiException.class, thrown::set);
        assertThat(thrown.get().code()).isEqualTo(code);
        assertThat(thrown.get().status()).isEqualTo(status);
        return thrown.get();
    }

    /** The deterministic digest a registered row must carry: sha256 over the fixed receipt JSON. */
    private static String registeredReceiptSha256(String operationId, String before, String after) {
        return WorkspaceOperationService.sha256Hex(WorkspaceOperationService.dependencyReceiptJson(
            operationId, before, after).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    @Test
    void requestDigestIsTheFixedFieldOrderJsonOfTheNormalizedRequest() {
        assertThat(PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 17))
            .isEqualTo(ADD_HTTPX);
        assertThat(PythonDependencyService.requestDigest(PROJECT, "REMOVE", "httpx", null, 17))
            .isEqualTo(REMOVE_HTTPX);
        // A different expected revision or project binds a different intent.
        assertThat(PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 18))
            .isNotEqualTo(ADD_HTTPX);
        assertThat(PythonDependencyService.requestDigest("prj-2", "ADD", "httpx", "0.28.1", 17))
            .isNotEqualTo(ADD_HTTPX);
    }

    @Test
    void packageNameIsNormalizedBeforeItReachesTheDigestAndAgent() {
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.requestDigest(PROJECT, "ADD", "a-b-c", "0.28.1", 7),
            "a".repeat(64), "b".repeat(64));
        dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "A_B.c", "0.28.1"), "7");
        assertThat(agent.preparedChanges).hasSize(1);
        assertThat(agent.preparedChanges.get(0).packageName()).isEqualTo("a-b-c");
    }

    @Test
    void committedSameIdShortCircuitsBeforeTheRevisionCanMisjudgeARetry() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "COMMITTED", "PYTHON_DEPENDENCIES", requestSha256));
        // The commit moved the revision to 8; the retrying browser still presents 7.
        store.revision.put(PROJECT, 8L);
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "READY", 8, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));

        PythonDependencyService.Status status = dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void pendingSameIdRedriveUsesTheRegisteredDigestsAndReceiptAndIncrementsOnce() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        String receiptSha256 = registeredReceiptSha256(OPERATION, "a".repeat(64), "b".repeat(64));
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", receiptSha256,
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);

        PythonDependencyService.Status status = dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isEqualTo(1);
        WorkspaceAgent.PythonDependencyCommit command = agent.commitCommands.get(0);
        assertThat(command.prepared().operationId()).isEqualTo(OPERATION);
        assertThat(command.prepared().requestSha256()).isEqualTo(requestSha256);
        assertThat(command.prepared().beforeSha256()).isEqualTo("a".repeat(64));
        assertThat(command.prepared().afterSha256()).isEqualTo("b".repeat(64));
        // The receipt is bound to the registered row, not rebuilt from the request.
        assertThat(command.receiptSha256()).isEqualTo(receiptSha256);
        assertThat(command.receiptJson()).contains(OPERATION).contains("PYTHON_DEPENDENCIES")
            .contains("pyproject.toml").contains("uv.lock").contains("a".repeat(64)).contains("b".repeat(64));
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
    }

    @Test
    void sameIdDifferentRequestIsRejectedWithoutTouchingTheAgent() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "COMMITTED", "PYTHON_DEPENDENCIES", requestSha256));

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("REMOVE", "httpx", null), "7"), "DEPENDENCY_REQUEST_MISMATCH", 409);
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
    }

    @Test
    void commitResponseMismatchFailsClosedAndNeverDeletesThePendingRow() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        agent.commitSpoofedAfter = "d".repeat(64);

        // The row is registered PENDING and the agent may have applied the files: the answer
        // names the unresolved operation, it is not a proven pre-flight lock.
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.deletedOperations).isEmpty();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
    }

    @Test
    void commitWithoutADurableReceiptFailsClosedAndNeverCommitsTheRow() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        // The agent answered the commit, but its final durable receipt is missing: the backend
        // must verify the registered receipt digest before committing any database state.
        agent.recordReceipt = false;

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        assertThat(store.deletedOperations).isEmpty();

        // Once the receipt is readable again, the same registered operation finishes by reconcile.
        agent.recordReceipt = true;
        PythonDependencyService.Status status = dependencies.reconcile(ALICE, PROJECT, OPERATION);
        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
    }

    @Test
    void unsetDependencyPendingFaultKeepsTheNormalCommitAndNeverFailsTheProject() {
        // Default-off is a deployment guarantee: an empty armed value (the property default)
        // must leave the first-party commit path exactly as it was.
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "six", null, 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService unfaulted = dependenciesWithArmedFault("");

        PythonDependencyService.Status status = unfaulted.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "six", null), "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.failures).isEmpty();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void armedDependencyPendingFaultFailsClosedAfterTheDurablePendingRegistration() {
        // The fault sits AFTER prepare + durable registration and BEFORE the commit: the
        // durable state is exactly "PENDING + FAILED + journal present", so the scene is
        // indistinguishable from a real interrupted commit and reconcile stays legal.
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "six", null, 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService faulted = dependenciesWithArmedFault("six");

        assertRejected(() -> faulted.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "six", null), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(agent.prepareCalls).isEqualTo(1);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.pendingOperations(PROJECT)).hasSize(1);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("FAILED");
        assertThat(store.projects.get(PROJECT).failureReason()).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        assertThat(store.deletedOperations).isEmpty();
    }

    @Test
    void armedDependencyPendingFaultIgnoresEveryOtherPackage() {
        // Only the exact canary package trips; a different package commits normally.
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", null, 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService faulted = dependenciesWithArmedFault("six");

        PythonDependencyService.Status status = faulted.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", null), "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(store.failures).isEmpty();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void reconcileAfterTheFaultCompletesTheRegisteredCommitAndLiftsTheFailure() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "six", null, 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService faulted = dependenciesWithArmedFault("six");
        assertRejected(() -> faulted.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "six", null), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);

        // The e2e recovery path: reconciling the SAME registered operation — even on the
        // faulted service — always completes the commit; the redrive path never trips.
        PythonDependencyService.Status status = faulted.reconcile(ALICE, PROJECT, OPERATION);

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.clearedFailures).containsExactly(PROJECT);
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        assertThat(store.projects.get(PROJECT).failureReason()).isNull();
    }

    @Test
    void nonOwnerGetsNotFoundEvenWhileTheProjectLeaseIsContended() throws Exception {
        CountDownLatch acquired = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Throwable> holderFailure = new AtomicReference<>();
        Thread holder = new Thread(() -> {
            try (var lease = lifecycle.tryAcquire(PROJECT).orElseThrow()) {
                acquired.countDown();
                if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    holderFailure.set(new AssertionError("lease holder was never released"));
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                holderFailure.set(ex);
            }
        });
        holder.start();
        assertThat(acquired.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        try {
            // Contention must never leak lock state to a non-owner: 404 before any lease check.
            assertRejected(() -> dependencies.status(BOB, PROJECT, OPERATION), "ENTRY_NOT_FOUND", 404);
            assertRejected(() -> dependencies.change(BOB, PROJECT, OPERATION,
                new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "ENTRY_NOT_FOUND", 404);
            assertRejected(() -> dependencies.pending(BOB, PROJECT), "ENTRY_NOT_FOUND", 404);
        } finally {
            release.countDown();
            holder.join(5000);
        }
        assertThat(holder.isAlive()).isFalse();
        assertThat(holderFailure.get()).isNull();
    }

    @Test
    void ambiguousCommitFailuresFailClosedWhileSafePrepareRejectionsDoNot() {
        // An ambiguous prepare-side failure can never have touched the sources: no fail-closed,
        // no row — the call order validates the project BEFORE the prepare call, so this runs
        // against the still-clean project.
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        agent.prepareError = new WorkspaceAgentException(503, "IO_ERROR", "transport died");
        String second = "22222222-2222-4222-8222-222222222222";
        assertRejected(() -> dependencies.change(ALICE, PROJECT, second,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "INTERNAL_ERROR", 503);
        assertThat(store.failures).isEmpty();
        assertThat(store.records).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        agent.prepareError = null;

        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        agent.commitError = new WorkspaceAgentException(503, "IO_ERROR", "workspace API is temporarily unavailable");
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.deletedOperations).isEmpty();
        agent.commitError = null;

        // The project is already failed, so the next NEW request is refused before any row.
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(second,
            PythonDependencyService.requestDigest(PROJECT, "REMOVE", "httpx", null, 7), "a".repeat(64), "b".repeat(64));
        assertRejected(() -> dependencies.change(ALICE, PROJECT, second,
            new WorkspaceAgent.DependencyChange("REMOVE", "httpx", null), "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(store.records).containsOnlyKeys(OPERATION);
    }

    @Test
    void prepareResolutionFailuresMapToFixedSafeCodesWithoutPendingRows() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        agent.prepareError = new WorkspaceAgentException(422, "PYTHON_DEPENDENCY_UNSUPPORTED", "raw uv stderr");
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"),
            "PYTHON_DEPENDENCY_UNSUPPORTED", 422);
        agent.prepareError = new WorkspaceAgentException(422, "PYTHON_DEPENDENCY_NO_WHEEL", "raw uv stderr");
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"),
            "PYTHON_DEPENDENCY_NO_WHEEL", 422);
        agent.prepareError = new WorkspaceAgentException(504, "PYTHON_DEPENDENCY_TIMEOUT", "raw uv stderr");
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "PYTHON_DEPENDENCY_TIMEOUT", 504);
        agent.prepareError = new WorkspaceAgentException(409, "DEPENDENCY_REQUEST_MISMATCH", "different request");
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "DEPENDENCY_REQUEST_MISMATCH", 409);
        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void registrationRevisionConflictIsASafeRejectionWithoutFailClosed() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        store.conflictOnNextBegin = true;

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "WORKSPACE_REVISION_CONFLICT", 409);
        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
    }

    @Test
    void reconcileOfACommittedOperationNeverClearsLaterFailures() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "REMOVE", "httpx", null, 6);
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 6,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "COMMITTED", "PYTHON_DEPENDENCIES", requestSha256));
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 9,
            "CREATION_FAILED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
        store.failures.put(PROJECT, "CREATION_FAILED");

        PythonDependencyService.Status status = dependencies.reconcile(ALICE, PROJECT, OPERATION);

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(7L);
        assertThat(store.failures).containsEntry(PROJECT, "CREATION_FAILED");
        assertThat(store.clearedFailures).isEmpty();
        assertThat(agent.commitCalls).isZero();
    }

    @Test
    void reconcileLiftsExactlyThisReconciliationFailureInTheReconciledCommit() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json",
            registeredReceiptSha256(OPERATION, "a".repeat(64), "b".repeat(64)),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 7,
            "WORKSPACE_RECONCILIATION_REQUIRED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
        store.failures.put(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");

        PythonDependencyService.Status status = dependencies.reconcile(ALICE, PROJECT, OPERATION);

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(store.clearedFailures).containsExactly(PROJECT);
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        assertThat(store.projects.get(PROJECT).failureReason()).isNull();
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
    }

    @Test
    void reconcileRefusesDeletingAndOtherFailuresWithTheReconciliationCode() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", null, 7);
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);

        // A registered PENDING row exists: neither scene proves the request side-effect-free,
        // so both answer the reconciliation code instead of the pre-flight lock.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "DELETING", 7,
            null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
        assertRejected(() -> dependencies.reconcile(ALICE, PROJECT, OPERATION),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);

        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 7,
            "CREATION_FAILED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
        store.failures.put(PROJECT, "CREATION_FAILED");
        assertRejected(() -> dependencies.reconcile(ALICE, PROJECT, OPERATION),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.failures).containsEntry(PROJECT, "CREATION_FAILED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void unrecordedAndForeignOperationsAnswerUnconfirmedWithoutAgentCalls() {
        PythonDependencyService.Status missing = dependencies.status(ALICE, PROJECT, OPERATION);
        assertThat(missing.state()).isEqualTo("UNCONFIRMED");
        assertThat(missing.resultWorkspaceRevision()).isNull();
        PythonDependencyService.Status reconciled = dependencies.reconcile(ALICE, PROJECT, OPERATION);
        assertThat(reconciled.state()).isEqualTo("UNCONFIRMED");
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
        assertThat(store.pending).isEmpty();
    }

    @Test
    void pendingListReturnsOnlyTheUniqueDependencyOperation() {
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "PENDING", "PYTHON_DEPENDENCIES", PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7)));
        store.pending.put(PROJECT, store.records.get(OPERATION));
        store.records.put("file-op", new WorkspaceStore.OperationRecord("file-op", PROJECT, 7,
            "d".repeat(64), "e".repeat(64), ".manao/receipts/file-op.json", "f".repeat(64), "PENDING", "FILE", null));
        // FakeStore exposes one pending row per project; the dependency filter must pick the right one.
        store.pending.put(PROJECT, store.records.get(OPERATION));

        List<PythonDependencyService.Status> pending = dependencies.pending(ALICE, PROJECT);

        assertThat(pending).hasSize(1);
        assertThat(pending.get(0).operationId()).isEqualTo(OPERATION);
        assertThat(pending.get(0).state()).isEqualTo("PENDING");
    }

    @Test
    void operationsRunThroughTheSameGateSoConcurrentWritesAreRefused() throws Exception {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        CountDownLatch insidePrepare = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, requestSha256,
            "a".repeat(64), "b".repeat(64));
        agent.prepareGate = new WorkspaceControllerTest.PrepareGate(insidePrepare, release);
        AtomicReference<Throwable> workerFailure = new AtomicReference<>();

        Thread worker = new Thread(() -> {
            try {
                dependencies.change(ALICE, PROJECT, OPERATION,
                    new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7");
            } catch (Throwable failure) {
                workerFailure.set(failure);
            }
        });
        worker.start();
        try {
            assertThat(insidePrepare.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            // Any other thread's gated work is refused while the dependency operation holds the lease.
            assertThatThrownBy(() -> store.hasActiveRun(PROJECT)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("gate");
        } finally {
            release.countDown();
            worker.join(5000);
        }
        assertThat(worker.isAlive()).isFalse();
        assertThat(workerFailure.get()).isNull();
    }

    @Test
    void fileProtocolStillCommitsSingleFileOperationsWithFileKindAndNoRequestDigest() {
        agent.pendingMetaRequired = false;
        agent.mutator = command -> new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
            command.expectedBeforeSha256(), command.expectedAfterSha256(),
            ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
        WorkspaceService workspace = new WorkspaceService(store,
            new WorkspaceOperationService(store, agent), agent);

        long revision = workspace.save(ALICE, PROJECT, "src/App.java", "class App {}", "7");

        assertThat(revision).isEqualTo(8L);
        assertThat(store.committed).hasSize(1);
        WorkspaceStore.OperationRecord operation = store.committed.get(0);
        assertThat(operation.operationKind()).isEqualTo("FILE");
        assertThat(operation.requestSha256()).isNull();
    }

    @Test
    void fileWriteEncounteringAPythonPendingOperationFailsClosedWithoutDeletingIt() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);
        agent.pendingMetaRequired = false; // the single-file digest step runs before the pending check
        WorkspaceService workspace = new WorkspaceService(store,
            new WorkspaceOperationService(store, agent), agent);

        assertThatThrownBy(() -> workspace.save(ALICE, PROJECT, "src/App.java", "class App {}", "7"))
            .isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.deletedOperations).isEmpty();
    }

    @Test
    void activeRunRejectionStaysAProvenPreFlightProjectLocked() {
        // Ruling R2 classification: the active-Run gate answers BEFORE prepare and before any
        // registration, so no operation row exists for the request and no mutation was applied —
        // it keeps the pre-flight lock code instead of the reconciliation code.
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7),
            "a".repeat(64), "b".repeat(64));
        store.activeRuns.add(PROJECT);

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "PROJECT_LOCKED", 409);
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(store.committed).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void pendingRegistrationOnANonReadyProjectRefusesBeforeAnyRow() {
        // Ruling R2 classification: a project-state refusal inside beginPendingOperation answers
        // without inserting the row (atomic refusal), and prepare never mutates the workspace
        // sources — so this pre-flight scene keeps the lock code.
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7),
            "a".repeat(64), "b".repeat(64));
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "DELETING", 7,
            null, java.time.Instant.parse("2026-08-29T00:00:00Z")));

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "PROJECT_LOCKED", 409);
        assertThat(agent.prepareCalls).isEqualTo(1);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(store.committed).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void fileWriteReconcilesAPythonPendingOperationWhoseReceiptMatches() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        String receiptSha = "c".repeat(64);
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", receiptSha,
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);
        agent.pendingMetaRequired = false; // the single-file digest step runs before the pending check
        agent.receiptFor.put(OPERATION, new WorkspaceAgent.FetchedReceipt(OPERATION, "PYTHON_DEPENDENCIES",
            "pyproject.toml", "uv.lock", "a".repeat(64), "b".repeat(64), receiptSha));
        WorkspaceService workspace = new WorkspaceService(store,
            new WorkspaceOperationService(store, agent), agent);

        assertThatThrownBy(() -> workspace.save(ALICE, PROJECT, "src/App.java", "class App {}", "7"))
            .isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("WORKSPACE_REVISION_CONFLICT"));
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void batchDigestIsThePinnedProtocol2FixedFieldOrderJson() {
        // Protocol 2 pins the whole format byte-exactly: version, mode, the full normalized
        // text and the revision in this field order. Any shape change must fail here before
        // registered rows and agent journals lose their digest.
        assertThat(PythonDependencyService.batchRequestDigest(PROJECT, BATCH_TEXT, 7)).isEqualTo(BATCH_DIGEST);
        assertThat(PythonDependencyService.batchRequestDigest(PROJECT, BATCH_TEXT, 8)).isNotEqualTo(BATCH_DIGEST);
        assertThat(PythonDependencyService.batchRequestDigest(PROJECT, "httpx==0.28.1\n", 7))
            .isNotEqualTo(BATCH_DIGEST);
        assertThat(PythonDependencyService.batchRequestDigest("prj-2", BATCH_TEXT, 7)).isNotEqualTo(BATCH_DIGEST);
        // The batch format never collides with the protocol 1 single-package digest.
        assertThat(PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7))
            .isNotEqualTo(BATCH_DIGEST);
    }

    @Test
    void batchCommitsOneOperationForTheWholeTextAndIncrementsTheRevisionExactlyOnce() {
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, BATCH_DIGEST,
            "a".repeat(64), "b".repeat(64));

        PythonDependencyService.Status status = dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
        assertThat(agent.prepareCalls).isZero(); // the per-package uv path is never entered
        assertThat(agent.preparedBatchTexts.get(0)).isEqualTo(BATCH_TEXT);
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.records.get(OPERATION).requestSha256()).isEqualTo(BATCH_DIGEST);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void batchNormalizationFeedsTheDigestAndTheAgentFromTheSameNormalizedText() {
        String messy = "\uFEFFhttpx==0.28.1\r\n# full comment\r\n\r\n   \nfastapi>=0.141.1\r\n";
        String normalized = "httpx==0.28.1\n# full comment\n\n   \nfastapi>=0.141.1\n";
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.batchRequestDigest(PROJECT, normalized, 7), "a".repeat(64), "b".repeat(64));

        dependencies.changeBatch(ALICE, PROJECT, OPERATION, messy, "7");

        // The agent receives the BOM-stripped, CRLF-normalized text with comments and blank
        // lines left intact for the helper — and the durable row digest is computed over that
        // same normalized text, so a retry recomputes the identical digest.
        assertThat(agent.preparedBatchTexts.get(0)).isEqualTo(normalized);
        assertThat(store.records.get(OPERATION).requestSha256())
            .isEqualTo(PythonDependencyService.batchRequestDigest(PROJECT, normalized, 7));
    }

    @Test
    void batchValidationRejectsOversizedOverCountedAndEmptyTexts() {
        // >64 KiB after normalization while still within the 50-line cap.
        String oversized = ("a".repeat(1400) + "==1.0\n").repeat(47);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, oversized, "7"),
            "VALIDATION_ERROR", 422);
        // >50 non-blank, non-comment requirements.
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, "pkg-1\n".repeat(51), "7"),
            "VALIDATION_ERROR", 422);
        // 0 valid lines: empty, whitespace only, comments only, or absent.
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, "", "7"),
            "VALIDATION_ERROR", 422);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, "  \n\t\n", "7"),
            "VALIDATION_ERROR", 422);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, "# only\n#comments\n", "7"),
            "VALIDATION_ERROR", 422);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, null, "7"),
            "VALIDATION_ERROR", 422);
        // Identity and revision validation keep the single-op contract.
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, "../escape", BATCH_TEXT, "7"),
            "VALIDATION_ERROR", 422);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "not-a-number"),
            "VALIDATION_ERROR", 422);
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(agent.prepareCalls).isZero();
        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void batchBoundaryOfExactly64KiBIsInsideTheBudget() {
        String boundary = "a".repeat(65535) + "\n";
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.batchRequestDigest(PROJECT, boundary, 7), "a".repeat(64), "b".repeat(64));

        PythonDependencyService.Status status = dependencies.changeBatch(ALICE, PROJECT, OPERATION, boundary, "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void batchBoundaryOfExactly50ValidLinesIsAccepted() {
        // The 50-valid-requirement cap itself must be ACCEPTED, and only non-blank,
        // non-comment lines count: surrounding comments and blank lines never push a batch
        // over the cap (the >50 rejection lives in batchValidationRejectsOversizedOverCountedAndEmptyTexts).
        String boundary = "# leading comment\n\n" + "pkg-1==1.0\n".repeat(50) + "\n# trailing comment\n";
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION,
            PythonDependencyService.batchRequestDigest(PROJECT, boundary, 7), "a".repeat(64), "b".repeat(64));

        PythonDependencyService.Status status = dependencies.changeBatch(ALICE, PROJECT, OPERATION, boundary, "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
        // The whole text travels to the agent untouched — comments and blank lines included.
        assertThat(agent.preparedBatchTexts.get(0)).isEqualTo(boundary);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void batchPrepareFailureRegistersNoOperationAndKeepsTheProjectClean() {
        agent.prepareError = new WorkspaceAgentException(504, "PYTHON_DEPENDENCY_TIMEOUT", "raw uv stderr");

        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7"),
            "PYTHON_DEPENDENCY_TIMEOUT", 504);

        assertThat(store.records).isEmpty();
        assertThat(store.pending).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        agent.prepareError = null;
    }

    @Test
    void batchLostResponseRecoveryRedrivesTheRegisteredCommitWithoutSecondPrepare() {
        String receiptSha256 = registeredReceiptSha256(OPERATION, "a".repeat(64), "b".repeat(64));
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", receiptSha256,
            "PENDING", "PYTHON_DEPENDENCIES", BATCH_DIGEST);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);

        // The re-POST with the same id + same text answers from the registered row: no second
        // uv run, the revision moves exactly once.
        PythonDependencyService.Status status = dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7");
        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");

        // The explicit reconcile answers the same durable row without re-driving anything.
        PythonDependencyService.Status reconciled = dependencies.reconcile(ALICE, PROJECT, OPERATION);
        assertThat(reconciled.state()).isEqualTo("COMMITTED");
        assertThat(reconciled.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void batchSameIdWithDifferentRequirementsTextIsRejectedWithoutTouchingTheAgent() {
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "COMMITTED", "PYTHON_DEPENDENCIES", BATCH_DIGEST));

        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION,
            "httpx==0.28.1\nfastapi>=0.141.1\n# a different tail\n", "7"), "DEPENDENCY_REQUEST_MISMATCH", 409);
        // A protocol 1 single-package request can never match a batch row either.
        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "DEPENDENCY_REQUEST_MISMATCH", 409);
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
    }

    @Test
    void batchRefusesWhileRunningRevisionStaleOrWithUnresolvedOperations() {
        // The active-Run gate is a proven pre-flight refusal: no prepare, no row.
        store.activeRuns.add(PROJECT);
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7"),
            "PROJECT_LOCKED", 409);
        assertThat(agent.prepareBatchCalls).isZero();
        store.activeRuns.clear();

        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "6"),
            "WORKSPACE_REVISION_CONFLICT", 409);
        assertThat(agent.prepareBatchCalls).isZero();

        // An unreconcilable stuck operation blocks new batch work without preparing.
        store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("stuck", PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/stuck.json", "c".repeat(64), "PENDING", "FILE", null));
        assertRejected(() -> dependencies.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        // No batch row was registered; the stuck FILE operation is still the only pending one.
        assertThat(store.pending.get(PROJECT).id()).isEqualTo("stuck");
        assertThat(store.records).isEmpty();
    }

    @Test
    void armedDependencyPendingFaultTripsOnTheBatchFirstRequirementLine() {
        // The canary label for a batch is the first normalized requirement line, matched by
        // equality — the same single trip point AFTER the durable registration.
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, BATCH_DIGEST,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService faulted = dependenciesWithArmedFault("httpx==0.28.1");

        assertRejected(() -> faulted.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7"),
            "WORKSPACE_RECONCILIATION_REQUIRED", 409);
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.pendingOperations(PROJECT)).hasSize(1);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("FAILED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        assertThat(store.deletedOperations).isEmpty();

        // The reconcile path never re-trips and completes the registered batch commit.
        PythonDependencyService.Status status = faulted.reconcile(ALICE, PROJECT, OPERATION);
        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(status.resultWorkspaceRevision()).isEqualTo(8L);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
    }

    @Test
    void batchFaultIgnoresCanariesThatDoNotMatchTheFirstRequirementLine() {
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(OPERATION, BATCH_DIGEST,
            "a".repeat(64), "b".repeat(64));
        PythonDependencyService faulted = dependenciesWithArmedFault("fastapi>=0.141.1");

        PythonDependencyService.Status status = faulted.changeBatch(ALICE, PROJECT, OPERATION, BATCH_TEXT, "7");

        assertThat(status.state()).isEqualTo("COMMITTED");
        assertThat(store.failures).isEmpty();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("COMMITTED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }
}
