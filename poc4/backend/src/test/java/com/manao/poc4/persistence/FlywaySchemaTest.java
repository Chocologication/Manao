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
import org.flywaydb.core.api.FlywayException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class FlywaySchemaTest {
    private Connection connection;
    private static final Instant TEST_NOW = Instant.parse("2026-01-01T00:00:00Z");

    @AfterEach
    void closeConnection() throws Exception {
        if (connection != null) connection.close();
    }

    @BeforeEach
    void migrateEmptySchema() throws Exception {
        String url = System.getenv().getOrDefault("MANAO_DB_URL", "jdbc:mysql://127.0.0.1:3306/manao_poc4_schema_test");
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
        try (var insert = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, ?, 'READY', 0, ?, ?)");
             var run = connection.prepareStatement("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version, updated_at, created_at, fencing_token) VALUES (?, ?, 0, ?, '{}', 0, ?, ?, 1)")) {
            insert.setString(1, userId); insert.setString(2, "alice"); insert.setString(3, "hash"); insert.setObject(4, TEST_NOW); insert.executeUpdate();
            assertThatThrownBy(insert::executeUpdate).isInstanceOf(SQLException.class);
            project.setString(1, projectId); project.setString(2, userId); project.setString(3, "demo"); project.setObject(4, TEST_NOW); project.setObject(5, TEST_NOW); project.executeUpdate();
            run.setString(1, runId); run.setString(2, projectId); run.setString(3, "RUNNING"); run.setObject(4, TEST_NOW); run.setObject(5, TEST_NOW); run.executeUpdate();
            run.setString(1, UUID.randomUUID().toString());
            assertThatThrownBy(run::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaEnforcesChunkTicketAndLiveTerminalUniqueness() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        try (var s = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, 'bob', 'hash', ?)")) { s.setString(1, userId); s.setObject(2, TEST_NOW); s.executeUpdate(); }
        try (var s = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'p', 'READY', 0, ?, ?)")) { s.setString(1, projectId); s.setString(2, userId); s.setObject(3, TEST_NOW); s.setObject(4, TEST_NOW); s.executeUpdate(); }
        try (var s = connection.prepareStatement("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version, updated_at, created_at, fencing_token) VALUES (?, ?, 0, 'SUCCEEDED', '{}', 0, ?, ?, 1)")) { s.setString(1, runId); s.setString(2, projectId); s.setObject(3, TEST_NOW); s.setObject(4, TEST_NOW); s.executeUpdate(); }
        try (var chunk = connection.prepareStatement("INSERT INTO run_log_chunk(run_id, seq, text_utf8, byte_length, created_at) VALUES (?, 1, 'x', 1, ?)");
             var ticket = connection.prepareStatement("INSERT INTO log_ticket(ticket_hash, user_id, project_id, run_id, expires_at) VALUES ('hash1', ?, ?, ?, ?)");
             var session = connection.prepareStatement("INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at, version) VALUES (?, ?, ?, ?, 'LIVE', 'hash1', ?, 0)")) {
            chunk.setString(1, runId); chunk.setObject(2, TEST_NOW); chunk.executeUpdate(); assertThatThrownBy(chunk::executeUpdate).isInstanceOf(SQLException.class);
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
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'p', 'READY', 0, ?, ?)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, 0, ?, ?, ?, ?, 'PENDING', ?)") ) {
            user.setString(1, userId); user.setString(2, "owner-" + userId); user.setObject(3, TEST_NOW); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.setObject(3, TEST_NOW); project.setObject(4, TEST_NOW); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "receipts/a"); operation.setString(6, "c".repeat(64)); operation.setObject(7, TEST_NOW); operation.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(5, "receipts/b"); operation.setString(6, "d".repeat(64));
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaRejectsNonCanonicalWorkspaceDigests() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'digest', 'READY', 0, ?, ?)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, 0, ?, ?, 'receipts/digest', ?, 'PENDING', ?)") ) {
            user.setString(1, userId); user.setString(2, "digest-owner-" + userId); user.setObject(3, TEST_NOW); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.setObject(3, TEST_NOW); project.setObject(4, TEST_NOW); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "NOT-A-SHA"); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64)); operation.setObject(6, TEST_NOW);
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(3, "A".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64)); operation.setObject(6, TEST_NOW);
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaPreventsWorkspaceDigestMutationAfterCreation() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        String operationId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'immutable', 'READY', 0, ?, ?)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, 0, ?, ?, 'receipts/immutable', ?, 'PENDING', ?)") ) {
            user.setString(1, userId); user.setString(2, "immutable-owner-" + userId); user.setObject(3, TEST_NOW); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.setObject(3, TEST_NOW); project.setObject(4, TEST_NOW); project.executeUpdate();
            operation.setString(1, operationId); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setString(5, "c".repeat(64)); operation.setObject(6, TEST_NOW); operation.executeUpdate();
        }
        try (var update = connection.prepareStatement("UPDATE workspace_operation SET after_sha256 = ? WHERE id = ?")) {
            update.setString(1, "d".repeat(64)); update.setString(2, operationId);
            assertThatThrownBy(update::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void schemaRemovesDatabaseClockDefaultsAndRequiresReceiptDigest() throws Exception {
        try (var columns = connection.prepareStatement("""
                SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT, EXTRA, IS_NULLABLE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND ((TABLE_NAME = 'app_user' AND COLUMN_NAME = 'created_at')
                    OR (TABLE_NAME = 'project' AND COLUMN_NAME IN ('created_at', 'updated_at'))
                    OR (TABLE_NAME = 'workspace_operation' AND COLUMN_NAME = 'created_at')
                    OR (TABLE_NAME = 'run' AND COLUMN_NAME = 'updated_at')
                    OR (TABLE_NAME = 'run_log_chunk' AND COLUMN_NAME = 'created_at')
                    OR (TABLE_NAME = 'workspace_operation' AND COLUMN_NAME = 'receipt_sha256'))
                """)) {
            try (var rows = columns.executeQuery()) {
                int count = 0;
                while (rows.next()) {
                    count++;
                    String table = rows.getString("TABLE_NAME");
                    String column = rows.getString("COLUMN_NAME");
                    if (table.equals("workspace_operation") && column.equals("receipt_sha256")) {
                        assertThat(rows.getString("IS_NULLABLE")).isEqualTo("NO");
                    } else {
                        assertThat(rows.getString("COLUMN_DEFAULT")).isNull();
                        assertThat(rows.getString("EXTRA")).doesNotContainIgnoringCase("on update");
                    }
                }
                assertThat(count).isEqualTo(7);
            }
        }
    }

    @Test
    void schemaRejectsNullReceiptDigest() throws Exception {
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'null-receipt', 'READY', 0, ?, ?)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, 0, ?, ?, 'receipts/null', NULL, 'PENDING', ?)")) {
            user.setString(1, userId); user.setString(2, "null-receipt-owner-" + userId); user.setObject(3, TEST_NOW); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.setObject(3, TEST_NOW); project.setObject(4, TEST_NOW); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setObject(5, TEST_NOW);
            assertThatThrownBy(operation::executeUpdate).isInstanceOf(SQLException.class);
        }
    }

    @Test
    void upgradeFailsClosedWhenLegacyReceiptDigestIsNull() throws Exception {
        try (Statement statement = connection.createStatement()) {
            statement.execute("DROP TABLE IF EXISTS terminal_audit, terminal_session, log_ticket, run_log_chunk, run, workspace_operation, project, app_user, instance_lease, flyway_schema_history");
        }
        Flyway.configure().dataSource(connection.getMetaData().getURL(),
                System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"),
                System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""))
            .target("3").locations("classpath:db/migration").load().migrate();
        String userId = UUID.randomUUID().toString();
        String projectId = UUID.randomUUID().toString();
        try (var user = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)");
             var project = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'legacy-null', 'READY', 0, ?, ?)");
             var operation = connection.prepareStatement("INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256, receipt_path, receipt_sha256, state, created_at) VALUES (?, ?, 0, ?, ?, 'receipts/legacy-null', NULL, 'PENDING', ?)")) {
            user.setString(1, userId); user.setString(2, "legacy-null-owner-" + userId); user.setObject(3, TEST_NOW); user.executeUpdate();
            project.setString(1, projectId); project.setString(2, userId); project.setObject(3, TEST_NOW); project.setObject(4, TEST_NOW); project.executeUpdate();
            operation.setString(1, UUID.randomUUID().toString()); operation.setString(2, projectId); operation.setString(3, "a".repeat(64)); operation.setString(4, "b".repeat(64)); operation.setObject(5, TEST_NOW); operation.executeUpdate();
        }
        assertThatThrownBy(() -> Flyway.configure().dataSource(connection.getMetaData().getURL(),
                System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao"),
                System.getenv().getOrDefault("MANAO_DB_PASSWORD", ""))
            .locations("classpath:db/migration").load().migrate())
            .isInstanceOf(FlywayException.class);
    }
}
