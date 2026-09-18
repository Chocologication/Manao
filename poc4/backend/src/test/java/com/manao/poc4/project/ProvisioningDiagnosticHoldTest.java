package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.workspace.WorkspaceStore;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class ProvisioningDiagnosticHoldTest {
    private static final Instant CREATED = Instant.parse("2026-09-09T00:00:00Z");

    @Test
    void claimsOnlyTheExactOwnerAndNameOnce() {
        ProvisioningDiagnosticHold hold = new ProvisioningDiagnosticHold("alice", "stage6-e2e-one", null);
        WorkspaceStore.ProjectRecord first = project("p1", "stage6-e2e-one", "alice", "FAILED");
        WorkspaceStore.ProjectRecord second = project("p2", "stage6-e2e-one", "alice", "FAILED");

        assertThat(hold.test(first)).isTrue();
        assertThat(hold.test(second)).isFalse();
    }

    @Test
    void prefixOnlyOrMissingOwnerNeverClaims() {
        ProvisioningDiagnosticHold prefix = new ProvisioningDiagnosticHold("alice", null, "stage6-e2e-");
        ProvisioningDiagnosticHold noOwner = new ProvisioningDiagnosticHold(null, "stage6-e2e-one", null);
        WorkspaceStore.ProjectRecord project = project("p1", "stage6-e2e-one", "alice", "FAILED");

        assertThat(prefix.test(project)).isFalse();
        assertThat(noOwner.test(project)).isFalse();
    }

    @Test
    void rejectsProjectsFromAnotherOwnerOrName() {
        ProvisioningDiagnosticHold hold = new ProvisioningDiagnosticHold("alice", "stage6-e2e-one", null);

        assertThat(hold.test(project("p1", "stage6-e2e-one", "bob", "FAILED"))).isFalse();
        assertThat(hold.test(project("p2", "stage6-e2e-two", "alice", "FAILED"))).isFalse();
    }

    @Test
    void deletingProjectsAreNeverHeld() {
        ProvisioningDiagnosticHold hold = new ProvisioningDiagnosticHold("alice", "stage6-e2e-one", null);
        assertThat(hold.test(project("p1", "stage6-e2e-one", "alice", "DELETING"))).isFalse();
    }

    @Test
    void aFreshSelectorAfterRestartDoesNotClaimADifferentProjectIdByPrefix() {
        ProvisioningDiagnosticHold first = new ProvisioningDiagnosticHold("alice", "held-name", "stage6-e2e-");
        assertThat(first.test(project("p1", "held-name", "alice", "FAILED"))).isTrue();

        ProvisioningDiagnosticHold restarted = new ProvisioningDiagnosticHold("alice", "held-name", "stage6-e2e-");
        assertThat(restarted.test(project("p2", "stage6-e2e-other", "alice", "FAILED"))).isFalse();
        assertThat(restarted.test(project("p1", "held-name", "alice", "FAILED"))).isTrue();
    }

    private static WorkspaceStore.ProjectRecord project(String id, String name, String ownerId, String state) {
        return new WorkspaceStore.ProjectRecord(id, ownerId, name, state, 0, null, CREATED);
    }
}
