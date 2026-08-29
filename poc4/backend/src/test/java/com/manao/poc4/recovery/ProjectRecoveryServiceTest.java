package com.manao.poc4.recovery;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.StubAgent;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProjectRecoveryServiceTest {
    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");
    private static final String PROJECT = "prj-stale";
    private static final String OTHER = "prj-other";

    private FakeStore store;
    private StubAgent agent;
    private FakeKubernetesGateway gateway;
    private ProjectRecoveryService service;

    @BeforeEach
    void setUp() {
        store = new FakeStore();
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "alice-id", "stale", "CREATING", 0, null,
            NOW.minus(Duration.ofMinutes(11))));
        store.projects.put(OTHER, new WorkspaceStore.ProjectRecord(OTHER, "alice-id", "other", "READY", 3, null,
            NOW.minus(Duration.ofMinutes(30))));
        agent = new StubAgent();
        gateway = new FakeKubernetesGateway();
        for (String kind : java.util.List.of("pvc", "init", "pod", "svc")) {
            gateway.created.add(kind + ":" + PROJECT);
            gateway.created.add(kind + ":" + OTHER);
        }
        service = new ProjectRecoveryService(store, agent, gateway,
            Clock.fixed(NOW, ZoneOffset.UTC), Duration.ofMinutes(10));
    }

    @Test
    void youngCreatingProjectsAreUntouched() {
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "alice-id", "stale", "CREATING", 0, null,
            NOW.minus(Duration.ofMinutes(9))));
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.processed()).isEmpty();
        assertThat(store.failures).isEmpty();
        assertThat(gateway.deletedProjects).isEmpty();
    }

    @Test
    void staleCreatingProjectWithCompleteEvidenceBecomesReady() {
        store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "alice-id", "stale", "CREATING", 5, null,
            NOW.minus(Duration.ofMinutes(11))));
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.processed()).containsExactly(PROJECT);
        assertThat(report.ready()).containsExactly(PROJECT);
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
        assertThat(gateway.deletedProjects).isEmpty();
    }

    @Test
    void staleCreatingProjectWithPendingMatchingReceiptCommitsAndBecomesReady() {
        String contentSha = "f".repeat(64);
        String after = com.manao.poc4.workspace.WorkspaceOperationService.entryDigest("file", "pom.xml", contentSha);
        store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("op-1", PROJECT, 0, "b".repeat(64), after,
            ".manao/receipts/op-1.json", "c".repeat(64)));
        agent.receiptFor.put("op-1", new com.manao.poc4.workspace.WorkspaceAgent.FetchedReceipt("op-1", "SAVE", "pom.xml", "",
            "b".repeat(64), after, "c".repeat(64)));
        agent.meta = new com.manao.poc4.workspace.WorkspaceAgent.FileMeta("pom.xml", "pom.xml", 100L,
            "application/xml", "UTF-8", "xml", "MONACO_TEXT", null, contentSha);
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.ready()).containsExactly(PROJECT);
        assertThat(store.committed).extracting(WorkspaceStore.OperationRecord::id).containsExactly("op-1");
        assertThat(store.projects.get(PROJECT).state()).isEqualTo("READY");
    }

    @Test
    void staleCreatingProjectWithMissingResourcesIsLabelScopedAndFailed() {
        gateway.created.remove("pod:" + PROJECT);
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.failed()).containsExactly(PROJECT);
        assertThat(store.failures).containsEntry(PROJECT, "CREATION_FAILED");
        assertThat(gateway.deletedProjects).containsExactly(PROJECT);
        assertThat(gateway.created).contains("pod:" + OTHER);
    }

    @Test
    void staleCreatingProjectWithMissingReceiptFailsWithReconciliation() {
        store.pending.put(PROJECT, new WorkspaceStore.OperationRecord("op-1", PROJECT, 0, "b".repeat(64), "a".repeat(64),
            ".manao/receipts/op-1.json", "c".repeat(64)));
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.failed()).containsExactly(PROJECT);
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(gateway.deletedProjects).containsExactly(PROJECT);
    }

    @Test
    void readyAndFailedProjectsAreNeverTouched() {
        ProjectRecoveryService.RecoveryReport report = service.recoverStaleCreatingProjects();
        assertThat(report.processed()).containsExactly(PROJECT);
        assertThat(gateway.deletedProjects).doesNotContain(OTHER);
    }
}
