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
        agent.meta = new com.manao.poc4.workspace.WorkspaceAgent.FileMeta("", "", 0L, "text/plain", "UTF-8",
            "plaintext", "MONACO_TEXT", null, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        gateway = new FakeKubernetesGateway();
        factory = new RecordingFactory();
        WorkspaceOperationService operations = new WorkspaceOperationService(store, agent);
        WorkspaceService workspace = new WorkspaceService(store, operations, agent);
        service = new ProjectProvisioningService(store, gateway, workspace, factory,
            new WorkspaceTemplate(), "cHVibGljLWtleQ==", null, 3, 1);
    }

    @Test
    void provisionsPvcThenInitializerBeforeWorkspacePodAndWritesTemplate() {
        service.provision(PROJECT);

        // Empty PVC bootstrap must happen before any subPath mount of the project directory.
        assertThat(factory.calls).containsExactly("pvc", "initializer", "workspace-pod", "service");
        assertThat(gateway.created).contains("pvc:" + PROJECT, "init:" + PROJECT, "pod:" + PROJECT, "svc:" + PROJECT);
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        // Eleven parent-first directories + CREATE and SAVE for each of five template files.
        assertThat(store.committed).hasSize(21);
        assertThat(store.revision.get(PROJECT)).isEqualTo(21L);
        assertThat(store.failures).isEmpty();
    }

    @Test
    void savesEveryTemplateFileAfterCreatingItAndBeforeMarkingReady() {
        var commands = new ArrayList<com.manao.poc4.workspace.WorkspaceAgent.Command>();
        agent.mutator = command -> {
            assertThat(store.projects.get(PROJECT).state()).isEqualTo("CREATING");
            commands.add(command);
            if ("CREATE".equals(command.type()) && "file".equals(command.kind())) {
                agent.meta = new com.manao.poc4.workspace.WorkspaceAgent.FileMeta(command.path(), command.path(),
                    0L, "text/plain", "UTF-8", "plaintext", "MONACO_TEXT", null,
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
            }
            return new com.manao.poc4.workspace.WorkspaceAgent.MutationResult(command.operationId(), command.path(),
                command.expectedBeforeSha256(), command.expectedAfterSha256(),
                ".manao/receipts/" + command.operationId() + ".json", command.expectedReceiptSha256());
        };
        service.provision(PROJECT);
        new WorkspaceTemplate().files().forEach((path, content) -> {
            var writes = commands.stream().filter(command -> path.equals(command.path())).toList();
            assertThat(writes).extracting(com.manao.poc4.workspace.WorkspaceAgent.Command::type)
                .containsExactly("CREATE", "SAVE");
            assertThat(writes.get(0).content()).isEmpty();
            assertThat(writes.get(1).content()).isEqualTo(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        });
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
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
    void bridgeIsAllocatedBeforeTemplateWriteAndReleasedOnFailure() {
        List<String> bridgeCalls = new ArrayList<>();
        ProjectProvisioningService.WorkspaceBridge bridge = new ProjectProvisioningService.WorkspaceBridge() {
            @Override public void allocate(String projectId) { bridgeCalls.add("allocate:" + callsSize()); }
            @Override public void release(String projectId) { bridgeCalls.add("release"); }
            private int callsSize() { return factory.calls.size(); }
        };
        service = new ProjectProvisioningService(store, gateway, workspaceService(), factory,
            new WorkspaceTemplate(), "cHVibGljLWtleQ==", bridge, 3, 1);
        service.provision(PROJECT);
        // allocate must run after the workspace service exists (4 factory calls) and before READY.
        assertThat(bridgeCalls).containsExactly("allocate:4");
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
    }

    private com.manao.poc4.workspace.WorkspaceService workspaceService() {
        return new com.manao.poc4.workspace.WorkspaceService(store,
            new com.manao.poc4.workspace.WorkspaceOperationService(store, agent), agent);
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
            super("manao-test", "rwx-storage",
            "registry.example/manao/workspace-agent@sha256:" + "a".repeat(64),
            "registry.example/manao/initializer@sha256:" + "b".repeat(64));
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
