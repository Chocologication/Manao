package com.manao.poc4.run;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectDependencies;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import io.fabric8.kubernetes.api.model.EnvVar;
import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Run orchestration: start/stop/get/list with owner isolation, revision validation, fencing-token
 * acquisition and idempotent Job creation against the server-derived resource identity. A run
 * only starts when every selected dependency is READY — a service run waiting for its database
 * is never created — and a user stop persists its intent before the Job delete is issued.
 */
public final class RunService {
    private static final Logger LOG = LoggerFactory.getLogger(RunService.class);

    private final RunStore store;
    private final JobCoordinator coordinator;
    private final RunPolicy policy;
    private final ProjectLifecycleGate lifecycle;
    private final ProjectRuntimeStore runtimeStore;
    private final ProjectDependencies dependencies;
    private final PublicEndpointGateway endpoints;

    public RunService(RunStore store, JobCoordinator coordinator, RunPolicy policy) {
        this(store, coordinator, policy, new ProjectLifecycleGate(), null, null, null);
    }

    public RunService(RunStore store, JobCoordinator coordinator, RunPolicy policy, ProjectLifecycleGate lifecycle) {
        this(store, coordinator, policy, lifecycle, null, null, null);
    }

    public RunService(RunStore store, JobCoordinator coordinator, RunPolicy policy, ProjectLifecycleGate lifecycle,
                      ProjectRuntimeStore runtimeStore, ProjectDependencies dependencies,
                      PublicEndpointGateway endpoints) {
        this.store = store;
        this.coordinator = coordinator;
        this.policy = policy;
        this.lifecycle = lifecycle;
        this.runtimeStore = runtimeStore;
        this.dependencies = dependencies;
        this.endpoints = endpoints;
    }

