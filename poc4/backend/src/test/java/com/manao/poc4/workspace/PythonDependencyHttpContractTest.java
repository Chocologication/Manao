package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * HTTP contract of the browser dependency endpoints: owner scoping, fixed error codes, the
 * PENDING/COMMITTED/UNCONFIRMED status semantics and lost-response recovery never re-run uv.
 */
class PythonDependencyHttpContractTest {
    private static final String ALICE = "alice-id";
    private static final String BOB = "bob-id";
    private static final String PROJECT = "prj-1";
    private static final String OPERATION = "11111111-1111-4111-8111-111111111111";
    private static final String BATCH_TEXT = "httpx==0.28.1\nfastapi>=0.141.1\n";
    /** The pinned protocol 2 batch digest over BATCH_TEXT for prj-1 at expected revision 7. */
    private static final String BATCH_DIGEST = "72a9ffa94d38fe3288d4c6aac005ed3f9280e27351396b8b1d225b872b64d5f2";

    private WorkspaceControllerTest.FakeStore store;
    private WorkspaceControllerTest.StubAgent agent;
    private MockMvc http;

    @BeforeEach
    void setUp() {
        store = new WorkspaceControllerTest.FakeStore();
        // Owner validation reads the durable project row; ALICE owns the Python template project.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent = new WorkspaceControllerTest.StubAgent();
        ProjectLifecycleGate lifecycle = new ProjectLifecycleGate();
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, lifecycle);
        PythonDependencyService dependencies = new PythonDependencyService(store, operations, agent,
            lifecycle, runtimeStore(Map.of(PROJECT, "python-fastapi-web", "prj-java", "java-spring-boot-web")),
            WorkspaceControllerTest.NO_AGENT_TASKS);
        http = MockMvcBuilders.standaloneSetup(new PythonDependencyController(dependencies))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    private static ProjectRuntimeStore runtimeStore(Map<String, String> templates) {
        return new ProjectRuntimeStore() {
            private final Map<String, ProjectRuntimeSpec> specs = new ConcurrentHashMap<>();
            {
                templates.forEach((projectId, templateId) -> specs.put(projectId,
                    new ProjectRuntimeSpec(templateId, false, false, List.of())));
            }

            @Override public ProjectRuntimeSpec loadSpec(String projectId) {
                ProjectRuntimeSpec spec = specs.get(projectId);
                return spec == null ? ProjectRuntimeSpec.console() : spec;
            }

            @Override public void setEndpointState(String projectId, String state) { }

            @Override public String endpointState(String projectId) { return "NONE"; }

            @Override public java.util.List<PendingEndpoint> projectsWithUnknownEndpoint() { return List.of(); }

            @Override public void rememberStorage(String projectId, StorageBinding binding) { }

            @Override public java.util.List<StorageBinding> storageBindings(String projectId) { return List.of(); }
        };
    }

    private String batchBody(String operationId, String requirementsText, String expectedRevision) {
        return "{\"operationId\":\"" + operationId + "\",\"requirementsText\":" + json(requirementsText)
            + ",\"expectedWorkspaceRevision\":\"" + expectedRevision + "\"}";
    }

