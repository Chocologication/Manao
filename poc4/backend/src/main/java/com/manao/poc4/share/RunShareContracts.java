package com.manao.poc4.share;

import java.time.Instant;
import java.util.List;

/** Fixed display contracts; a public share never exposes a RunRecord or RunPolicy. */
public final class RunShareContracts {
    private RunShareContracts() {}

    public record RunSnapshot(String state, Integer exitCode, Instant createdAt,
        Instant startedAt, Instant finishedAt, String language, String runtimeLabel) {}
    public record SnapshotContent(RunSnapshot run, String logText) {}
    public record PublishRequest(String requestId, String snapshotDigest,
        String title, String description) {}
    public record OwnerShare(String id, String title, String sourceProjectName,
        Instant createdAt, Instant expiresAt, String status, String sharePath) {}
    public record Preview(String kind, SnapshotContent snapshot,
        String snapshotDigest, OwnerShare share) {}
    public record PublishOutcome(boolean created, OwnerShare share) {}
    public record PublicShare(String title, String description,
        Instant createdAt, Instant expiresAt, SnapshotContent snapshot) {}
    public record SharePage(List<OwnerShare> items, String nextCursor) {}
}
