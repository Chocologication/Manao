package com.manao.poc4.kubernetes;

/**
 * Thrown when project Kubernetes cleanup could not confirm that every owned resource is gone.
 * The HTTP layer must map this to a fixed incomplete-cleanup contract; the report stays internal.
 */
public final class ProjectResourceCleanupException extends RuntimeException {
    private final ProjectResourceCleaner.CleanupReport report;

    public ProjectResourceCleanupException(ProjectResourceCleaner.CleanupReport report) {
        super("project Kubernetes cleanup is incomplete");
        this.report = report;
    }

    public ProjectResourceCleaner.CleanupReport report() {
        return report;
    }
}
