package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.api.model.PersistentVolumeBuilder;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder;
import io.fabric8.kubernetes.api.model.StatusBuilder;
import io.fabric8.kubernetes.api.model.storage.StorageClassBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProjectStorageReclamationTest {
    private static final String NS = "manao";
    private static final String PROJECT = "storage-delete";
    private static final String MYSQL_CLAIM = "manao-mysql-pvc-" + PROJECT;
    private KubernetesMockServer server;
    private KubernetesClient client;
    private FakeProjectRuntimeStore runtimeStore;

    @BeforeEach void setUp() {
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), new java.util.HashMap<>(),
            new KubernetesCrudDispatcher(), false);
        server.init();
        client = server.createClient();
        runtimeStore = new FakeProjectRuntimeStore();
    }

    @AfterEach void tearDown() { client.close(); server.destroy(); }

    @Test void pvcAbsenceIsNotEnoughWhileItsVolumeStillExists() {
        seed("Delete", Map.of("onDelete", "delete"));
        var report = clean(() -> { });
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).get()).isNull();
        assertThat(report.complete()).isFalse();
        assertThat(report.storageAbsent()).isFalse();
        assertThat(report.remaining()).extracting(ProjectResourceCleaner.ResourceRef::name).contains("project-pv");
    }

    @Test void resumedDeleteFindsTheVolumeEvenAfterThePvcHasGone() {
        seed("Delete", Map.of("onDelete", "delete"));
        client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).delete();
        assertThat(clean(() -> { }).complete()).isFalse();
        // Only the storage controller reclaims a PV; the application never force-deletes one.
        assertThat(client.persistentVolumes().withName("project-pv").get()).isNotNull();
        client.persistentVolumes().withName("project-pv").delete();
        assertThat(clean(() -> { }).complete()).isTrue();
    }

    @Test void waitsForReclamationAndLeavesUnrelatedVolumesUntouched() {
        seed("Delete", Map.of("onDelete", "delete"));
        client.persistentVolumes().resource(new PersistentVolumeBuilder()
            .withNewMetadata().withName("other-pv").endMetadata()
            .withNewSpec().withPersistentVolumeReclaimPolicy("Retain")
            .withNewClaimRef().withNamespace("other-namespace")
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).endClaimRef().endSpec().build()).create();
        var report = clean(() -> {
            if (client.persistentVolumeClaims().inNamespace(NS)
                .withName(WorkspaceResourceFactory.pvcName(PROJECT)).get() == null) {
                client.persistentVolumes().withName("project-pv").delete();
            }
        });
        assertThat(report.complete()).isTrue();
        assertThat(client.persistentVolumes().withName("other-pv").get()).isNotNull();
    }

    @Test void retainedVolumePreventsDeletingItsClaimAndClaimingSuccess() {
        seed("Retain", Map.of("onDelete", "delete"));
        assertThat(clean(() -> { }).complete()).isFalse();
        assertClaimPreserved();
    }

    @Test void defaultNfsArchivingPreventsDeletingItsClaim() {
        seed("Delete", Map.of());
        assertThat(clean(() -> { }).complete()).isFalse();
        assertClaimPreserved();
    }

    @Test void nfsOnDeleteRetainOverridesArchiveOnDeleteFalse() {
        seed("Delete", Map.of("onDelete", "retain", "archiveOnDelete", "false"));
        assertThat(clean(() -> { }).complete()).isFalse();
        assertClaimPreserved();
    }

    @Test void nfsArchiveDisabledPermitsControllerReclamation() {
        seed("Delete", Map.of("archiveOnDelete", "false"));
        var report = clean(() -> client.persistentVolumes().withName("project-pv").delete());
        assertThat(report.complete()).isTrue();
    }

    @Test void forbiddenVolumeInventoryIsNotAnEmptyInventory() {
        client = org.mockito.Mockito.spy(client);
        org.mockito.Mockito.doThrow(new io.fabric8.kubernetes.client.KubernetesClientException("Forbidden", 403,
            new StatusBuilder().withCode(403).withMessage("Forbidden").build()))
            .when(client).persistentVolumes();
        var report = clean(() -> { });
        assertThat(report.complete()).isFalse();
        assertThat(report.issues()).extracting(ProjectResourceCleaner.Issue::category).contains("FORBIDDEN");
    }

    @Test void cannotDeleteBoundClaimWithoutVerifyingItsVolumePolicy() {
        seed("Delete", Map.of("onDelete", "delete"));
        client.persistentVolumes().withName("project-pv").delete();
        assertThat(clean(() -> { }).complete()).isFalse();
        assertClaimPreserved();
    }

    @Test void nonCanonicalLabeledClaimMustNotDisappearBeforeItsVolumeCanBeTrackedAcrossRestart() {
        seed("Delete", Map.of("onDelete", "delete"));
        String canonical = WorkspaceResourceFactory.pvcName(PROJECT);
        var claim = client.persistentVolumeClaims().inNamespace(NS).withName(canonical).get();
        client.persistentVolumeClaims().inNamespace(NS).withName(canonical).delete();
        claim.getMetadata().setName(canonical + "-old");
        claim.getMetadata().setResourceVersion(null);
        claim.getMetadata().setUid(null);
        client.persistentVolumeClaims().inNamespace(NS).resource(claim).create();
        client.persistentVolumes().withName("project-pv").edit(pv -> new PersistentVolumeBuilder(pv)
            .editSpec().editClaimRef().withName(canonical + "-old").endClaimRef().endSpec().build());
        assertThat(clean(() -> { }).complete()).isFalse();
        assertThat(client.persistentVolumeClaims().inNamespace(NS).withName(canonical + "-old").get()).isNotNull();
        assertThat(client.persistentVolumes().withName("project-pv").get()).isNotNull();
        assertThat(clean(() -> { }).complete()).isFalse();
    }

    @Test void leftoverVolumesOfBothClaimsAreStillVerifiedAfterDeletionByRememberedIdentity() {
        seed("Delete", Map.of("onDelete", "delete"));
        seedMysqlVolume("Delete", Map.of("onDelete", "delete"));
        rememberBothBindings();
        // Both claims are already gone (an earlier pass deleted them); the backend may also have
        // restarted. The retry must still account for BOTH volumes via the remembered identity.
        client.persistentVolumeClaims().inNamespace(NS).withName(WorkspaceResourceFactory.pvcName(PROJECT)).delete();
        client.persistentVolumeClaims().inNamespace(NS).withName(MYSQL_CLAIM).delete();

        var partial = clean(() -> {
            if (client.persistentVolumes().withName("project-pv").get() != null) {
                client.persistentVolumes().withName("project-pv").delete();
            }
        });
        // The mysql volume is still there: an unidentified leftover must never report success.
        assertThat(partial.complete()).isFalse();
        assertThat(partial.remaining()).extracting(ProjectResourceCleaner.ResourceRef::name).contains("mysql-pv");
        assertThat(client.persistentVolumes().withName("mysql-pv").get()).isNotNull();

        var done = clean(() -> {
            for (String pv : new String[] {"project-pv", "mysql-pv"}) {
                if (client.persistentVolumes().withName(pv).get() != null) {
                    client.persistentVolumes().withName(pv).delete();
                }
            }
        });
        assertThat(done.complete()).isTrue();
        assertThat(client.persistentVolumes().withName("mysql-pv").get()).isNull();
    }

    @Test void workspaceClaimIdentityIsPersistedBeforeItsDeletion() {
        seed("Delete", Map.of("onDelete", "delete"));
        String claimUid = client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).get().getMetadata().getUid();
        String volumeUid = client.persistentVolumes().withName("project-pv").get().getMetadata().getUid();

        var report = clean(() -> {
            if (client.persistentVolumes().withName("project-pv").get() != null) {
                client.persistentVolumes().withName("project-pv").delete();
            }
        });

        assertThat(report.complete()).isTrue();
        var bindings = runtimeStore.storageBindings(PROJECT);
        assertThat(bindings).extracting(com.manao.poc4.project.ProjectRuntimeStore.StorageBinding::purpose)
            .containsExactly("WORKSPACE");
        assertThat(bindings.get(0).pvcName()).isEqualTo(WorkspaceResourceFactory.pvcName(PROJECT));
        assertThat(bindings.get(0).pvcUid()).isEqualTo(claimUid);
        assertThat(bindings.get(0).pvName()).isEqualTo("project-pv");
        assertThat(bindings.get(0).pvUid()).isEqualTo(volumeUid);
    }

    @Test void unregisteredClaimIsRejectedAndPreserved() {
        seed("Delete", Map.of("onDelete", "delete"));
        seedMysqlVolume("Delete", Map.of("onDelete", "delete"));

        var report = clean(() -> {
            if (client.persistentVolumes().withName("project-pv").get() != null) {
                client.persistentVolumes().withName("project-pv").delete();
            }
        });

        assertThat(report.complete()).isFalse();
        assertThat(report.issues())
            .extracting(ProjectResourceCleaner.Issue::category)
            .contains("UNEXPECTED_STORAGE_CLAIM");
        assertThat(client.persistentVolumeClaims().inNamespace(NS).withName(MYSQL_CLAIM).get()).isNotNull();
        assertThat(client.persistentVolumes().withName("mysql-pv").get()).isNotNull();
    }

    private void seedMysqlVolume(String policy, Map<String, String> parameters) {
        client.persistentVolumeClaims().inNamespace(NS).resource(new PersistentVolumeClaimBuilder()
            .withNewMetadata().withName(MYSQL_CLAIM).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(PROJECT))
            .addToLabels("manao.poc4/component", "mysql").endMetadata()
            .withNewSpec().withStorageClassName("nfs-storage").withVolumeName("mysql-pv").endSpec().build()).create();
        client.persistentVolumes().resource(new PersistentVolumeBuilder()
            .withNewMetadata().withName("mysql-pv").endMetadata()
            .withNewSpec().withStorageClassName("nfs-storage").withPersistentVolumeReclaimPolicy(policy)
            .withNewClaimRef().withNamespace(NS).withName(MYSQL_CLAIM).endClaimRef()
            .withNewNfs().withServer("nfs.test").withPath("/data/owned-mysql").endNfs()
            .endSpec().build()).create();
    }

    private void rememberBothBindings() {
        String workspaceClaimUid = client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).get().getMetadata().getUid();
        String mysqlClaimUid = client.persistentVolumeClaims().inNamespace(NS)
            .withName(MYSQL_CLAIM).get().getMetadata().getUid();
        runtimeStore.rememberStorage(PROJECT,
            new com.manao.poc4.project.ProjectRuntimeStore.StorageBinding("WORKSPACE",
                WorkspaceResourceFactory.pvcName(PROJECT), workspaceClaimUid, "project-pv",
                client.persistentVolumes().withName("project-pv").get().getMetadata().getUid()));
        runtimeStore.rememberStorage(PROJECT,
            new com.manao.poc4.project.ProjectRuntimeStore.StorageBinding("MYSQL",
                MYSQL_CLAIM, mysqlClaimUid, "mysql-pv",
                client.persistentVolumes().withName("mysql-pv").get().getMetadata().getUid()));
    }

    private void assertClaimPreserved() {
        assertThat(client.persistentVolumeClaims().inNamespace(NS)
            .withName(WorkspaceResourceFactory.pvcName(PROJECT)).get()).isNotNull();
    }

    private void seed(String policy, Map<String, String> parameters) {
        client.storage().v1().storageClasses().resource(new StorageClassBuilder()
            .withNewMetadata().withName("nfs-storage").endMetadata()
            .withProvisioner("k8s-sigs.io/nfs-subdir-external-provisioner")
            .withReclaimPolicy("Delete").withParameters(parameters).build()).create();
        client.persistentVolumeClaims().inNamespace(NS).resource(new PersistentVolumeClaimBuilder()
            .withNewMetadata().withName(WorkspaceResourceFactory.pvcName(PROJECT)).withNamespace(NS)
            .withLabels(WorkspaceResourceFactory.projectResourceLabels(PROJECT)).endMetadata()
            .withNewSpec().withStorageClassName("nfs-storage").withVolumeName("project-pv").endSpec().build()).create();
        client.persistentVolumes().resource(new PersistentVolumeBuilder()
            .withNewMetadata().withName("project-pv").endMetadata()
            .withNewSpec().withStorageClassName("nfs-storage").withPersistentVolumeReclaimPolicy(policy)
            .withNewClaimRef().withNamespace(NS).withName(WorkspaceResourceFactory.pvcName(PROJECT)).endClaimRef()
            .withNewNfs().withServer("nfs.test").withPath("/data/owned-project").endNfs()
            .endSpec().build()).create();
    }

    private ProjectResourceCleaner.CleanupReport clean(Runnable storageController) {
        var time = new Clock() {
            private Instant now = Instant.parse("2026-09-16T00:00:00Z");
            @Override public ZoneId getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(ZoneId zone) { return this; }
            @Override public Instant instant() { return now; }
            void advance() { now = now.plusSeconds(1); }
        };
        return new ProjectResourceCleaner(client, NS, Duration.ofSeconds(3), Duration.ofSeconds(1),
            time, Duration.ofSeconds(5), duration -> { storageController.run(); time.advance(); },
            runtimeStore).clean(PROJECT);
    }
}
