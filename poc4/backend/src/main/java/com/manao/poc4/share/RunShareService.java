package com.manao.poc4.share;

import static com.manao.poc4.share.RunShareContracts.*;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunStateReducer;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.share.JdbcRunShareStore.LockedProject;
import com.manao.poc4.share.JdbcRunShareStore.ShareReceipt;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.dao.DuplicateKeyException;

/** Creates immutable, independent snapshots from the selected terminal Run and current database logs. */
public final class RunShareService {
    private final JdbcRunShareStore shares;
    private final RunStore runs;
    private final JdbcLogStore logs;
    private final ObjectMapper json;
    private final SecureRandom random = new SecureRandom();

    public RunShareService(JdbcRunShareStore shares, RunStore runs, JdbcLogStore logs, ObjectMapper json) {
        this.shares = shares;
        this.runs = runs;
        this.logs = logs;
        this.json = json;
    }

    public Preview preview(String ownerId, String projectId, String runId) {
        return shares.inProjectTransaction(ownerId, projectId, project -> {
            requireProject(project);
            var run = requireTerminalRun(ownerId, projectId, runId);
            var active = shares.findActive(ownerId, runId);
            if (active.isPresent()) return new Preview("EXISTING", null, null, ownerShare(active.get()));
            var snapshot = snapshot(run);
            return new Preview("PREVIEW", snapshot, digest(new SnapshotEnvelope(projectId, runId, snapshot)), null);
        });
    }

    public PublishOutcome publish(String ownerId, String projectId, String runId, PublishRequest request) {
        var normalized = normalize(request);
        String requestDigest = digest(new RequestEnvelope(projectId, runId, normalized.snapshotDigest(),
            normalized.title(), normalized.description()));
        var prior = shares.findReceiptByRequest(ownerId, normalized.requestId());
        if (prior.isPresent()) return recovered(prior.get(), requestDigest);
        try {
            return shares.inProjectTransaction(ownerId, projectId, project -> {
                var lockedReceipt = shares.findReceiptByRequest(ownerId, normalized.requestId());
                if (lockedReceipt.isPresent()) return recovered(lockedReceipt.get(), requestDigest);
                var source = requireProject(project);
                var run = requireTerminalRun(ownerId, projectId, runId);
                if (shares.findActive(ownerId, runId).isPresent()) {
                    throw conflict("RUN_SHARE_ALREADY_ACTIVE");
                }
                var snapshot = snapshot(run);
                if (!digest(new SnapshotEnvelope(projectId, runId, snapshot)).equals(normalized.snapshotDigest())) {
                    throw conflict("RUN_SHARE_PREVIEW_CHANGED");
                }
                byte[] token = new byte[32];
                random.nextBytes(token);
                shares.insert(new JdbcRunShareStore.NewShare(UUID.randomUUID().toString(), ownerId,
                    projectId, runId, source.name(), Base64.getUrlEncoder().withoutPadding().encodeToString(token),
                    normalized.title(), normalized.description(), encode(snapshot.run()), snapshot.logText(),
                    normalized.requestId(), requestDigest));
                var created = shares.findReceiptByRequest(ownerId, normalized.requestId()).orElseThrow();
                return new PublishOutcome(true, ownerShare(created));
            });
        } catch (DuplicateKeyException failure) {
            // Reconciliation runs only after the failed transaction has rolled back and released its locks.
            if (!requestKeyConflict(failure)) throw failure;
            var winner = shares.findReceiptByRequest(ownerId, normalized.requestId());
            if (winner.isEmpty()) throw failure;
            return recovered(winner.get(), requestDigest);
        }
    }

    private com.manao.poc4.run.RunRecord requireTerminalRun(String ownerId, String projectId, String runId) {
        var run = runs.findRunForOwner(ownerId, projectId, runId)
            .orElseThrow(() -> new ApiException("RUN_NOT_FOUND", 404, "Run not found"));
        if (!RunStateReducer.isTerminal(run.state())) throw conflict("RUN_SHARE_NOT_TERMINAL");
        return run;
    }

