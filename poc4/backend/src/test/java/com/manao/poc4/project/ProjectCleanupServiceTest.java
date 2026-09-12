package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.kubernetes.ProjectResourceCleanupException;
import com.manao.poc4.kubernetes.ProjectResourceCleaner;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceStore;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProjectCleanupServiceTest {
    private static final String OWNER = "alice-id";
    private static final String PROJECT = "prj-cleanup";
    private static final Instant CREATED = Instant.parse("2026-09-10T00:00:00Z");

    private FakeStore store;
    private FakeKubernetesGateway gateway;
    private RecordingRuntime runtime;
    private StoreBackedDeletion deletions;
    private ProjectLifecycleGate gate;
    private ProjectCleanupService cleanup;

    @BeforeEach
    void setUp() {
        store = new FakeStore();
        gateway = new FakeKubernetesGateway();
        runtime = new RecordingRuntime();
        deletions = new StoreBackedDeletion(store);
        gate = new ProjectLifecycleGate();
        cleanup = new ProjectCleanupService(deletions, gate, runtime, gateway, store);
        store.projects.put(PROJECT, project("READY"));
    }

    @Test
    void readyDeleteClosesHandlesThenKubernetesThenDatabase() {
        java.util.Collections.addAll(gateway.created, "pvc:" + PROJECT, "pod:" + PROJECT);
        cleanup.delete(OWNER, PROJECT);
        assertThat(runtime.closed).containsExactly(PROJECT);
        assertThat(gateway.deletedProjects).containsExactly(PROJECT);
        assertThat(store.projects).doesNotContainKey(PROJECT);
    }

    @Test
    void creatingDeleteIsConflictWithoutSideEffects() {
        store.projects.put(PROJECT, project("CREATING"));
        assertThatThrownBy(() -> cleanup.delete(OWNER, PROJECT))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.status()).isEqualTo(409);
                assertThat(ex.code()).isEqualTo("PROJECT_CREATING");
            });
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("CREATING");
        assertThat(runtime.closed).isEmpty();
        assertThat(gateway.deletedProjects).isEmpty();
    }

    @Test
    void heldLifecycleLeaseLeavesReadyUntouched() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread holder = new Thread(() -> {
            try (var ignored = gate.tryAcquire(PROJECT).orElseThrow()) {
                held.countDown();
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("lease holder timed out");
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(ex);
            }
        });
        holder.start();
        assertThat(held.await(5, TimeUnit.SECONDS)).isTrue();
        try {
            assertThatThrownBy(() -> cleanup.delete(OWNER, PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.status()).isEqualTo(409);
                    assertThat(ex.code()).isEqualTo("PROJECT_BUSY");
                });
            assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
            assertThat(runtime.closed).isEmpty();
            assertThat(gateway.deletedProjects).isEmpty();
        } finally {
            release.countDown();
            holder.join(TimeUnit.SECONDS.toMillis(5));
        }
    }

    @Test
    void kubernetesIncompleteKeepsDeletingAndAllowsResume() {
        gateway = new IncompleteOnceGateway();
        cleanup = new ProjectCleanupService(deletions, gate, runtime, gateway, store);
        assertThatThrownBy(() -> cleanup.delete(OWNER, PROJECT))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.status()).isEqualTo(503);
                assertThat(ex.code()).isEqualTo("PROJECT_CLEANUP_INCOMPLETE");
            });
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("DELETING");
        assertThat(store.projects).containsKey(PROJECT);

        ProjectCleanupService restarted = new ProjectCleanupService(deletions, new ProjectLifecycleGate(),
            runtime, gateway, store);
        restarted.delete(OWNER, PROJECT);
        assertThat(store.projects).doesNotContainKey(PROJECT);
        assertThat(gateway.deletedProjects).contains(PROJECT);
    }

    @Test
    void runtimeCloseFailureDoesNotDeleteKubernetesOrDatabase() {
        runtime.fail = true;
        assertThatThrownBy(() -> cleanup.delete(OWNER, PROJECT))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.status()).isEqualTo(503);
                assertThat(ex.code()).isEqualTo("PROJECT_CLEANUP_INCOMPLETE");
            });
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("DELETING");
        assertThat(gateway.deletedProjects).isEmpty();
        assertThat(store.projects).containsKey(PROJECT);
    }

    @Test
    void missingOwnerIsNotFoundWithNoSideEffects() {
        assertThatThrownBy(() -> cleanup.delete("other-owner", PROJECT))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.status()).isEqualTo(404);
                assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND");
            });
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        assertThat(runtime.closed).isEmpty();
        assertThat(gateway.deletedProjects).isEmpty();
    }

    private static WorkspaceStore.ProjectRecord project(String state) {
        return new WorkspaceStore.ProjectRecord(PROJECT, OWNER, "demo", state, 0, null, CREATED);
    }

    private static final class StoreBackedDeletion extends ProjectDeletionRepository {
        private final FakeStore store;

        private StoreBackedDeletion(FakeStore store) {
            this.store = store;
        }

        @Override public BeginDeletion inspect(String ownerId, String projectId) {
            return evaluate(ownerId, projectId, false);
        }

        @Override public BeginDeletion begin(String ownerId, String projectId) {
            return evaluate(ownerId, projectId, true);
        }

        @Override public List<String> runIds(String ownerId, String projectId) {
            return List.of();
        }

        private BeginDeletion evaluate(String ownerId, String projectId, boolean mutate) {
            WorkspaceStore.ProjectRecord project = store.findProjectForOwner(ownerId, projectId);
            if (project == null) {
                return BeginDeletion.NOT_FOUND;
            }
            if ("CREATING".equals(project.state())) {
                return BeginDeletion.CREATING;
            }
            if ("DELETING".equals(project.state())) {
                return BeginDeletion.RESUMED;
            }
            if (store.hasActiveRun(projectId)) {
                return BeginDeletion.ACTIVE_RUN;
            }
            if ("READY".equals(project.state()) && store.pending.containsKey(projectId)) {
                return BeginDeletion.BUSY;
            }
            if (!"READY".equals(project.state()) && !"FAILED".equals(project.state())) {
                return BeginDeletion.BUSY;
            }
            if (mutate) {
                store.projects.put(projectId, new WorkspaceStore.ProjectRecord(project.id(), project.ownerId(),
                    project.name(), "DELETING", project.workspaceRevision(), project.failureReason(),
                    project.createdAt()));
            }
            return BeginDeletion.STARTED;
        }
    }

    private static final class RecordingRuntime extends ProjectRuntimeCleaner {
        private final List<String> closed = new ArrayList<>();
        private boolean fail;

        private RecordingRuntime() {
            super(null, null, null, null, null);
        }

        @Override public void closeProject(String projectId, List<String> runIds) {
            if (fail) {
                throw new IllegalStateException("kubeconfig=/tmp/secret token=leak manao-stage6");
            }
            closed.add(projectId);
        }
    }

    private static final class IncompleteOnceGateway extends FakeKubernetesGateway {
        private int attempts;

        @Override public void deleteProjectResources(String projectId) {
            attempts++;
            if (attempts == 1) {
                throw new ProjectResourceCleanupException(new ProjectResourceCleaner.CleanupReport(
                    false, false, List.of(), List.of()));
            }
            super.deleteProjectResources(projectId);
        }
    }
}
