package com.manao.poc4.run;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.persistence.RunState;
import java.time.Instant;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.UUID;

/**
 * Run orchestration: start/stop/get/list with owner isolation, revision validation, fencing-token
 * acquisition and idempotent Job creation against the server-derived resource identity.
 */
public final class RunService {
    private final RunStore store;
    private final JobCoordinator coordinator;
    private final RunPolicy policy;

    public RunService(RunStore store, JobCoordinator coordinator, RunPolicy policy) {
        this.store = store;
        this.coordinator = coordinator;
        this.policy = policy;
    }

    public RunSummary start(String ownerId, String projectId, String expectedRevision) {
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
        OptionalLong fencingToken = store.acquireFencingToken();
        if (fencingToken.isEmpty()) {
            throw new ApiException("INTERNAL_ERROR", 503, "Backend authority is temporarily unavailable");
        }
        String runId = UUID.randomUUID().toString();
        RunRecord record = new RunRecord(runId, projectId, revision, RunState.STARTING, policy.toJson(),
            null, null, null, null, null, null, 0L, Instant.now());
        RunStore.InsertResult inserted = store.insertRun(record);
        if (inserted == RunStore.InsertResult.ACTIVE_RUN_EXISTS) {
            // The unique active-run marker rejected the insert; refetch the authoritative winner.
            if (store.findActiveRun(projectId).isPresent()) {
                throw new ApiException("RUN_ALREADY_ACTIVE", 409, "A run is already active");
            }
            throw new ApiException("INTERNAL_ERROR", 503, "Backend authority is temporarily unavailable");
        }
        RunRecord persisted = store.findRunForOwner(ownerId, projectId, runId).orElseThrow();
        String jobRef = coordinator.ensureJob(persisted, projectId);
        store.updateJobFacts(runId, jobRef);
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
        boolean moved = store.transition(runId, projectId, run.version(), RunState.STOPPING,
            RunState.STARTING, RunState.RUNNING);
        if (!moved) {
            // Concurrent settlement won; reflect authoritative state without touching Kubernetes.
            return toSummary(refetch(ownerId, run));
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

    public RunList list(String ownerId, String projectId, int limit) {
        var runs = store.listForOwner(ownerId, projectId, limit).stream()
            .sorted((left, right) -> {
                int byCreated = right.createdAt().compareTo(left.createdAt());
                return byCreated != 0 ? byCreated : right.id().compareTo(left.id());
            })
            .map(this::toSummary)
            .toList();
        String cursor = runs.isEmpty() ? null : java.util.Base64.getEncoder().encodeToString(
            (runs.get(runs.size() - 1).createdAt() + "|" + runs.get(runs.size() - 1).id())
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return new RunList(runs, cursor);
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

    /** Maps a persisted Run onto the browser contract; internal references never leave the server. */
    com.fasterxml.jackson.databind.JsonNode policyOf(RunRecord record) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(record.policyJson());
        } catch (Exception ex) {
            throw new IllegalStateException("stored policy snapshot is unreadable", ex);
        }
    }

    public RunSummary toSummary(RunRecord record) {
        return new RunSummary(record.id(), record.state().name(), Long.toString(record.requestedRevision()),
            policyOf(record), record.createdAt().toString(),
            record.startedAt() == null ? null : record.startedAt().toString(),
            record.finishedAt() == null ? null : record.finishedAt().toString(),
            record.terminationReason(), record.exitCode(), false, 0L, null);
    }
}