    /** Minimal JSON string escaping for the requirements text in hand-built bodies. */
    private static String json(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private String changeBody(String operationId, String action, String packageName, String version,
                              String expectedRevision) {
        return "{\"operationId\":\"" + operationId + "\",\"action\":\"" + action + "\",\"packageName\":\""
            + packageName + "\",\"version\":" + (version == null ? "null" : "\"" + version + "\"")
            + ",\"expectedWorkspaceRevision\":\"" + expectedRevision + "\"}";
    }

    private String digest(String action, String packageName, String version, long expectedRevision) {
        return PythonDependencyService.requestDigest(PROJECT, action, packageName, version, expectedRevision);
    }

    /** The deterministic digest a registered row must carry: sha256 over the fixed receipt JSON. */
    private static String registeredReceiptSha256(String operationId, String before, String after) {
        return WorkspaceOperationService.sha256Hex(WorkspaceOperationService.dependencyReceiptJson(
            operationId, before, after).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private WorkspaceAgent.PreparedPythonDependencies prepared(String operationId, String requestSha256) {
        return new WorkspaceAgent.PreparedPythonDependencies(operationId, requestSha256,
            "a".repeat(64), "b".repeat(64));
    }

    @Test
    void changeCommitsAndAnswersLostResponsesWithTheSameCommittedOperation() throws Exception {
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.operationId").value(OPERATION))
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(agent.prepareCalls).isEqualTo(1);

        // Lost success response: the same ID and request answers COMMITTED without a second uv.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(agent.prepareCalls).isEqualTo(1);
        assertThat(agent.commitCalls).isEqualTo(1);

        // The status endpoint reads the same durable COMMITTED row.
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION)
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.operationId").value(OPERATION))
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
    }

    @Test
    void armedPendingFaultAnswersTheReconciliationCodeOnTheWireWithThePendingRowIntact() throws Exception {
        // Operator-armed acceptance fault (deploy README 11.4): the canary ADD resolves
        // through real prepare, registers the PENDING row, then answers the SAME fail-closed
        // error a real interrupted commit produces — never a 2xx.
        String canary = "six";
        agent.prepareResult = prepared(OPERATION, digest("ADD", canary, null, 7));
        ProjectLifecycleGate lifecycle = new ProjectLifecycleGate();
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, lifecycle, canary);
        PythonDependencyService dependencies = new PythonDependencyService(store, operations, agent,
            lifecycle, runtimeStore(Map.of(PROJECT, "python-fastapi-web")),
            WorkspaceControllerTest.NO_AGENT_TASKS);
        MockMvc faultedHttp = MockMvcBuilders.standaloneSetup(new PythonDependencyController(dependencies))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();

        faultedHttp.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", canary, null, "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(agent.commitCalls).isZero();
        assertThat(store.pendingOperations(PROJECT)).hasSize(1);
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("FAILED");
        assertThat(store.projects.get(PROJECT).failureReason()).isEqualTo("WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
    }

    @Test
    void nonOwnerIsHiddenAsNotFoundAndNeverPrepares() throws Exception {
        store.projects.put("prj-java", new WorkspaceStore.ProjectRecord("prj-java", ALICE, "java", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(BOB, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("ENTRY_NOT_FOUND"));
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION)
                .principal(new UsernamePasswordAuthenticationToken(BOB, "n/a")))
            .andExpect(status().isNotFound());
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/pending")
                .principal(new UsernamePasswordAuthenticationToken(BOB, "n/a")))
            .andExpect(status().isNotFound());
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
    }

    @Test
    void javaProjectsAreRejectedAsUnsupportedWithoutPreparing() throws Exception {
        store.projects.put("prj-java", new WorkspaceStore.ProjectRecord("prj-java", ALICE, "java", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        http.perform(post("/api/v1/projects/prj-java/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("PYTHON_DEPENDENCY_UNSUPPORTED"));
        assertThat(agent.prepareCalls).isZero();
        assertThat(store.pending).isEmpty();
    }

    @Test
    void injectedOrMalformedInputIsRejectedWithoutAgentCalls() throws Exception {
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        String[] bodies = {
            changeBody(OPERATION, "ADD", "../httpx", "0.28.1", "7"),
            changeBody(OPERATION, "ADD", "httpx; rm -rf /", "0.28.1", "7"),
            changeBody(OPERATION, "ADD", "A".repeat(129), "0.28.1", "7"),
            changeBody(OPERATION, "ADD", "-httpx", "0.28.1", "7"),
            changeBody(OPERATION, "DELETE", "httpx", null, "7"),
            changeBody(OPERATION, "REMOVE", "httpx", "0.28.1", "7"),
            changeBody(OPERATION, "ADD", "httpx", ">=1.0", "7"),
            changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7").replace(OPERATION, "../escape"),
            changeBody(OPERATION, "ADD", "httpx", "0.28.1", "not-a-number"),
        };
        for (String body : bodies) {
            http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                    .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        assertThat(agent.prepareCalls).isZero();
        assertThat(store.pending).isEmpty();
        assertThat(store.records).isEmpty();
    }

    @Test
    void runRevisionAndPendingConflictsRefuseBeforePrepare() throws Exception {
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        // The active-Run gate is a proven pre-flight refusal: no row was registered for the
        // request and nothing was applied, so the wire keeps PROJECT_LOCKED.
        store.activeRuns.add(PROJECT);
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROJECT_LOCKED"));
        assertThat(agent.prepareCalls).isZero();
        store.activeRuns.clear();

        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "6")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_REVISION_CONFLICT"));
        assertThat(agent.prepareCalls).isZero();

        // An unreconcilable stuck operation blocks new dependency work without preparing: the
        // registered row may already carry applied files, so the wire names the unresolved
        // operation instead of the pre-flight lock.
        store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("stuck", PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/stuck.json", "c".repeat(64), "PENDING", "FILE", null));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(agent.prepareCalls).isZero();
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
    }

    @Test
    void reconciliationRefusalsOfRegisteredOperationsAnswerTheReconciliationCodeOnTheWire() throws Exception {
        String requestSha256 = digest("ADD", "httpx", "0.28.1", 7);
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json",
            registeredReceiptSha256(OPERATION, "a".repeat(64), "b".repeat(64)),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256));
        store.pending.put(PROJECT, store.records.get(OPERATION));

        // A DELETING project cannot drive its registered PENDING operation: the row exists, so
        // the answer is the reconciliation code, not the pre-flight lock.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "DELETING", 7,
            null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");

        // The same refusal for a project failed for an unrelated reason.
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 7,
            "CREATION_FAILED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(agent.commitCalls).isZero();
        assertThat(store.records.get(OPERATION).state()).isEqualTo("PENDING");
    }

    @Test
    void sameIdDifferentRequestReturnsMismatchWithoutSecondPrepare() throws Exception {
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isOk());
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "REMOVE", "httpx", null, "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("DEPENDENCY_REQUEST_MISMATCH"));
        assertThat(agent.prepareCalls).isEqualTo(1);
    }

    @Test
    void pendingOperationLosesItsCommitResponseAndIsFinishedByTheSameCommit() throws Exception {
        String requestSha256 = digest("ADD", "httpx", "0.28.1", 7);
        // Crash simulation: the operation was registered PENDING and the commit response was lost.
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json",
            registeredReceiptSha256(OPERATION, "a".repeat(64), "b".repeat(64)),
            "PENDING", "PYTHON_DEPENDENCIES", requestSha256));
        store.pending.put(PROJECT, store.records.get(OPERATION));

        // The re-POST must not prepare again (no second uv) and must increment the revision once.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);

        // A second reconcile answers from the durable row instead of re-driving the commit.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(agent.commitCalls).isEqualTo(1);
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
    }

    @Test
    void reconcileAnswersCommittedOperationsDirectly() throws Exception {
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 6,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "COMMITTED", "PYTHON_DEPENDENCIES", digest("REMOVE", "httpx", null, 6)));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("7"));
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
    }

    @Test
    void unrecordedOperationsAnswerUnconfirmedWithoutResending() throws Exception {
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION)
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.operationId").value(OPERATION))
            .andExpect(jsonPath("$.state").value("UNCONFIRMED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").doesNotExist());
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("UNCONFIRMED"));
        assertThat(agent.prepareCalls).isZero();
        assertThat(agent.commitCalls).isZero();
        assertThat(store.pending).isEmpty();
    }

    @Test
    void pendingListReturnsOnlyThisProjectsDependencyOperation() throws Exception {
        store.records.put(OPERATION, new WorkspaceStore.OperationRecord(OPERATION, PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + OPERATION + ".json", "c".repeat(64),
            "PENDING", "PYTHON_DEPENDENCIES", digest("ADD", "httpx", "0.28.1", 7)));
        store.pending.put(PROJECT, store.records.get(OPERATION));
        // A pending single-file operation is a different kind and must not be listed.
        store.records.put("file-op", new WorkspaceStore.OperationRecord("file-op", PROJECT, 7,
            "d".repeat(64), "e".repeat(64), ".manao/receipts/file-op.json", "f".repeat(64), "PENDING", "FILE", null));

        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/pending")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.operations.length()").value(1))
            .andExpect(jsonPath("$.operations[0].operationId").value(OPERATION))
            .andExpect(jsonPath("$.operations[0].state").value("PENDING"));
    }

    @Test
    void twoTabsReconcileOnlyTheirOwnOperationIds() throws Exception {
        String other = "22222222-2222-4222-8222-222222222222";
        agent.prepareResult = prepared(OPERATION, digest("ADD", "httpx", "0.28.1", 7));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(changeBody(OPERATION, "ADD", "httpx", "0.28.1", "7")))
            .andExpect(status().isOk());

        // Tab two registers its own operation and loses the commit response.
        store.records.put(other, new WorkspaceStore.OperationRecord(other, PROJECT, 8,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/" + other + ".json",
            registeredReceiptSha256(other, "a".repeat(64), "b".repeat(64)),
            "PENDING", "PYTHON_DEPENDENCIES", digest("REMOVE", "httpx", null, 8)));
        store.pending.put(PROJECT, store.records.get(other));

        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION)
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"));
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + other)
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("PENDING"));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + other + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("9"));
        assertThat(agent.commitCalls).isEqualTo(2);
        assertThat(agent.commitCommands.get(1).prepared().operationId()).isEqualTo(other);
        assertThat(store.revision.get(PROJECT)).isEqualTo(9L);
    }

    @Test
    void changeRequestRecordDeserializationRejectsUnknownFields() {
        // Scope: the REQUEST RECORD's deserialization contract only — the plain Jackson mapper
        // (which rejects unknown fields by default) against the strict
        // @JsonIgnoreProperties(ignoreUnknown = false) record. The HTTP surface itself is
        // deliberately NOT asserted here: probed 2026-10-11 through the real MockMvc converter,
        // an unknown field is silently IGNORED (the request crossed deserialization and failed
        // later for an unrelated reason), so no wire-level 422 exists to pin.
        String body = "{\"operationId\":\"" + OPERATION + "\",\"action\":\"ADD\",\"packageName\":\"httpx\","
            + "\"version\":\"0.28.1\",\"expectedWorkspaceRevision\":\"7\",\"uvCommand\":\"leak\"}";
        assertThatThrownBy(() -> new ObjectMapper().readValue(body, PythonDependencyController.ChangeRequest.class))
            .isInstanceOf(java.io.IOException.class);
    }

    @Test
    void batchCommitsAndAnswersLostResponsesWithTheSameCommittedOperation() throws Exception {
        agent.prepareResult = prepared(OPERATION, BATCH_DIGEST);
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.operationId").value(OPERATION))
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
        assertThat(agent.prepareCalls).isZero();

        // Lost success response: the same id and text answers COMMITTED without a second uv.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
        assertThat(agent.commitCalls).isEqualTo(1);

        // The status and reconcile endpoints read the same durable row.
        http.perform(get("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION)
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/" + OPERATION + "/reconcile")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("COMMITTED"))
            .andExpect(jsonPath("$.resultWorkspaceRevision").value("8"));
        assertThat(agent.commitCalls).isEqualTo(1);
    }

    @Test
    void batchMalformedInputIsRejectedWithTheSingleOpValidationSemantics() throws Exception {
        String[] texts = {
            "",
            "# only comments\n",
            "  \n\t\n",
            "pkg-1\n".repeat(51),
            ("a".repeat(1400) + "==1.0\n").repeat(47),
        };
        for (String text : texts) {
            http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                    .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(batchBody(OPERATION, text, "7")))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        // Identity and revision validation keep the single-op contract.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody("../escape", BATCH_TEXT, "7")))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "not-a-number")))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        // Ownership still precedes every other answer.
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(BOB, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("ENTRY_NOT_FOUND"));
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(store.pending).isEmpty();
        assertThat(store.records).isEmpty();
    }

    @Test
    void batchRunRevisionAndPendingConflictsRefuseBeforePrepare() throws Exception {
        store.activeRuns.add(PROJECT);
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROJECT_LOCKED"));
        assertThat(agent.prepareBatchCalls).isZero();
        store.activeRuns.clear();

        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "6")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_REVISION_CONFLICT"));
        assertThat(agent.prepareBatchCalls).isZero();

        store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("stuck", PROJECT, 7,
            "a".repeat(64), "b".repeat(64), ".manao/receipts/stuck.json", "c".repeat(64), "PENDING", "FILE", null));
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("WORKSPACE_RECONCILIATION_REQUIRED"));
        assertThat(agent.prepareBatchCalls).isZero();
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
    }

    @Test
    void batchSameIdDifferentTextReturnsMismatchWithoutSecondPrepare() throws Exception {
        agent.prepareResult = prepared(OPERATION, BATCH_DIGEST);
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isOk());
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT + "# a different tail\n", "7")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("DEPENDENCY_REQUEST_MISMATCH"));
        assertThat(agent.prepareBatchCalls).isEqualTo(1);
    }

    @Test
    void batchErrorsCarryTheSameFixedCodesAndStatusesAsTheSingleOp() throws Exception {
        // Non-Python templates answer the unsupported code before any prepare.
        store.projects.put("prj-java", new WorkspaceStore.ProjectRecord("prj-java", ALICE, "java", "READY", 7, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        http.perform(post("/api/v1/projects/prj-java/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("PYTHON_DEPENDENCY_UNSUPPORTED"));
        assertThat(agent.prepareBatchCalls).isZero();

        // Fixed agent rejections pass through with their status: timeout 504, no wheel 422.
        agent.prepareError = new WorkspaceAgentException(504, "PYTHON_DEPENDENCY_TIMEOUT", "raw uv stderr");
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().is(504))
            .andExpect(jsonPath("$.code").value("PYTHON_DEPENDENCY_TIMEOUT"));
        agent.prepareError = new WorkspaceAgentException(422, "PYTHON_DEPENDENCY_NO_WHEEL", "raw uv stderr");
        http.perform(post("/api/v1/projects/" + PROJECT + "/python-dependencies/batch")
                .principal(new UsernamePasswordAuthenticationToken(ALICE, "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody(OPERATION, BATCH_TEXT, "7")))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("PYTHON_DEPENDENCY_NO_WHEEL"));
        assertThat(store.pending).isEmpty();
        assertThat(store.records).isEmpty();
        assertThat(store.failures).isEmpty();
        agent.prepareError = null;
    }

    @Test
    void batchRequestRecordDeserializationRejectsUnknownFields() {
        // Scope: the BATCH REQUEST RECORD's deserialization contract only — same boundary as
        // the single-op record test above (the real converter ignores unknown fields; probed
        // 2026-10-11).
        String body = "{\"operationId\":\"" + OPERATION + "\",\"requirementsText\":\"httpx==0.28.1\\n\","
            + "\"expectedWorkspaceRevision\":\"7\",\"uvCommand\":\"leak\"}";
        assertThatThrownBy(() -> new ObjectMapper().readValue(body, PythonDependencyController.BatchRequest.class))
            .isInstanceOf(java.io.IOException.class);
    }
}
