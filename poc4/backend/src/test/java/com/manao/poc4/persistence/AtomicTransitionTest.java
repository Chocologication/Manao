package com.manao.poc4.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.flywaydb.core.Flyway;

class AtomicTransitionTest {
    private Connection connection;
    private Repositories repositories;
    private AtomicReference<Instant> currentTime;

    @BeforeEach
    void setUp() throws Exception {
        String url = System.getenv().getOrDefault("MANAO_DB_URL", "jdbc:mysql://127.0.0.1:3306/manao_poc4_atomic_test");
        if (!url.startsWith("jdbc:mysql:")) throw new AssertionError("REAL_MYSQL_REQUIRED");
        try {
            connection = DriverManager.getConnection(url, System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"), System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""));
        } catch (Exception ex) { throw new AssertionError("REAL_MYSQL_BLOCKED: cannot connect to test schema", ex); }
        try (Statement statement = connection.createStatement()) {
            statement.execute("DROP TABLE IF EXISTS project_storage_binding, terminal_audit, terminal_session, log_ticket, run_log_chunk, run, workspace_operation, project, app_user, instance_lease, flyway_schema_history");
        }
        Flyway.configure().dataSource(url, System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"), System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""))
            .locations("classpath:db/migration").load().migrate();
        currentTime = new AtomicReference<>(Instant.parse("2026-01-01T00:00:00Z"));
        repositories = Repositories.create(connection, new DatabaseClock(new Clock() {
            public ZoneOffset getZone() { return ZoneOffset.UTC; }
            public Clock withZone(java.time.ZoneId zone) { return this; }
            public Instant instant() { return currentTime.get(); }
        }));
    }

    @Test
    void runVersionTransitionAndWorkspacePendingAreCompareAndSet() {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "project-" + projectId);
        repositories.runs().insert(runId, projectId, 0, RunState.STARTING, "{}");
        assertThat(repositories.runs().transition(runId, projectId, 0, RunState.RUNNING, RunState.STARTING)).isTrue();
        assertThat(repositories.runs().transition(runId, projectId, 0, RunState.STOPPING, RunState.RUNNING)).isFalse();
        String operationId = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(operationId, projectId, 0,
            "a".repeat(64), "b".repeat(64), "receipts/op", "c".repeat(64))).isTrue();
        assertThat(repositories.workspaceOperations().createPending(UUID.randomUUID().toString(), projectId, 0,
            "d".repeat(64), "e".repeat(64), "receipts/other", "f".repeat(64))).isFalse();
        assertThat(repositories.workspaceOperations().commit(operationId, projectId, 0)).isTrue();
    }

