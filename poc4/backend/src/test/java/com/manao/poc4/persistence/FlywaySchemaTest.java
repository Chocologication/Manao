package com.manao.poc4.persistence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class FlywaySchemaTest {
    private Connection connection;
    private static final Instant TEST_NOW = Instant.parse("2026-01-01T00:00:00Z");

    @BeforeEach
    void migrateEmptySchema() throws Exception {
        String url = System.getenv().getOrDefault("MANAO_DB_URL", "jdbc:mysql://127.0.0.1:3306/manao_poc4_test");
        if (!url.startsWith("jdbc:mysql:")) {
            throw new AssertionError("REAL_MYSQL_REQUIRED: MANAO_DB_URL must be jdbc:mysql, got " + url);
        }
        try {
            connection = DriverManager.getConnection(url,
                System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"),
                System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""));
        } catch (SQLException ex) {
            throw new AssertionError("REAL_MYSQL_BLOCKED: cannot connect to test schema", ex);
        }
        try (Statement statement = connection.createStatement()) {
            statement.execute("DROP TABLE IF EXISTS terminal_audit, terminal_session, log_ticket, run_log_chunk, run, workspace_operation, project, app_user, instance_lease, flyway_schema_history");
        }
        Flyway.configure().dataSource(connection.getMetaData().getURL(),
                System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"),
                System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""))
            .locations("classpath:db/migration").load().migrate();
    }

    @Test
    void schemaRejectsDuplicateUsersAndActiveRuns() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        try (var insert = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash) VALUES (?, ?, ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision) VALUES (?, ?, ?, 'READY', 0)");
             var run = connection.prepareStatement("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version) VALUES (?, ?, 0, ?, '{}', 0)")) {
            insert.setString(1, userId); insert.setString(2, "alice"); insert.setString(3, "hash"); insert.executeUpdate();
            assertThatThrownBy(insert::executeUpdate).isInstanceOf(SQLException.class);
            project.setString(1, projectId); project.setString(2, userId); project.setString(3, "demo"); project.executeUpdate();
            run.setString(1, runId); run.setString(2, projectId); run.setString(3, "RUNNING"); run.executeUpdate();
            run.setString(1, UUID.randomUUID().toString());
            assertThatThrownBy(run::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaEnforcesChunkTicketAndLiveTerminalUniqueness() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        try (var s = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash) VALUES (?, 'bob', 'hash')")) { s.setString(1, userId); s.executeUpdate(); }
        try (var s = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision) VALUES (?, ?, 'p', 'READY', 0)")) { s.setString(1, projectId); s.setString(2, userId); s.executeUpdate(); }
        try (var s = connection.prepareStatement("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version) VALUES (?, ?, 0, 'SUCCEEDED', '{}', 0)")) { s.setString(1, runId); s.setString(2, projectId); s.executeUpdate(); }
        try (var chunk = connection.prepareStatement("INSERT INTO run_log_chunk(run_id, seq, text_utf8, byte_length) VALUES (?, 1, 'x', 1)");
             var ticket = connection.prepareStatement("INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at) VALUES ('hash1', ?, ?, ?, ?)");
             var session = connection.prepareStatement("INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at, version) VALUES (?, ?, ?, ?, 'LIVE', 'hash1', ?, 0)")) {
            chunk.setString(1, runId); chunk.executeUpdate(); assertThatThrownBy(chunk::executeUpdate).isInstanceOf(SQLException.class);
            ticket.setString(1, userId); ticket.setString(2, projectId); ticket.setString(3, runId); ticket.setObject(4, TEST_NOW.plus(Duration.ofMinutes(1))); ticket.executeUpdate();
            assertThatThrownBy(ticket::executeUpdate).isInstanceOf(SQLException.class);
            session.setString(1, UUID.randomUUID().toString()); session.setString(2, projectId); session.setString(3, runId); session.setString(4, userId); session.setObject(5, TEST_NOW.plus(Duration.ofMinutes(1))); session.executeUpdate();
            session.setString(1, UUID.randomUUID().toString()); assertThatThrownBy(session::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaAllowsOnlyOnePendingWorkspaceOperationPerProject() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash) VALUES (?, ?, 'hash')");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision) VALUES (?, ?, 'p', 'READY', 0)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state) VALUES (?, ?, 0, ?, ?, ?, ?, 'PENDING')")) {
            user.setString(1, userId); user.setString(2, "owner-" + userId); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "receipts/a"); operation.setString(6, "c".repeat(64)); operation.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(5, "receipts/b"); operation.setString(6, "d".repeat(64));
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaRejectsNonCanonicalWorkspaceDigests() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash) VALUES (?, ?, 'hash')");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision) VALUES (?, ?, 'digest', 'READY', 0)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state) VALUES (?, ?, 0, ?, ?, 'receipts/digest', ?, 'PENDING')")) {
            user.setString(1, userId); user.setString(2, "digest-owner-" + userId); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "NOT-A-SHA"); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64));
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(3, "A".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64));
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaPreventsWorkspaceDigestMutationAfterCreation() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String operationId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash) VALUES (?, ?, 'hash')");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision) VALUES (?, ?, 'immutable', 'READY', 0)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state) VALUES (?, ?, 0, ?, ?, 'receipts/immutable', ?, 'PENDING')")) {
            user.setString(1, userId); user.setString(2, "immutable-owner-" + userId); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.executeUpdate();
            operation.setString(1, operationId); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64)); operation.executeUpdate();
        }
        try (var update = connection.prepareStatement("UPDATE workspace_operation SET after_sha256 = ? WHERE id = ?")) {
            update.setString(1, "d".repeat(64)); update.setString(2, operationId);
            assertThatThrownBy(update::executeUpdate).isInstanceOf(SQLException.class);
        }
    }
}
