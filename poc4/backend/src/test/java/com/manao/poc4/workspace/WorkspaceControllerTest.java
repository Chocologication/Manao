package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

public class WorkspaceControllerTest {
    private static final String ALICE = "alice-id";
    private static final String BOB = "bob-id";
    private static final String PROJECT = "prj-1";
    private static final ObjectMapper JSON = new ObjectMapper();

    private FakeStore store;
    private StubAgent agent;
    private WorkspaceController controller;

    @BeforeEach
    void setUp() {
        store = new FakeStore();
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "READY", 7, null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent = new StubAgent();
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent);
        controller = new WorkspaceController(new WorkspaceService(store, operations, agent));
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String entryDigest(String kind, String path, String contentSha256) {
        String payload = kind + "\n" + path + (contentSha256 == null ? "" : "\n" + contentSha256);
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    private static void assertNoInternalIdentifiers(String serialized) {
        for (String forbidden : List.of("manao-ws", "manao-pvc", "manao-init", "namespace", "/workspace", "/data/",
            "kube", "container", "svc.", "cluster-local", "subPath")) {
            assertThat(serialized).doesNotContain(forbidden);
        }
    }

    private static org.springframework.security.core.Authentication auth(String userId) {
        return new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(userId, "n/a");
    }

    private String serialized(Object response) throws Exception {
        String value = JSON.writeValueAsString(response);
        assertNoInternalIdentifiers(value);
        return value;
    }

    @Nested
    class Reads {
        @Test
        void treeReturnsExactContractShape() throws Exception {
            agent.tree = new WorkspaceAgent.Tree("", List.of(
                new WorkspaceAgent.TreeEntry("src", "src", "directory", false, null, true),
                new WorkspaceAgent.TreeEntry("pom.xml", "pom.xml", "file", false, 120L, null)));
            WorkspaceController.TreeResponse response = controller.tree(auth(ALICE), PROJECT, "");
            assertThat(serialized(response)).isEqualTo("{\"directory\":\"\",\"entries\":["
                + "{\"path\":\"src\",\"name\":\"src\",\"kind\":\"directory\",\"hidden\":false,\"sizeBytes\":null,\"hasChildren\":true},"
                + "{\"path\":\"pom.xml\",\"name\":\"pom.xml\",\"kind\":\"file\",\"hidden\":false,\"sizeBytes\":120,\"hasChildren\":null}"
                + "],\"workspaceRevision\":\"7\"}");
        }

        @Test
        void metaAndContentMapAgentResponses() throws Exception {
            agent.meta = new WorkspaceAgent.FileMeta("pom.xml", "pom.xml", 120L, "application/xml", "UTF-8", "xml", "MONACO_TEXT", null, sha256Hex("x".getBytes(StandardCharsets.UTF_8)));
            agent.content = new WorkspaceAgent.Content("pom.xml", "<project/>", sha256Hex("x".getBytes(StandardCharsets.UTF_8)));
            assertThat(serialized(controller.meta(auth(ALICE), PROJECT, "pom.xml"))).contains("\"renderMode\":\"MONACO_TEXT\"");
            WorkspaceController.ContentResponse content = controller.content(auth(ALICE), PROJECT, "pom.xml");
            assertThat(JSON.writeValueAsString(content)).isEqualTo("{\"path\":\"pom.xml\",\"content\":\"<project/>\",\"workspaceRevision\":\"7\"}");
        }

        @Test
        void downloadReturnsAgentBytes() {
            agent.download = new WorkspaceAgent.Download("logo.png", "image/png", new byte[]{1, 2, 3});
            assertThat(controller.download(auth(ALICE), PROJECT, "logo.png")).isEqualTo(new byte[]{1, 2, 3});
        }

        @Test
        void unknownProjectHiddenAsNotFoundRegardlessOfOwner() {
            assertThatThrownBy(() -> controller.tree(auth(ALICE), "missing", ""))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND");
                    assertThat(ex.status()).isEqualTo(404);
                });
            store.projects.put("other", new WorkspaceStore.ProjectRecord("other", BOB, "bob", "READY", 0, null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
            assertThatThrownBy(() -> controller.tree(auth(ALICE), "other", ""))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }

        @Test
        void blockedContentMapsAgentErrorCodes() {
            agent.contentError = new WorkspaceAgentException(422, "BINARY_FILE", "binary content is not served as text");
            assertThatThrownBy(() -> controller.content(auth(ALICE), PROJECT, "logo.png"))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("BINARY_FILE");
                    assertThat(ex.status()).isEqualTo(422);
                });
        }
    }

    @Nested
    class Mutations {
        @Test
        void savePerformsTwoPhaseCommitAndReturnsMetadata() throws Exception {
            byte[] content = "class App {}".getBytes(StandardCharsets.UTF_8);
            agent.meta = new WorkspaceAgent.FileMeta("src/App.java", "App.java", 3L, "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha256Hex("old".getBytes(StandardCharsets.UTF_8)));
            agent.mutator = command -> {
                assertThat(command.type()).isEqualTo("SAVE");
                assertThat(command.content()).isEqualTo(content);
                assertThat(command.expectedBeforeSha256()).isEqualTo(entryDigest("file", "src/App.java", sha256Hex("old".getBytes(StandardCharsets.UTF_8))));
                agent.meta = new WorkspaceAgent.FileMeta("src/App.java", "App.java", (long) content.length, "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha256Hex(content));
                return new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
                    command.expectedBeforeSha256(), command.expectedAfterSha256(),
                    ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
            };

            WorkspaceController.SaveResponse response = controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("class App {}", "7"));

            assertThat(store.pending.size()).isZero();
            assertThat(store.revision.get(PROJECT)).isEqualTo(8L);
            assertThat(store.committed).hasSize(1);
            WorkspaceStore.OperationRecord operation = store.committed.get(0);
            assertThat(operation.afterSha256()).isEqualTo(entryDigest("file", "src/App.java", sha256Hex(content)));
            assertThat(operation.receiptPath()).isEqualTo(".manao/receipts/" + operation.id() + ".json");
            String json = serialized(response);
            assertThat(json).contains("\"workspaceRevision\":\"8\"");
            assertThat(json).contains("\"renderMode\":\"MONACO_TEXT\"");
            assertThat(JSON.readTree(json).get("file").size()).isEqualTo(8);
        }

        @Test
        void saveWithStaleRevisionReturnsConflictWithoutAgentWrite() {
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "6")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("WORKSPACE_REVISION_CONFLICT");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThat(agent.mutateCalls).isZero();
            assertThat(store.pending).isEmpty();
        }

        @Test
        void saveWithActiveRunReturnsProjectLocked() {
            store.activeRuns.add(PROJECT);
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThat(agent.mutateCalls).isZero();
        }

        @Test
        void saveOnNonReadyProjectReturnsProjectLocked() {
            store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "CREATING", 0, null, java.time.Instant.parse("2026-08-29T00:00:00Z")));
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "0")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
            store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, ALICE, "demo", "FAILED", 0, "CREATION_FAILED", java.time.Instant.parse("2026-08-29T00:00:00Z")));
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "0")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
        }

        @Test
        void saveRejectsOversizedAndInvalidPathsBeforeAgentCall() {
            char[] large = new char[20 * 1024 * 1024 + 1];
            Arrays.fill(large, 'a');
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "Big.java", new WorkspaceController.SaveFileRequest(new String(large), "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("FILE_TOO_LARGE"));
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "../escape", new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("INVALID_PATH"));
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java", new WorkspaceController.SaveFileRequest("x", "not-a-number")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
            assertThat(agent.mutateCalls).isZero();
        }

        @Test
        void saveWithDefiniteAgentRejectionDeletesPendingOperation() {
            agent.meta = new WorkspaceAgent.FileMeta("src/App.java", "App.java", 3L, "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha256Hex("old".getBytes(StandardCharsets.UTF_8)));
            agent.mutator = command -> {
                throw new WorkspaceAgentException(422, "INVALID_PATH", "path escapes the project directory");
            };
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java", new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("INVALID_PATH");
                    assertThat(ex.status()).isEqualTo(422);
                });
            assertThat(store.deletedOperations).hasSize(1);
            assertThat(store.pending).isEmpty();
            assertThat(store.failures).isEmpty();
        }

        @Test
        void saveWithAmbiguousAgentFailureFailsClosed() {
            agent.pendingMetaRequired = false;
            agent.mutator = command -> {
                throw new IllegalStateException("connection reset");
            };
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java", new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
            assertThat(store.pending).isNotEmpty();
        }

        @Test
        void saveWithCommitConflictFailsClosed() {
            agent.pendingMetaRequired = false;
            store.failCommits = true;
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java", new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
            assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        }

        @Test
        void saveRecoversExistingPendingOperationWithMatchingReceiptBeforeWriting() {
            String before = entryDigest("file", "src/App.java", sha256Hex("old".getBytes(StandardCharsets.UTF_8)));
            String after = entryDigest("file", "src/App.java", sha256Hex("crashed".getBytes(StandardCharsets.UTF_8)));
            WorkspaceStore.OperationRecord stuck = new WorkspaceStore.OperationRecord("stuck-op", PROJECT, 7, before, after,
                ".manao/receipts/stuck-op.json", sha256Hex(("receipt-" + "stuck-op").getBytes(StandardCharsets.UTF_8)));
            store.pending.put(PROJECT, stuck);
            agent.meta = new WorkspaceAgent.FileMeta("src/App.java", "App.java", 7L, "text/plain", "UTF-8", "java", "MONACO_TEXT", null, sha256Hex("crashed".getBytes(StandardCharsets.UTF_8)));
            agent.mutator = command -> new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
                command.expectedBeforeSha256(), command.expectedAfterSha256(),
                ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
            agent.receiptFor.put("stuck-op", new WorkspaceAgent.FetchedReceipt("stuck-op", "SAVE", "src/App.java", "",
                before, after, stuck.receiptSha256()));

            // First attempt reconciles the stuck operation; the browser revision becomes stale and gets a conflict.
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("WORKSPACE_REVISION_CONFLICT"));
            assertThat(store.committed).extracting(WorkspaceStore.OperationRecord::id).contains("stuck-op");
            assertThat(store.revision.get(PROJECT)).isEqualTo(8L);

            WorkspaceController.SaveResponse response = controller.save(auth(ALICE), PROJECT, "src/App.java",
                new WorkspaceController.SaveFileRequest("x", "8"));
            assertThat(store.revision.get(PROJECT)).isEqualTo(9L);
            assertThat(response.workspaceRevision()).isEqualTo("9");
        }

        @Test
        void saveWithMissingReceiptForPendingOperationFailsClosed() {
            agent.pendingMetaRequired = false;
            String before = entryDigest("absent", "src/App.java", null);
            String after = entryDigest("file", "src/App.java", sha256Hex("crashed".getBytes(StandardCharsets.UTF_8)));
            store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("stuck-op", PROJECT, 7, before, after,
                ".manao/receipts/stuck-op.json", "f".repeat(64)));
            assertThatThrownBy(() -> controller.save(auth(ALICE), PROJECT, "src/App.java", new WorkspaceController.SaveFileRequest("x", "7")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
            assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
            assertThat(agent.mutateCalls).isZero();
        }

        @Test
        void createRenameDeleteMapRevisionsAndAgentErrors() {
            agent.pendingMetaRequired = false;
            agent.mutator = command -> new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
                command.expectedBeforeSha256(), command.expectedAfterSha256(),
                ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
            agent.meta = new WorkspaceAgent.FileMeta("docs", "docs", null, "inode/directory", null, "", "MONACO_TEXT", null, null);
            WorkspaceController.CreateResponse created = controller.createEntry(auth(ALICE), PROJECT,
                new WorkspaceController.CreateEntryRequest("directory", "docs", "7"));
            assertThat(created.workspaceRevision()).isEqualTo("8");
            assertThat(created.entry().path()).isEqualTo("docs");

            WorkspaceController.RenameResponse renamed = controller.renameEntry(auth(ALICE), PROJECT,
                new WorkspaceController.RenameEntryRequest("docs", "notes", "8"));
            assertThat(renamed.nextPath()).isEqualTo("notes");
            assertThat(renamed.workspaceRevision()).isEqualTo("9");

            WorkspaceController.DeleteResponse deleted = controller.deleteEntry(auth(ALICE), PROJECT, "notes",
                new WorkspaceController.DeleteEntryRequest("9"));
            assertThat(deleted.workspaceRevision()).isEqualTo("10");

            agent.deleteError = new WorkspaceAgentException(409, "DIRECTORY_NOT_EMPTY", "not empty");
            assertThatThrownBy(() -> controller.deleteEntry(auth(ALICE), PROJECT, "src",
                new WorkspaceController.DeleteEntryRequest("10")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("DIRECTORY_NOT_EMPTY");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThat(store.pending).isEmpty();
        }

        @Test
        void requestsRejectUnknownFields() {
            assertThatThrownBy(() -> JSON.readValue("{\"content\":\"x\",\"expectedWorkspaceRevision\":\"1\",\"jobRef\":\"leak\"}",
                WorkspaceController.SaveFileRequest.class)).isInstanceOf(Exception.class);
            assertThatThrownBy(() -> JSON.readValue("{\"kind\":\"file\",\"path\":\"a\",\"expectedWorkspaceRevision\":\"1\",\"pod\":\"leak\"}",
                WorkspaceController.CreateEntryRequest.class)).isInstanceOf(Exception.class);
        }
    }

    public static final class FakeStore implements WorkspaceStore {
        public final Map<String, ProjectRecord> projects = new LinkedHashMap<>();
        public final Map<String, java.time.Instant> createdAt = new HashMap<>();
        public final Set<String> activeRuns = new java.util.HashSet<>();
        public final Map<String, OperationRecord> pending = new LinkedHashMap<>();
        public final List<OperationRecord> committed = new ArrayList<>();
        public final Map<String, Long> revision = new HashMap<>();
        public final Map<String, String> failures = new HashMap<>();
        public final List<String> deletedOperations = new ArrayList<>();
        public final List<String> deletedProjects = new ArrayList<>();
        public boolean failCommits;
        public List<ProjectRecord> creatingOverride;

        public FakeStore() {
            revision.put(PROJECT, 7L);
            createdAt.put(PROJECT, java.time.Instant.parse("2026-08-29T00:00:00Z"));
        }

        @Override public ProjectRecord findProjectForOwner(String ownerId, String projectId) {
            ProjectRecord project = projects.get(projectId);
            return project != null && project.ownerId().equals(ownerId) ? project : null;
        }

        @Override public ProjectRecord findProject(String projectId) { return projects.get(projectId); }

        @Override public boolean hasActiveRun(String projectId) { return activeRuns.contains(projectId); }

        @Override public BeginResult beginPendingOperation(String projectId, long expectedRevision, OperationRecord operation) {
            ProjectRecord project = projects.get(projectId);
            if (project != null && !"READY".equals(project.state()) && !"CREATING".equals(project.state())) {
                return new BeginResult(false, false, true);
            }
            if (revisionOf(projectId) != expectedRevision) return new BeginResult(false, true);
            if (pending.containsKey(projectId)) return new BeginResult(false, false);
            pending.put(projectId, operation);
            return new BeginResult(true, false);
        }

        @Override public boolean commitOperation(String operationId, String projectId, long expectedRevision) {
            if (failCommits) return false;
            ProjectRecord current = projects.get(projectId);
            if (current != null && ("DELETING".equals(current.state()) || "FAILED".equals(current.state()))) {
                return false;
            }
            OperationRecord operation = pending.remove(projectId);
            if (operation == null || !operation.id().equals(operationId) || revisionOf(projectId) != expectedRevision) return false;
            committed.add(operation);
            long updated = revisionOf(projectId) + 1;
            revision.put(projectId, updated);
            ProjectRecord project = projects.get(projectId);
            if (project != null) {
                projects.put(projectId, new ProjectRecord(project.id(), project.ownerId(), project.name(),
                    project.state(), updated, project.failureReason(), project.createdAt()));
            }
            return true;
        }

        private long revisionOf(String projectId) { return revision.getOrDefault(projectId, 0L); }

        @Override public List<OperationRecord> pendingOperations(String projectId) {
            OperationRecord operation = pending.get(projectId);
            return operation == null ? List.of() : List.of(operation);
        }

        @Override public boolean deleteProject(String ownerId, String projectId) {
            if (activeRuns.contains(projectId)) return false;
            ProjectRecord project = projects.get(projectId);
            if (project == null || !project.ownerId().equals(ownerId)) return false;
            deletedProjects.add(projectId);
            projects.remove(projectId);
            pending.remove(projectId);
            revision.remove(projectId);
            return true;
        }

        @Override public void deleteOperation(String operationId) {
            deletedOperations.add(operationId);
            pending.values().removeIf(operation -> operation.id().equals(operationId));
        }

        @Override public void markProjectFailed(String projectId, String failureReason) {
            failures.put(projectId, failureReason);
            ProjectRecord project = projects.get(projectId);
            if (project != null && java.util.Set.of("CREATING", "READY").contains(project.state())) {
                projects.put(projectId, new ProjectRecord(project.id(), project.ownerId(), project.name(), "FAILED",
                    project.workspaceRevision(), failureReason, project.createdAt()));
            }
        }

        @Override public void markProjectReady(String projectId) {
            ProjectRecord project = projects.get(projectId);
            if (project != null && "CREATING".equals(project.state())) {
                projects.put(projectId, new ProjectRecord(project.id(), project.ownerId(), project.name(), "READY",
                    project.workspaceRevision(), null, project.createdAt()));
            }
        }

        @Override public java.util.List<ProjectRecord> projectsByState(String state) {
            if (creatingOverride != null && "CREATING".equals(state)) {
                return creatingOverride;
            }
            return projects.values().stream().filter(project -> project.state().equals(state)).toList();
        }
    }

    public static final class StubAgent implements WorkspaceAgent {
        public Tree tree = new Tree("", List.of());
        public FileMeta meta;
        public Content content;
        public Download download;
        public Function<Command, MutationResult> mutator = command -> new MutationResult(command.operationId(), command.path(),
            command.expectedBeforeSha256(), command.expectedAfterSha256(),
            ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
        public final Map<String, FetchedReceipt> receiptFor = new HashMap<>();
        public WorkspaceAgentException metaError;
        public WorkspaceAgentException contentError;
        public WorkspaceAgentException deleteError;
        public int mutateCalls;
        public boolean pendingMetaRequired = true;

        @Override public Tree tree(String projectId, String directory) { return tree; }

        @Override public FileMeta meta(String projectId, String path) {
            if (metaError != null) throw metaError;
            if (meta == null && pendingMetaRequired) {
                throw new WorkspaceAgentException(404, "ENTRY_NOT_FOUND", "missing");
            }
            return meta;
        }

        @Override public Content content(String projectId, String path) {
            if (contentError != null) throw contentError;
            return content;
        }

        @Override public Download download(String projectId, String path) { return download; }

        @Override public MutationResult mutate(String projectId, Command command) {
            mutateCalls++;
            if ("DELETE".equals(command.type()) && deleteError != null) throw deleteError;
            return mutator.apply(command);
        }

        @Override public Optional<FetchedReceipt> receipt(String projectId, String operationId) {
            return Optional.ofNullable(receiptFor.get(operationId));
        }

        public void resetErrors() {
            metaError = null;
            contentError = null;
            deleteError = null;
        }
    }
}
