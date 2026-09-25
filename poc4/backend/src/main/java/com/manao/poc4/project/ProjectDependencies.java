package com.manao.poc4.project;

import io.fabric8.kubernetes.api.model.EnvVar;
import java.util.List;

/**
 * Lifecycle of the per-project persistent dependencies (MySQL/Redis) selected in the runtime
 * spec. The dependency state values are fixed: ABSENT (not selected or nothing exists),
 * PROVISIONING (resources exist but are not ready), READY, UNAVAILABLE (the remote state cannot
 * be verified — never equated with ABSENT) and RECOVERY_REQUIRED (data exists without its
 * credential secret; the data must never be re-initialized).
 *
 * <p>{@link #applicationEnvironment} builds the internal application environment for run Jobs
 * only: credential values travel exclusively as Secret references and the list is never exposed
 * through a browser DTO, the run policy or logs.</p>
 */
public interface ProjectDependencies {
    String ABSENT = "ABSENT";
    String PROVISIONING = "PROVISIONING";
    String READY = "READY";
    String UNAVAILABLE = "UNAVAILABLE";
    String RECOVERY_REQUIRED = "RECOVERY_REQUIRED";

    /** Storage binding purpose registered for the MySQL data claim (the other purpose is WORKSPACE). */
    String STORAGE_PURPOSE_MYSQL = "MYSQL";

    /** Idempotent reconciliation of every selected dependency for the project. */
    void ensure(String projectId, ProjectRuntimeSpec spec);

    /** Live per-dependency state, derived from the cluster and never cached. */
    DependencyStatus status(String projectId, ProjectRuntimeSpec spec);

    /** Internal run-Job environment; credentials appear only as Secret references. */
    List<EnvVar> applicationEnvironment(String projectId, ProjectRuntimeSpec spec);

    record DependencyStatus(String mysql, String redis) {}
}
