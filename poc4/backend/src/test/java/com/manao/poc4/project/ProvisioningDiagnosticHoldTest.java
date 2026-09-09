package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.workspace.WorkspaceStore;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class ProvisioningDiagnosticHoldTest {
    private static final Instant CREATED = Instant.parse("2026-09-09T00:00:00Z");

    @Test
    void claimsOnlyTheFirstMatchingProject() {
        ProvisioningDiagnosticHold hold = new ProvisioningDiagnosticHold("alice", null, "stage6-e2e-");
        WorkspaceStore.ProjectRecord first = project("p1", "stage6-e2e-one", "alice");
        WorkspaceStore.ProjectRecord second = project("p2", "stage6-e2e-two", "alice");

        assertThat(hold.test(first)).isTrue();
        assertThat(hold.test(second)).isFalse();
    }

    @Test
    void rejectsProjectsFromAnotherOwnerOrName() {
        ProvisioningDiagnosticHold hold = new ProvisioningDiagnosticHold("alice", "stage6-e2e-one", null);

        assertThat(hold.test(project("p1", "stage6-e2e-one", "bob"))).isFalse();
        assertThat(hold.test(project("p2", "stage6-e2e-two", "alice"))).isFalse();
    }

    private static WorkspaceStore.ProjectRecord project(String id, String name, String ownerId) {
        return new WorkspaceStore.ProjectRecord(id, ownerId, name, "CREATING", 0, null, CREATED);
    }
}