    public RunSummary start(String ownerId, String projectId, String expectedRevision) {
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            return startLocked(ownerId, projectId, expectedRevision);
        }
    }

    private RunSummary startLocked(String ownerId, String projectId, String expectedRevision) {
        RunStore.ProjectRecord project = store.findProjectForOwner(ownerId, projectId);
        if (project == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        if (!"READY".equals(project.state())) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        long revision = parseRevision(expectedRevision);
        if (revision != project.revision()) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "The workspace changed; reload and retry.");
        }
        if (store.findActiveRun(projectId).isPresent()) {
            throw new ApiException("RUN_ALREADY_ACTIVE", 409, "A run is already active");
        }
        ProjectRuntimeSpec spec = loadSpec(projectId);
        requireDependenciesReady(projectId, spec);
        RunPolicy runPolicy = spec.isService() ? policy.forService() : policy;
        List<EnvVar> applicationEnvironment =
            dependencies == null ? List.of() : dependencies.applicationEnvironment(projectId, spec);
        OptionalLong fencingToken = store.acquireFencingToken();
        if (fencingToken.isEmpty()) {
            throw new ApiException("INTERNAL_ERROR", 503, "Backend authority is temporarily unavailable");
        }
        long token = fencingToken.getAsLong();
        String runId = UUID.randomUUID().toString();
        RunRecord record = new RunRecord(runId, projectId, revision, RunState.STARTING, runPolicy.toJson(),
            null, null, null, null, null, null, 0L, Instant.now(), token);
        RunStore.InsertResult inserted = store.insertRun(record, token);
        if (inserted == RunStore.InsertResult.PROJECT_LOCKED) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        if (inserted == RunStore.InsertResult.PROJECT_NOT_FOUND) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        if (inserted == RunStore.InsertResult.REVISION_CONFLICT) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "The workspace changed; reload and retry.");
        }
        if (inserted == RunStore.InsertResult.ACTIVE_RUN_EXISTS) {
            // The unique active-run marker rejected the insert; refetch the authoritative winner.
            if (store.findActiveRun(projectId).isPresent()) {
                throw new ApiException("RUN_ALREADY_ACTIVE", 409, "A run is already active");
            }
            throw new ApiException("INTERNAL_ERROR", 503, "Run could not be started");
        }
        if (inserted != RunStore.InsertResult.INSERTED) {
            throw new ApiException("INTERNAL_ERROR", 503, "Run could not be started");
        }
        RunRecord persisted = store.findRunForOwner(ownerId, projectId, runId).orElseThrow();
        try {
            String jobRef = coordinator.ensureJob(persisted, projectId, spec.primaryPort(), applicationEnvironment);
            String podRef = coordinator.findLivePod(runId).map(JobCoordinator.LivePod::podName).orElse(null);
            store.updateJobFacts(runId, jobRef, podRef);
        } catch (RuntimeException ex) {
            // Check whether the Job actually exists despite the exception (network timeout etc.):
            // the stable Job identity decides — a second execution is never created here.
            boolean jobMayExist = coordinator.observe(persisted).kind() != JobCoordinator.ObservationKind.MISSING;
            if (jobMayExist) {
                store.transition(runId, projectId, persisted.version(), RunState.RECOVERING,
                    persisted.fencingToken(), RunState.STARTING);
                LOG.warn("Run Job creation uncertain, marking as RECOVERING for observation: runId={}", runId, ex);
            } else {
                // The Job is definitively absent; safe to fail without touching the cluster again.
                store.settle(runId, RunState.FAILED, "START_FAILED", null);
            }
            throw new ApiException("INTERNAL_ERROR", 503, "Run could not be started");
        }
        return toSummary(store.findRunForOwner(ownerId, projectId, runId).orElseThrow());
    }

    public RunSummary stop(String ownerId, String projectId, String runId) {
        RunRecord run = store.findRunForOwner(ownerId, projectId, runId)
            .orElseThrow(() -> new ApiException("RUN_NOT_FOUND", 404, "Run not found"));
        if (RunStateReducer.isTerminal(run.state())) {
            return toSummary(run);
        }
        if (run.state() == RunState.STOPPING) {
            coordinator.stop(jobRef(run));
            return toSummary(refetch(ownerId, run));
        }
        OptionalLong stopToken = store.acquireFencingToken();
        if (stopToken.isEmpty()) {
            throw new ApiException("INTERNAL_ERROR", 503, "Backend authority is temporarily unavailable");
        }
        // The intent is persisted atomically with STOPPING, so a restart can never lose it.
        boolean moved = store.requestStop(runId, "USER_STOPPED", stopToken.getAsLong());
        if (!moved) {
            // Concurrent settlement won; reflect authoritative state without touching Kubernetes.
            return toSummary(refetch(ownerId, run));
        }
        if (endpoints != null && isServiceRun(run)) {
            try {
                endpoints.withdraw(projectId);
            } catch (RuntimeException ex) {
                LOG.warn("endpoint withdraw failed during stop; the allocation stays with the project", ex);
            }
        }
        coordinator.stop(jobRef(run));
        return toSummary(refetch(ownerId, run));
    }

    public RunSummary get(String ownerId, String projectId, String runId) {
        return store.findRunForOwner(ownerId, projectId, runId)
            .map(this::toSummary)
            .orElseThrow(() -> new ApiException("RUN_NOT_FOUND", 404, "Run not found"));
    }

    /** Internal summary lookup for ticket-bound log/terminal sockets. */
    public RunSummary findSummaryById(String runId) {
        return store.findRun(runId).map(this::toSummary).orElse(null);
    }

    public Optional<RunSummary> active(String ownerId, String projectId) {
        if (store.findProjectForOwner(ownerId, projectId) == null) {
            return Optional.empty();
        }
        return store.findActiveRun(projectId).map(this::toSummary);
    }

    public RunList list(String ownerId, String projectId, String encodedCursor, int limit) {
        RunStore.RunCursor cursor = decodeCursor(encodedCursor);
        RunStore.RunPage page = store.listForOwner(ownerId, projectId, cursor, limit);
        var runs = page.items().stream()
            .sorted((left, right) -> {
                int byCreated = right.createdAt().compareTo(left.createdAt());
                return byCreated != 0 ? byCreated : right.id().compareTo(left.id());
            })
            .map(this::toSummary)
            .toList();
        String nextCursor = page.hasMore() && !runs.isEmpty() ? encodeCursor(runs.get(runs.size() - 1)) : null;
        return new RunList(runs, nextCursor);
    }

    private RunStore.RunCursor decodeCursor(String encodedCursor) {
        if (encodedCursor == null || encodedCursor.isBlank()) return null;
        try {
            String value = new String(Base64.getDecoder().decode(encodedCursor), StandardCharsets.UTF_8);
            int separator = value.indexOf('|');
            if (separator <= 0 || separator == value.length() - 1 || value.indexOf('|', separator + 1) >= 0) {
                throw new IllegalArgumentException();
            }
            String id = value.substring(separator + 1);
            return new RunStore.RunCursor(Instant.parse(value.substring(0, separator)), id);
        } catch (IllegalArgumentException | DateTimeException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }

    private String encodeCursor(RunSummary summary) {
        return Base64.getEncoder().encodeToString(
            (summary.createdAt() + "|" + summary.id()).getBytes(StandardCharsets.UTF_8));
    }

    public record RunList(java.util.List<RunSummary> items, String nextCursor) { }

    private RunRecord refetch(String ownerId, RunRecord run) {
        return store.findRunForOwner(ownerId, run.projectId(), run.id()).orElse(run);
    }

    private String jobRef(RunRecord run) {
        return run.jobRef() == null ? JobResourceFactory.jobName(run.id()) : run.jobRef();
    }

    private long parseRevision(String expectedRevision) {
        if (expectedRevision == null) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        try {
            long revision = Long.parseLong(expectedRevision);
            if (revision < 0) throw new NumberFormatException();
            return revision;
        } catch (NumberFormatException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }

    private ProjectRuntimeSpec loadSpec(String projectId) {
        if (runtimeStore == null) {
            return ProjectRuntimeSpec.console();
        }
        return runtimeStore.loadSpec(projectId);
    }

    /**
     * Every selected dependency must be READY before a Run exists: users re-click after recovery
     * instead of the backend parking user code behind an unavailable database.
     */
    private void requireDependenciesReady(String projectId, ProjectRuntimeSpec spec) {
        if (dependencies == null || (!spec.mysql() && !spec.redis())) {
            return;
        }
        ProjectDependencies.DependencyStatus status = dependencies.status(projectId, spec);
        boolean mysqlReady = !spec.mysql() || ProjectDependencies.READY.equals(status.mysql());
        boolean redisReady = !spec.redis() || ProjectDependencies.READY.equals(status.redis());
        if (!mysqlReady || !redisReady) {
            throw new ApiException("DEPENDENCY_NOT_READY", 409,
                "Selected dependencies are not ready yet. Try again once they are ready.");
        }
    }

    private static boolean isServiceRun(RunRecord run) {
        try {
            return RunPolicy.fromJson(run.policyJson()).isService();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /** Maps a persisted Run onto the browser contract; internal references never leave the server. */
    com.fasterxml.jackson.databind.JsonNode policyOf(RunRecord record) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(record.policyJson());
        } catch (Exception ex) {
            throw new IllegalStateException("stored policy snapshot is unreadable", ex);
        }
    }

    public RunSummary toSummary(RunRecord record) {
        boolean serviceRun = isServiceRun(record);
        return new RunSummary(record.id(), record.state().name(), Long.toString(record.requestedRevision()),
            policyOf(record), record.createdAt().toString(),
            record.startedAt() == null ? null : record.startedAt().toString(),
            record.finishedAt() == null ? null : record.finishedAt().toString(),
            record.terminationReason(), record.exitCode(), false, 0L, null,
            serviceRun && record.firstReadyAt() != null ? record.firstReadyAt().toString() : null,
            serviceRun && record.expiresAt() != null ? record.expiresAt().toString() : null);
    }
}
