package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.kubernetes.KubernetesGateway;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceTemplate;
import io.fabric8.kubernetes.api.model.Pod;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class ProjectWorkspaceRecoveryTest {
    private static final String PROJECT = "workspace-recovery-test";
    private static final String OWNER = "owner-a";
    private static final String STORAGE_ERROR = "Workspace storage is missing. Existing files cannot be accessed.";
    private final WorkspaceStore store = mock(WorkspaceStore.class);
    private final KubernetesGateway gateway = mock(KubernetesGateway.class);
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final ProjectProvisioningService.WorkspaceBridge bridge = mock(ProjectProvisioningService.WorkspaceBridge.class);
    private final ProjectService projects = mock(ProjectService.class);
    private final AtomicReference<WorkspaceStore.ProjectRecord> record = new AtomicReference<>();
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        setProject("READY", null);
        when(store.findProject(PROJECT)).thenAnswer(invocation -> record.get());
        when(projects.get(OWNER, PROJECT)).thenAnswer(invocation -> {
            var p = record.get();
            return Optional.of(new ProjectService.Project(p.id(), p.ownerId(), p.name(), p.state(), p.createdAt(), p.failureReason()));
        });
        doAnswer(invocation -> {
            setProject("FAILED", invocation.getArgument(1));
            return null;
        }).when(store).markProjectFailed(anyString(), anyString());
        when(gateway.projectPvcExists(PROJECT)).thenReturn(true);
        when(gateway.workspacePodReady(PROJECT)).thenReturn(true);
        when(gateway.workspaceServiceExists(PROJECT)).thenReturn(true);
        var factory = new WorkspaceResourceFactory("manao-test", "nfs-storage",
            "registry.example/agent@sha256:" + "a".repeat(64),
            "registry.example/init@sha256:" + "b".repeat(64));
        var provisioning = new ProjectProvisioningService(store, gateway, workspace, factory,
            new WorkspaceTemplate(), "public-key", bridge, 2, 1);
        mvc = MockMvcBuilders.standaloneSetup(new ProjectController(projects, provisioning))
            .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    @Test
    void openingRestoresMissingPodAndServiceUsingExistingStorageWithoutReinitializingFiles() throws Exception {
        when(gateway.workspacePodReady(PROJECT)).thenReturn(false, true);
        when(gateway.workspaceServiceExists(PROJECT)).thenReturn(false, true);

        open().andExpect(status().isOk()).andExpect(jsonPath("$.state").value("READY"));
        var pod = ArgumentCaptor.forClass(Pod.class);
        verify(gateway).createPod(pod.capture());
        assertThat(pod.getValue().getMetadata().getName()).isEqualTo(WorkspaceResourceFactory.workspacePodName(PROJECT));
        assertThat(pod.getValue().getSpec().getVolumes().get(0).getPersistentVolumeClaim().getClaimName())
            .isEqualTo(WorkspaceResourceFactory.pvcName(PROJECT));
        verify(gateway).createService(any());
        verify(bridge).release(PROJECT);
        verify(bridge).allocate(PROJECT);
        assertFilesUntouched();
        assertThat(record.get().workspaceRevision()).isEqualTo(23L);

        open().andExpect(status().isOk());
        verify(gateway, times(1)).createPod(any());
        verify(gateway, times(1)).createService(any());
    }

    @Test
    void healthyWorkspaceDoesNotRecreateResources() throws Exception {
        open().andExpect(status().isOk()).andExpect(jsonPath("$.state").value("READY"));
        verify(gateway).projectPvcExists(PROJECT);
        verify(gateway, never()).createPod(any());
        verify(gateway, never()).createService(any());
        verifyNoInteractions(bridge);
        assertFilesUntouched();
    }

    @Test
    void missingServiceDoesNotReplaceHealthyPod() throws Exception {
        when(gateway.workspaceServiceExists(PROJECT)).thenReturn(false);
        open().andExpect(status().isOk());
        verify(gateway).createService(any());
        verify(gateway, never()).createPod(any());
        assertFilesUntouched();
    }

    @Test
    void missingPvcMarksProjectFailedAndReturnsExplicitStorageErrorWithoutCreatingEmptyStorage() throws Exception {
        when(gateway.projectPvcExists(PROJECT)).thenReturn(false);
        open().andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("FAILED"))
            .andExpect(jsonPath("$.failureReason").value(STORAGE_ERROR));
        verify(store).markProjectFailed(PROJECT, "WORKSPACE_STORAGE_MISSING");
        verify(gateway, never()).createPod(any());
        verify(gateway, never()).createService(any());
        assertFilesUntouched();
    }

    @Test
    void clusterUnreachableIsRetryableAndNotReportedAsMissingStorage() throws Exception {
        when(gateway.projectPvcExists(PROJECT)).thenThrow(new IllegalStateException("private cluster details"));
        open().andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
            .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("private cluster details"))));
        verify(store, never()).markProjectFailed(anyString(), anyString());
        assertFilesUntouched();
    }

    @Test
    void podReadinessFailurePreservesFilesAndCanRecoverOnNextOpen() throws Exception {
        when(gateway.workspacePodReady(PROJECT)).thenReturn(false);
        open().andExpect(status().isServiceUnavailable());
        verify(store, never()).markProjectFailed(anyString(), anyString());
        assertFilesUntouched();
        when(gateway.workspacePodReady(PROJECT)).thenReturn(true);
        open().andExpect(status().isOk()).andExpect(jsonPath("$.state").value("READY"));
    }

    @Test
    void anotherOwnerCannotTriggerRecovery() throws Exception {
        when(projects.get("owner-b", PROJECT)).thenReturn(Optional.empty());
        mvc.perform(get("/api/v1/projects/" + PROJECT)
                .principal(new TestingAuthenticationToken("owner-b", "unused")))
            .andExpect(status().isNotFound());
        verifyNoInteractions(gateway, bridge, workspace);
    }

    @ParameterizedTest
    @ValueSource(strings = {"CREATING", "FAILED", "DELETING"})
    void nonReadyProjectsDoNotEnterWorkspaceRecovery(String state) throws Exception {
        setProject(state, null);
        open().andExpect(status().isOk()).andExpect(jsonPath("$.state").value(state));
        verifyNoInteractions(gateway, bridge, workspace);
    }

    private org.springframework.test.web.servlet.ResultActions open() throws Exception {
        return mvc.perform(get("/api/v1/projects/" + PROJECT)
            .principal(new TestingAuthenticationToken(OWNER, "unused")));
    }

    private void setProject(String state, String reason) {
        record.set(new WorkspaceStore.ProjectRecord(PROJECT, OWNER, "existing project", state, 23, reason,
            Instant.parse("2026-09-16T00:00:00Z")));
    }

    private void assertFilesUntouched() {
        verifyNoInteractions(workspace);
        verify(gateway, never()).createPvc(any());
        verify(gateway, never()).deletePod(anyString());
        verify(gateway, never()).deleteProjectResources(anyString());
        verify(gateway, never()).deleteWorkspaceWorkloads(anyString());
        verify(store, never()).markProjectReady(anyString());
    }
}
