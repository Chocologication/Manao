package com.manao.poc4.project;

import com.manao.poc4.workspace.WorkspaceStore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;

/** One-shot, opt-in selector for preserving one failed provisioning project for diagnosis. */
public final class ProvisioningDiagnosticHold implements Predicate<WorkspaceStore.ProjectRecord> {
    private final boolean enabled;
    private final String ownerId;
    private final String projectName;
    private final AtomicBoolean claimed = new AtomicBoolean();

    public ProvisioningDiagnosticHold(String ownerId, String projectName, String projectNamePrefix) {
        this.ownerId = blankToNull(ownerId);
        this.projectName = blankToNull(projectName);
        this.enabled = this.ownerId != null && this.projectName != null;
    }

    public static ProvisioningDiagnosticHold fromEnvironment() {
        if (!Boolean.parseBoolean(System.getenv().getOrDefault("MANAO_DIAGNOSTIC_HOLD_FAILURES", "false"))) {
            return null;
        }
        return new ProvisioningDiagnosticHold(
            System.getenv("MANAO_DIAGNOSTIC_OWNER_ID"),
            System.getenv("MANAO_DIAGNOSTIC_PROJECT_NAME"),
            System.getenv("MANAO_DIAGNOSTIC_PROJECT_NAME_PREFIX"));
    }

    @Override
    public boolean test(WorkspaceStore.ProjectRecord project) {
        if (!enabled || project == null || !matches(project)) return false;
        return claimed.compareAndSet(false, true);
    }

    private boolean matches(WorkspaceStore.ProjectRecord project) {
        if ("DELETING".equals(project.state())) return false;
        if (!ownerId.equals(project.ownerId())) return false;
        return projectName.equals(project.name());
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