    @Test
    void projectCreationIsOwnerScopedAndCappedAtEight() {
        String userId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "cap-owner-" + userId, "hash");
        for (int i = 0; i < 8; i++) {
            assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), userId, "p" + i)).isTrue();
        }
        assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), userId, "p8")).isFalse();
    }

    @Test
    void userAndProjectTimestampsUseInjectedDatabaseClock() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "clock-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "clock-project-" + projectId);
        try (var query = connection.prepareStatement("SELECT u.created_at AS user_created, p.created_at AS project_created, p.updated_at AS project_updated FROM app_user u JOIN project p ON p.owner_id = u.id WHERE u.id = ? AND p.id = ?")) {
            query.setString(1, userId); query.setString(2, projectId);
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getTimestamp("user_created").toInstant()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
                assertThat(rows.getTimestamp("project_created").toInstant()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
                assertThat(rows.getTimestamp("project_updated").toInstant()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
            }
        }
    }

    @Test
    void runInsertUsesInjectedDatabaseClockForUpdatedAt() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "run-clock-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "run-clock-project-" + projectId);
        repositories.runs().insert(runId, projectId, 0, RunState.STARTING, "{}");
        try (var query = connection.prepareStatement("SELECT updated_at FROM run WHERE id = ?")) {
            query.setString(1, runId);
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getTimestamp(1).toInstant()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
            }
        }
    }

    @Test
    void workspaceCommitUsesInjectedDatabaseClockForProjectUpdatedAt() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "commit-clock-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "commit-clock-project-" + projectId);
        String operationId = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(operationId, projectId, 0,
            "a".repeat(64), "b".repeat(64), "receipts/commit-clock", "c".repeat(64))).isTrue();
        Instant committedAt = Instant.parse("2026-01-01T00:02:00Z");
        currentTime.set(committedAt);
        assertThat(repositories.workspaceOperations().commit(operationId, projectId, 0)).isTrue();
        try (var query = connection.prepareStatement("SELECT updated_at FROM project WHERE id = ?")) {
            query.setString(1, projectId);
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getTimestamp(1).toInstant()).isEqualTo(committedAt);
            }
        }
    }

    @Test
    void leaseFencesExpiredHolderAndRejectsNonFutureExpiry() {
        InstanceLeaseRepository lease = repositories.instanceLease();
        assertThat(lease.acquire("a", Instant.parse("2026-01-01T00:00:10Z"))).isEqualTo(1L);
        assertThat(lease.acquire("b", Instant.parse("2026-01-01T00:00:05Z"))).isNull();
        currentTime.set(Instant.parse("2026-01-01T00:01:00Z"));
        org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> lease.acquire("b", Instant.parse("2026-01-01T00:01:00Z")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(lease.acquire("b", Instant.parse("2026-01-01T00:01:10Z"))).isEqualTo(2L);
        assertThat(lease.renew("a", 1L, Instant.parse("2026-01-01T00:02:00Z"))).isFalse();
        assertThat(lease.renew("b", 2L, Instant.parse("2026-01-01T00:03:00Z"))).isTrue();
    }

    @Test
    void ticketConsumeAndAuditSettlementAreSingleUse() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        String ticketHash = "c".repeat(64);
        String sessionId = UUID.randomUUID().toString();
        String auditId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "audit-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "audit-project-" + projectId);
        repositories.runs().insert(runId, projectId, 0, RunState.RUNNING, "{}");
        try (var ticket = connection.prepareStatement("INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at) VALUES (?, ?, ?, ?, ?)");
             var session = connection.prepareStatement("INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at, version) VALUES (?, ?, ?, ?, 'LIVE', ?, ?, 0)");
             var audit = connection.prepareStatement("INSERT INTO terminal_audit(id, session_id, project_id, run_id, user_id, command, state, started_at, trust_level) VALUES (?, ?, ?, ?, ?, 'redacted', 'RUNNING', ?, 'LOW')")) {
            ticket.setString(1, ticketHash); ticket.setString(2, userId); ticket.setString(3, projectId); ticket.setString(4, runId); ticket.setObject(5, Instant.parse("2026-01-01T00:01:00Z")); ticket.executeUpdate();
            session.setString(1, sessionId); session.setString(2, projectId); session.setString(3, runId); session.setString(4, userId); session.setString(5, ticketHash); session.setObject(6, Instant.parse("2026-01-01T00:01:00Z")); session.executeUpdate();
            audit.setString(1, auditId); audit.setString(2, sessionId); audit.setString(3, projectId); audit.setString(4, runId); audit.setString(5, userId); audit.setObject(6, Instant.parse("2026-01-01T00:00:00Z")); audit.executeUpdate();
        }
        assertThat(repositories.tickets().consume(ticketHash, userId, projectId, runId)).isTrue();
        assertThat(repositories.tickets().consume(ticketHash, userId, projectId, runId)).isFalse();
        assertThat(repositories.terminalAudits().settle(auditId, "RUNNING", "CLOSED", 0)).isTrue();
        assertThat(repositories.terminalAudits().settle(auditId, "RUNNING", "CLOSED", 1)).isFalse();
    }

    @Test
    void workspaceOperationValidatesDigestsAndAllowsNewPendingAfterReconciliationFailure() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "workspace-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "workspace-project-" + projectId);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> repositories.workspaceOperations().createPending(
            UUID.randomUUID().toString(), projectId, 0, "before", "b".repeat(64), "receipts/invalid", "c".repeat(64)))
            .isInstanceOf(IllegalArgumentException.class);
        String failedId = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(failedId, projectId, 0,
            "a".repeat(64), "b".repeat(64), "receipts/failed", "c".repeat(64))).isTrue();
        assertThat(repositories.workspaceOperations().pendingForProject(projectId)).extracting(
            WorkspaceOperationRepository.PendingOperation::id).containsExactly(failedId);
        assertThat(repositories.workspaceOperations().pendingForProject(projectId).get(0).receiptSha256())
            .isEqualTo("c".repeat(64));
        assertThat(repositories.workspaceOperations().failReconciliation(failedId, projectId)).isTrue();
        assertThat(repositories.workspaceOperations().failReconciliation(failedId, projectId)).isFalse();
        String nextId = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(nextId, projectId, 0,
            "d".repeat(64), "e".repeat(64), "receipts/next", "f".repeat(64))).isTrue();
        assertThat(repositories.workspaceOperations().pendingForProject(projectId)).extracting(
            WorkspaceOperationRepository.PendingOperation::id).containsExactly(nextId);
    }

    @Test
    void nonDuplicateWorkspaceSqlErrorsAreNotReportedAsDuplicate() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> repositories.workspaceOperations().createPending(
            UUID.randomUUID().toString(), "missing-project", 0,
            "a".repeat(64), "b".repeat(64), "receipts/missing", "c".repeat(64)))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void dependencyOperationsBindRequestDigestsAndReconciledCommitsRecoverExactlyTheirFailure() {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "deps-owner-" + userId, "hash");
        repositories.projects().insert(projectId, userId, "deps-project-" + projectId);
        String digest = "1".repeat(64);

        // Dependency rows require the request digest; the digest binds the exact request intent.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> repositories.workspaceOperations().createPending(
            UUID.randomUUID().toString(), projectId, 0, "a".repeat(64), "b".repeat(64), "receipts/py",
            "c".repeat(64), "PYTHON_DEPENDENCIES", null))
            .isInstanceOf(IllegalArgumentException.class);
        String first = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(first, projectId, 0,
            "a".repeat(64), "b".repeat(64), "receipts/py-first", "c".repeat(64), "PYTHON_DEPENDENCIES", digest)).isTrue();
        assertThat(repositories.workspaceOperations().createPending(first, projectId, 0,
            "a".repeat(64), "b".repeat(64), "receipts/py-dup", "c".repeat(64), "PYTHON_DEPENDENCIES", digest)).isFalse();
        WorkspaceOperationRepository.Operation pending = repositories.workspaceOperations()
            .findOperation(projectId, first).orElseThrow();
        assertThat(pending.state()).isEqualTo("PENDING");
        assertThat(pending.operationKind()).isEqualTo("PYTHON_DEPENDENCIES");
        assertThat(pending.requestSha256()).isEqualTo(digest);
        assertThat(repositories.workspaceOperations().findOperation(projectId, UUID.randomUUID().toString())).isEmpty();

        // A READY project accepts the reconciled commit; the row answers COMMITTED afterwards.
        assertThat(repositories.workspaceOperations().commitReconciled(first, projectId, 0)).isTrue();
        WorkspaceOperationRepository.Operation committed = repositories.workspaceOperations()
            .findOperation(projectId, first).orElseThrow();
        assertThat(committed.state()).isEqualTo("COMMITTED");
        assertThat(repositories.workspaceOperations().pendingForProject(projectId)).isEmpty();

        // Exactly this reconciliation failure is lifted in the same transaction.
        String second = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(second, projectId, 1,
            "d".repeat(64), "e".repeat(64), "receipts/py-second", "f".repeat(64), "PYTHON_DEPENDENCIES", digest)).isTrue();
        failProject(projectId, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(repositories.workspaceOperations().commitReconciled(second, projectId, 1)).isTrue();
        assertThat(projectState(projectId, "state")).isEqualTo("READY");
        assertThat(projectState(projectId, "failure_reason")).isNull();
        assertThat(revisionOf(projectId)).isEqualTo(2);

        // Other failures and DELETING stay locked and keep the operation PENDING; CREATING is
        // never reconciled and never promoted to READY.
        String third = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(third, projectId, 2,
            "1".repeat(64), "2".repeat(64), "receipts/py-third", "3".repeat(64), "PYTHON_DEPENDENCIES", digest)).isTrue();
        jdbcUpdate("UPDATE project SET state = 'CREATING', failure_reason = NULL WHERE id = ?", projectId);
        assertThat(repositories.workspaceOperations().commitReconciled(third, projectId, 2)).isFalse();
        assertThat(repositories.workspaceOperations().findOperation(projectId, third).orElseThrow().state())
            .isEqualTo("PENDING");
        assertThat(projectState(projectId, "state")).isEqualTo("CREATING");
        assertThat(revisionOf(projectId)).isEqualTo(2);
        failProject(projectId, "CREATION_FAILED");
        assertThat(repositories.workspaceOperations().commitReconciled(third, projectId, 2)).isFalse();
        assertThat(repositories.workspaceOperations().findOperation(projectId, third).orElseThrow().state())
            .isEqualTo("PENDING");
        assertThat(revisionOf(projectId)).isEqualTo(2);
        markDeleting(projectId);
        assertThat(repositories.workspaceOperations().commitReconciled(third, projectId, 2)).isFalse();
        assertThat(repositories.workspaceOperations().findOperation(projectId, third).orElseThrow().state())
            .isEqualTo("PENDING");

        // An active run fences the reconciled commit; a foreign FILE kind never enters it.
        jdbcUpdate("UPDATE project SET state = 'READY', failure_reason = NULL WHERE id = ?", projectId);
        repositories.runs().insert(UUID.randomUUID().toString(), projectId, 2, RunState.RUNNING, "{}");
        assertThat(repositories.workspaceOperations().commitReconciled(third, projectId, 2)).isFalse();
        assertThat(repositories.workspaceOperations().findOperation(projectId, third).orElseThrow().state())
            .isEqualTo("PENDING");
        jdbcUpdate("DELETE FROM run WHERE project_id = ?", projectId);
        assertThat(repositories.workspaceOperations().commitReconciled(third, projectId, 2)).isTrue();
        assertThat(revisionOf(projectId)).isEqualTo(3);

        String fileOp = UUID.randomUUID().toString();
        assertThat(repositories.workspaceOperations().createPending(fileOp, projectId, 3,
            "4".repeat(64), "5".repeat(64), "receipts/file", "6".repeat(64))).isTrue();
        assertThat(repositories.workspaceOperations().commitReconciled(fileOp, projectId, 3)).isFalse();
        assertThat(repositories.workspaceOperations().commit(fileOp, projectId, 3)).isTrue();
        assertThat(repositories.workspaceOperations().findOperation(projectId, fileOp).orElseThrow().operationKind())
            .isEqualTo("FILE");
        assertThat(repositories.workspaceOperations().findOperation(projectId, fileOp).orElseThrow().requestSha256())
            .isNull();
    }

    private void jdbcUpdate(String sql, Object... args) {
        try (var update = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) update.setObject(i + 1, args[i]);
            update.executeUpdate();
        } catch (java.sql.SQLException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private void failProject(String projectId, String failureReason) {
        jdbcUpdate("UPDATE project SET state = 'FAILED', failure_reason = ? WHERE id = ?", failureReason, projectId);
    }

    private void markDeleting(String projectId) {
        jdbcUpdate("UPDATE project SET state = 'DELETING' WHERE id = ?", projectId);
    }

    private long revisionOf(String projectId) {
        return Long.parseLong(projectState(projectId, "workspace_revision"));
    }

    private String projectState(String projectId, String column) {
        try (var query = connection.prepareStatement("SELECT " + column + " FROM project WHERE id = ?")) {
            query.setString(1, projectId);
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                Object value = rows.getObject(1);
                return value == null ? null : value.toString();
            }
        } catch (java.sql.SQLException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