    private static LockedProject requireProject(Optional<LockedProject> project) {
        var source = project.orElseThrow(() -> new ApiException("RUN_NOT_FOUND", 404, "Run not found"));
        if ("DELETING".equals(source.state())) throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        return source;
    }

    private SnapshotContent snapshot(com.manao.poc4.run.RunRecord run) {
        RunPolicy.RuntimeInfo runtime;
        try {
            runtime = RunPolicy.fromJson(run.policyJson()).runtime();
        } catch (IllegalStateException corruptPolicy) {
            throw internalError();
        }
        String runtimeLabel;
        if (runtime instanceof RunPolicy.RuntimeInfo.Java java) {
            runtimeLabel = "Java " + java.javaMajor() + " / Maven " + java.mavenMajor();
        } else if (runtime instanceof RunPolicy.RuntimeInfo.Python python) {
            runtimeLabel = "Python " + python.pythonVersion() + " / " + python.packageManager();
        } else if (runtime instanceof RunPolicy.RuntimeInfo.Node node) {
            runtimeLabel = "Node.js " + node.nodeMajor() + " / " + node.packageManager() + " " + node.pnpmMajor();
        } else {
            throw internalError();
        }
        String text = logs.loadChunks(run.id()).stream().map(RunLogWindow.Chunk::text).collect(Collectors.joining());
        return new SnapshotContent(new RunSnapshot(run.state().name(), run.exitCode(), run.createdAt(),
            run.startedAt(), run.finishedAt(), runtime.language(), runtimeLabel), text);
    }

    private static PublishRequest normalize(PublishRequest request) {
        if (request == null || request.requestId() == null
            || !request.requestId().matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            || request.snapshotDigest() == null || !request.snapshotDigest().matches("[0-9a-f]{64}")
            || request.title() == null) throw validationError();
        String title = request.title().trim();
        String description = request.description() == null ? "" : request.description().trim();
        if (title.isEmpty() || title.length() > 100 || description.length() > 2000) throw validationError();
        return new PublishRequest(UUID.fromString(request.requestId()).toString(), request.snapshotDigest(), title, description);
    }

    private static PublishOutcome recovered(ShareReceipt receipt, String requestDigest) {
        if (!receipt.requestDigest().equals(requestDigest)) throw conflict("RUN_SHARE_REQUEST_MISMATCH");
        return new PublishOutcome(false, ownerShare(receipt));
    }

    private static OwnerShare ownerShare(ShareReceipt receipt) {
        return new OwnerShare(receipt.id(), receipt.title(), receipt.sourceProjectName(), receipt.createdAt(),
            receipt.expiresAt(), receipt.status(), "ACTIVE".equals(receipt.status()) ? "/shares/" + receipt.token() : null);
    }

    private String digest(Object envelope) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(envelope)));
        } catch (JsonProcessingException | NoSuchAlgorithmException failure) {
            throw internalError();
        }
    }

    private String encode(Object value) {
        try { return json.writeValueAsString(value); }
        catch (JsonProcessingException failure) { throw internalError(); }
    }

    private static boolean requestKeyConflict(DuplicateKeyException failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof SQLException sql && sql.getErrorCode() == 1062 && "23000".equals(sql.getSQLState())
                && sql.getMessage() != null
                && sql.getMessage().matches("(?s).*for key '(?:[^']+\\.)?uq_run_share_request'.*")) return true;
        }
        return false;
    }

    private static ApiException conflict(String code) { return new ApiException(code, 409, "Run share conflict"); }
    private static ApiException internalError() { return new ApiException("INTERNAL_ERROR", 500, "Internal server error"); }
    private static ApiException validationError() { return new ApiException("VALIDATION_ERROR", 422, "Invalid run share request"); }
    private record SnapshotEnvelope(String projectId, String runId, SnapshotContent snapshot) {}
    private record RequestEnvelope(String projectId, String runId, String snapshotDigest, String title, String description) {}
}
