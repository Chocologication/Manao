package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.StubAgent;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceTemplate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProjectProvisioningServiceTest {
    private static final String PROJECT = "prj-new";

    private FakeStore store;
    private StubAgent agent;
    private FakeKubernetesGateway gateway;
    private RecordingFactory factory;
    private ProjectProvisioningService service;

    @BeforeEach
    void setUp() {
        store = new FakeStore();
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "alice-id", "new", "CREATING", 0, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        agent = new StubAgent();
        gateway = new FakeKubernetesGateway();
        factory = new RecordingFactory();
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent);
        WorkspaceService workspace = new WorkspaceService(store, operations, agent);
        service = new ProjectProvisioningService(store, gateway, workspace, factory,
            new WorkspaceTemplate(), "cHVibGljLWtleQ==", 3, 1);
    }

    @Test
    void provisionsPvcThenInitializerBeforeWorkspacePodAndWritesTemplate() {
        service.provision(PROJECT);

        // Empty PVC bootstrap must happen before any subPath mount of the project directory.
        assertThat(factory.calls).containsExactly("pvc", "initializer", "workspace-pod", "service");
        assertThat(gateway.created).contains("pvc:" + PROJECT, "init:" + PROJECT, "pod:" + PROJECT, "svc:" + PROJECT);
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        // Template writes: two leaf directories + five template files.
        assertThat(store.committed).hasSize(7);
        assertThat(store.revision.get(PROJECT)).isEqualTo(7L);
        assertThat(store.failures).isEmpty();
    }

    @Test
    void initializerFailureCleansLabelScopedResourcesAndFailsTheProject() {
        gateway.initializerFails = true;
        service.provision(PROJECT);
        assertThat(store.failures).containsEntry(PROJECT, "CREATION_FAILED");
        assertThat(gateway.deletedProjects).containsExactly(PROJECT);
        assertThat(gateway.created).noneMatch(entry -> entry.endsWith(":" + PROJECT));
    }

    @Test
    void nonCreatingProjectsAreSkipped() {
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "alice-id", "new", "READY", 4, null,
            java.time.Instant.parse("2026-08-29T00:00:00Z")));
        service.provision(PROJECT);
        assertThat(factory.calls).isEmpty();
    }

    /** Records the order in which the provisioning service asks for resources. */
    static final class RecordingFactory extends WorkspaceResourceFactory {
        final List<String> calls = new ArrayList<>();

        RecordingFactory() {
            super("manao-test", "rwx-storage", "agent-image", "initializer-image");
        }

        @Override public io.fabric8.kubernetes.api.model.PersistentVolumeClaim createPvc(String projectId) {
            calls.add("pvc");
            return super.createPvc(projectId);
        }

        @Override public io.fabric8.kubernetes.api.model.Pod createInitializerPod(String projectId) {
            calls.add("initializer");
            return super.createInitializerPod(projectId);
        }

        @Override public io.fabric8.kubernetes.api.model.Pod createWorkspacePod(String projectId, String key) {
            calls.add("workspace-pod");
            return super.createWorkspacePod(projectId, key);
        }

        @Override public io.fabric8.kubernetes.api.model.Service createWorkspaceService(String projectId) {
            calls.add("service");
            return super.createWorkspaceService(projectId);
        }
    }
}
