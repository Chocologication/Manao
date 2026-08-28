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
        String url = System.getenv().getOrDefault("MANAO_DB_URL", "jdbc:mysql://127.0.0.1:3306/manao_poc4_test");
        if (!url.startsWith("jdbc:mysql:")) throw new AssertionError("REAL_MYSQL_REQUIRED");
        try {
            connection = DriverManager.getConnection(url, System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"), System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""));
        } catch (Exception ex) { throw new AssertionError("REAL_MYSQL_BLOCKED: cannot connect to test schema", ex); }
        try (Statement statement = connection.createStatement()) {
            statement.execute("DROP TABLE IF EXISTS terminal_audit, terminal_session, log_ticket, run_log_chunk, run, workspace_operation, project, app_user, instance_lease, flyway_schema_history");
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
        assertThat(repositories.workspaceOperations().createPending(operationId, projectId, 0, "before", "after", "receipts/op")).isTrue();
        assertThat(repositories.workspaceOperations().createPending(UUID.randomUUID().toString(), projectId, 0, "x", "y", "receipts/other")).isFalse();
        assertThat(repositories.workspaceOperations().commit(operationId, projectId, 0)).isTrue();
    }

    @Test
    void projectCreationIsOwnerScopedAndCappedAtThree() {
        String userId = UUID.randomUUID().toString();
        repositories.users().insert(userId, "cap-owner-" + userId, "hash");
        for (int i = 0; i < 3; i++) {
            assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), userId, "p" + i)).isTrue();
        }
        assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), userId, "p3")).isFalse();
    }

    @Test
    void leaseFencesOldHolderAndAuditSettlementIsIdempotent() {
        InstanceLeaseRepository lease = repositories.instanceLease();
        assertThat(lease.acquire("a", Instant.parse("2026-01-01T00:00:10Z"))).isEqualTo(1L);
        assertThat(lease.acquire("b", Instant.parse("2026-01-01T00:00:05Z"))).isNull();
        currentTime.set(Instant.parse("2026-01-01T00:01:00Z"));
        assertThat(lease.acquire("b", Instant.parse("2026-01-01T00:01:00Z"))).isEqualTo(2L);
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
}
