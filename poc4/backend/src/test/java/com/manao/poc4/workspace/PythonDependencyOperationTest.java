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
    private static final String PROJECT = "prj-1";
    private static final String OPERATION = "11111111-1111-4111-8111-111111111111";
    private static final String ADD_HTTPX = "2259f25f49e6efd1be44b62909b915e655a563c38aa64abc9b5e3541e87f2e9f";
    private static final String REMOVE_HTTPX = "62f272a6250a947037dd1ffd07bbc1abc94b6ac799d8e915534b94764a08ac4c";

    private WorkspaceControllerTest.FakeStore store;
    private WorkspaceControllerTest.StubAgent agent;
    private PythonDependencyService dependencies;

    @BeforeEach
    void setUp() {
        store = new WorkspaceControllerTest.FakeStore();
        // Owner validation reads the durable project row; ALICE owns the Python template project.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent = new WorkspaceControllerTest.StubAgent();
        ProjectLifecycleGate lifecycle = new ProjectLifecycleGate();
        // The fake refuses ungated hasActiveRun callers so the tests prove the dependency flow
        // runs through the SAME lease instance every other workspace consumer uses.
        store.gate = lifecycle;
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, lifecycle);
        dependencies = new PythonDependencyService(store, operations, agent, lifecycle, new ProjectRuntimeStore() {
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
        });
    }

    private ApiException assertRejected(Runnable call, String code, int status) {
        AtomicReference<ApiException> thrown = new AtomicReference<>();
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ApiException.class, thrown::set);
        assertThat(thrown.get().code()).isEqualTo(code);
        assertThat(thrown.get().status()).isEqualTo(status);
        return thrown.get();
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
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
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
        assertThat(command.receiptSha256()).isEqualTo("c".repeat(64));
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

        assertRejected(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "PROJECT_LOCKED", 409);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.deletedOperations).isEmpty();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
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
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"), "PROJECT_LOCKED", 409);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.deletedOperations).isEmpty();
        agent.commitError = null;

        // The project is already failed, so the next NEW request is refused before any row.
        agent.prepareResult = new WorkspaceAgent.PreparedPythonDependencies(second,
            PythonDependencyService.requestDigest(PROJECT, "REMOVE", "httpx", null, 7), "a".repeat(64), "b".repeat(64));
        assertRejected(() -> dependencies.change(ALICE, PROJECT, second,
            new WorkspaceAgent.DependencyChange("REMOVE", "httpx", null), "7"), "PROJECT_LOCKED", 409);
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
            "PYTHON_DEPENDENCY_RESOLUTION_FAILED", 422);
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
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
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
    void reconcileRefusesDeletingAndOtherFailuresAndKeepsTheSceneLocked() {
        String requestSha256 = PythonDependencyService.requestDigest(PROJECT, "ADD", "httpx", "0.28.1", 7);
        WorkspaceStore.OperationRecord registered = new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256);
        store.records.put(OPERATION, registered);
        store.pending.put(PROJECT, registered);

        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "DELETING", 7,
            null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
        assertRejected(() -> dependencies.reconcile(ALICE, PROJECT, OPERATION), "PROJECT_LOCKED", 409);
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);

        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 7,
            "CREATION_FAILED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
        store.failures.put(PROJECT, "CREATION_FAILED");
        assertRejected(() -> dependencies.reconcile(ALICE, PROJECT, OPERATION), "PROJECT_LOCKED", 409);
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

        Thread worker = new Thread(() -> dependencies.change(ALICE, PROJECT, OPERATION,
            new WorkspaceAgent.DependencyChange("ADD", "httpx", "0.28.1"), "7"));
        worker.start();
        insidePrepare.await();

        // Any other thread's gated work is refused while the dependency operation holds the lease.
        assertThatThrownBy(() -> store.hasActiveRun(PROJECT)).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("gate");
        release.countDown();
        worker.join();
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
            .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.deletedOperations).isEmpty();
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
}
