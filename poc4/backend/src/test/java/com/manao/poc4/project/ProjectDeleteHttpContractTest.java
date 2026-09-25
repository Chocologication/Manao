package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.kubernetes.ProjectResourceCleanupException;
import com.manao.poc4.kubernetes.ProjectResourceCleaner;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceStore;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class ProjectDeleteHttpContractTest {
    private FakeStore store;
    private FakeKubernetesGateway gateway;
    private RecordingRuntime runtime;
    private ScriptedDeletion deletions;

    @BeforeEach
    void setUp() {
        store = new FakeStore();
        gateway = new FakeKubernetesGateway();
        runtime = new RecordingRuntime();
        deletions = new ScriptedDeletion();
        store.projects.put("p1", new WorkspaceStore.ProjectRecord("p1", "owner-a", "demo", "READY", 0, null,
            Instant.parse("2026-09-10T00:00:00Z")));
    }

    @Test
    void activeRunIsConflictNotNotFound() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.ACTIVE_RUN;
        String body = mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("RUN_ALREADY_ACTIVE"))
            .andExpect(jsonPath("$.message").value("A run is already active"))
            .andReturn().getResponse().getContentAsString();
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = new ObjectMapper().readValue(body, Map.class);
        assertThat(parsed).containsOnlyKeys("code", "message", "traceId");
        assertThat(body).doesNotContain("kubeconfig", "token", "manao-stage6");
        assertThat(gateway.deletedProjects).isEmpty();
        assertThat(runtime.closed).isEmpty();
        assertThat(store.projects).containsKey("p1");
    }

    @Test
    void creatingIsConflictWithoutSideEffects() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.CREATING;
        store.projects.put("p1", new WorkspaceStore.ProjectRecord("p1", "owner-a", "demo", "CREATING", 0, null,
            Instant.parse("2026-09-10T00:00:00Z")));
        mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROJECT_CREATING"))
            .andExpect(jsonPath("$.message").value("Project is still being created"));
        assertThat(store.projects.get("p1").state()).isEqualTo("CREATING");
        assertThat(gateway.deletedProjects).isEmpty();
        assertThat(runtime.closed).isEmpty();
    }

    @Test
    void pendingReadyIsBusyWithoutSideEffects() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.BUSY;
        mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PROJECT_BUSY"))
            .andExpect(jsonPath("$.message").value("Project is busy"));
        assertThat(store.projects).containsKey("p1");
        assertThat(gateway.deletedProjects).isEmpty();
    }

    @Test
    void missingOwnerIsNotFoundWithNoSideEffects() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.STARTED;
        mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-b", "unused")))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("ENTRY_NOT_FOUND"));
        assertThat(gateway.deletedProjects).isEmpty();
        assertThat(store.projects).containsKey("p1");
    }

    @Test
    void successfulDeleteReturnsNoContent() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.STARTED;
        store.projects.put("p1", new WorkspaceStore.ProjectRecord("p1", "owner-a", "demo", "DELETING", 0, null,
            Instant.parse("2026-09-10T00:00:00Z")));
        mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isNoContent());
        assertThat(store.projects).doesNotContainKey("p1");
        assertThat(gateway.deletedProjects).containsExactly("p1");
        assertThat(runtime.closed).containsExactly("p1");
    }

    @Test
    void incompleteCleanupReturns503AndKeepsDeleting() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.RESUMED;
        store.projects.put("p1", new WorkspaceStore.ProjectRecord("p1", "owner-a", "demo", "DELETING", 0, null,
            Instant.parse("2026-09-10T00:00:00Z")));
        gateway = new FakeKubernetesGateway() {
            @Override public void deleteProjectResources(String projectId) {
                throw new ProjectResourceCleanupException(new ProjectResourceCleaner.CleanupReport(
                    false, false, List.of(), List.of()));
            }
        };
        String body = mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("PROJECT_CLEANUP_INCOMPLETE"))
            .andExpect(jsonPath("$.message").value("Project cleanup is incomplete"))
            .andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain("kubeconfig", "token", "manao-stage6");
        assertThat(store.projects.get("p1").state()).isEqualTo("DELETING");
    }

    @Test
    void leakedInternalExceptionTextIsNotReturned() throws Exception {
        deletions.result = ProjectDeletionRepository.BeginDeletion.STARTED;
        store.projects.put("p1", new WorkspaceStore.ProjectRecord("p1", "owner-a", "demo", "DELETING", 0, null,
            Instant.parse("2026-09-10T00:00:00Z")));
        runtime.failMessage = "kubeconfig=/etc/kubernetes/admin.conf token=super-secret manao-stage6";
        String body = mvc().perform(delete("/api/v1/projects/p1")
                .principal(new TestingAuthenticationToken("owner-a", "unused")))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("PROJECT_CLEANUP_INCOMPLETE"))
            .andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain("kubeconfig", "super-secret", "token=", "manao-stage6");
        assertThat(store.projects.get("p1").state()).isEqualTo("DELETING");
    }

    private MockMvc mvc() {
        ProjectCleanupService cleanup = new ProjectCleanupService(deletions, new ProjectLifecycleGate(),
            runtime, gateway, store);
        return MockMvcBuilders.standaloneSetup(new ProjectController(new ProjectService(new UnusedProjectStore()),
                null, cleanup, null, null, java.util.Set.of()))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    private static final class ScriptedDeletion extends ProjectDeletionRepository {
        private BeginDeletion result = BeginDeletion.ACTIVE_RUN;

        @Override public BeginDeletion inspect(String ownerId, String projectId) {
            return begin(ownerId, projectId);
        }

        @Override public BeginDeletion begin(String ownerId, String projectId) {
            if (!"owner-a".equals(ownerId) || !"p1".equals(projectId)) {
                return BeginDeletion.NOT_FOUND;
            }
            return result;
        }

        @Override public List<String> runIds(String ownerId, String projectId) {
            return List.of("run-1");
        }
    }

    private static final class RecordingRuntime extends ProjectRuntimeCleaner {
        private final java.util.List<String> closed = new java.util.ArrayList<>();
        private String failMessage;

        private RecordingRuntime() {
            super(null, null, null, null, null);
        }

        @Override public void closeProject(String projectId, List<String> runIds) {
            if (failMessage != null) {
                throw new IllegalStateException(failMessage);
            }
            closed.add(projectId);
        }
    }

    private static final class UnusedProjectStore implements com.manao.poc4.project.ProjectService.Store {
        public java.util.List<ProjectService.Project> listForOwner(String ownerId) { return List.of(); }
        public boolean create(String id, String ownerId, String name) { return false; }
        public ProjectService.Project findForOwner(String ownerId, String projectId) { return null; }
    }
}
