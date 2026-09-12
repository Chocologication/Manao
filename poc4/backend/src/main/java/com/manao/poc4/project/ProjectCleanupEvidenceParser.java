package com.manao.poc4.project;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Offline rules for turning cleanup evidence into VERIFIED or an explicit failure. */
public final class ProjectCleanupEvidenceParser {
    public record LedgerEntry(String invocationId, String ownerId, String projectId, String state,
                              List<String> runIds, Path ledgerPath) {}

    public record DbCounts(long projects, long operations, long runs, long tickets, long sessions,
                           long audits, long chunks) {
        public boolean empty() {
            return projects == 0 && operations == 0 && runs == 0 && tickets == 0 && sessions == 0
                && audits == 0 && chunks == 0;
        }
    }

    public record ClusterCounts(int jobs, int pods, int services, int pvcs, boolean forbidden) {
        public boolean empty() {
            return !forbidden && jobs == 0 && pods == 0 && services == 0 && pvcs == 0;
        }
    }

    public record Verdict(boolean verified, List<String> reasons) {}

    public static Verdict verdict(String expectedInvocation, Path expectedRoot, LedgerEntry entry,
                                  DbCounts db, ClusterCounts cluster, boolean runSnapshotPresent) {
        List<String> reasons = new ArrayList<>();
        if (!expectedInvocation.equals(entry.invocationId())) {
            reasons.add("UNKNOWN_INVOCATION");
        }
        if (entry.ownerId() == null || entry.ownerId().isBlank()) {
            reasons.add("UNKNOWN_OWNER");
        }
        if (entry.ledgerPath() == null || !entry.ledgerPath().normalize().startsWith(expectedRoot.normalize())) {
            reasons.add("ILLEGAL_PATH");
        }
        if (!runSnapshotPresent) {
            reasons.add("MISSING_RUN_SNAPSHOT");
        }
        if (cluster.forbidden()) {
            reasons.add("CLUSTER_FORBIDDEN");
        }
        if (!db.empty()) {
            reasons.add("DB_RESIDUE");
        }
        if (!cluster.empty()) {
            reasons.add("CLUSTER_RESIDUE");
        }
        if (!"API_CLEANED".equals(entry.state()) && !"VERIFIED".equals(entry.state())) {
            reasons.add("API_NOT_CLEANED");
        }
        return new Verdict(reasons.isEmpty(), List.copyOf(reasons));
    }

    public static Set<String> requiredTables() {
        return Set.of("project", "workspace_operation", "run", "log_ticket", "terminal_session",
            "terminal_audit", "run_log_chunk");
    }
}
