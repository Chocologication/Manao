package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

class ProjectCleanupEvidenceParserTest {
    private static final Path ROOT = Path.of("C:/tmp/stage6-cleanup/inv-1");
    private static final ProjectCleanupEvidenceParser.LedgerEntry ENTRY =
        new ProjectCleanupEvidenceParser.LedgerEntry("inv-1", "owner-a", "p1", "API_CLEANED",
            List.of("run-1"), ROOT.resolve("entry-1.json"));
    private static final ProjectCleanupEvidenceParser.DbCounts EMPTY_DB =
        new ProjectCleanupEvidenceParser.DbCounts(0, 0, 0, 0, 0, 0, 0);
    private static final ProjectCleanupEvidenceParser.ClusterCounts EMPTY_CLUSTER =
        new ProjectCleanupEvidenceParser.ClusterCounts(0, 0, 0, 0, false);

    @Test
    void emptyEvidenceForTheRegisteredInvocationIsVerified() {
        ProjectCleanupEvidenceParser.Verdict verdict = ProjectCleanupEvidenceParser.verdict(
            "inv-1", ROOT, ENTRY, EMPTY_DB, EMPTY_CLUSTER, true);
        assertThat(verdict.verified()).isTrue();
        assertThat(verdict.reasons()).isEmpty();
    }

    @Test
    void unknownInvocationOwnerPathOrMissingRunSnapshotIsNotVerified() {
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-other", ROOT, ENTRY, EMPTY_DB, EMPTY_CLUSTER, true)
            .reasons()).contains("UNKNOWN_INVOCATION");
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-1", ROOT,
            new ProjectCleanupEvidenceParser.LedgerEntry("inv-1", "", "p1", "API_CLEANED", List.of(), ENTRY.ledgerPath()),
            EMPTY_DB, EMPTY_CLUSTER, true).reasons()).contains("UNKNOWN_OWNER");
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-1", ROOT,
            new ProjectCleanupEvidenceParser.LedgerEntry("inv-1", "owner-a", "p1", "API_CLEANED", List.of(),
                Path.of("C:/tmp/other/entry.json")),
            EMPTY_DB, EMPTY_CLUSTER, true).reasons()).contains("ILLEGAL_PATH");
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-1", ROOT, ENTRY, EMPTY_DB, EMPTY_CLUSTER, false)
            .reasons()).contains("MISSING_RUN_SNAPSHOT");
    }

    @Test
    void forbiddenReadsAndApi404WithResidueAreNotVerified() {
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-1", ROOT, ENTRY, EMPTY_DB,
            new ProjectCleanupEvidenceParser.ClusterCounts(0, 0, 0, 0, true), true)
            .reasons()).contains("CLUSTER_FORBIDDEN");
        assertThat(ProjectCleanupEvidenceParser.verdict("inv-1", ROOT, ENTRY,
            new ProjectCleanupEvidenceParser.DbCounts(1, 0, 0, 0, 0, 0, 0),
            new ProjectCleanupEvidenceParser.ClusterCounts(0, 1, 0, 1, false), true)
            .verified()).isFalse();
    }

    @Test
    void requiredTablesAreTheSevenDependentRelations() {
        assertThat(ProjectCleanupEvidenceParser.requiredTables()).containsExactlyInAnyOrder(
            "project", "workspace_operation", "run", "log_ticket", "terminal_session", "terminal_audit",
            "run_log_chunk");
    }
}
