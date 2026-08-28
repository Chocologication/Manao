package com.manao.poc4.persistence;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

public final class Repositories {
    private final Connection connection;
    private final DatabaseClock clock;
    private final InstanceLeaseRepository instanceLease;
    private final WorkspaceOperationRepository workspaceOperations;
    private final Runs runs;
    private final Users users;
    private final Projects projects;
    private final Tickets tickets;
    private final TerminalSessions terminalSessions;
    private final TerminalAudits terminalAudits;

    private Repositories(Connection connection, DatabaseClock clock) {
        this.connection = connection;
        this.clock = clock;
        this.instanceLease = new InstanceLeaseRepository(connection, clock);
        this.workspaceOperations = new WorkspaceOperationRepository(connection, clock);
        this.runs = new Runs(connection, clock);
        this.users = new Users(connection, clock);
        this.projects = new Projects(connection, clock);
        this.tickets = new Tickets(connection, clock);
        this.terminalSessions = new TerminalSessions(connection, clock);
        this.terminalAudits = new TerminalAudits(connection, clock);
    }

    public static Repositories create(Connection connection, DatabaseClock clock) {
        return new Repositories(connection, clock);
    }

    public InstanceLeaseRepository instanceLease() { return instanceLease; }
    public WorkspaceOperationRepository workspaceOperations() { return workspaceOperations; }
    public Runs runs() { return runs; }
    public Users users() { return users; }
    public Projects projects() { return projects; }
    public Tickets tickets() { return tickets; }
    public TerminalSessions terminalSessions() { return terminalSessions; }
    public TerminalAudits terminalAudits() { return terminalAudits; }

    private static void rollback(Connection connection) {
        try { connection.rollback(); } catch (SQLException ignored) { }
    }

    private static void restoreAutoCommit(Connection connection) {
        try { connection.setAutoCommit(true); } catch (SQLException ignored) { }
    }

    public static final class Users {
        private final Connection connection;
        private final DatabaseClock clock;
        private Users(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }
        public void insert(String id, String username, String passwordHash) {
            try (var insert = connection.prepareStatement("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")) {
                insert.setString(1, id); insert.setString(2, username); insert.setString(3, passwordHash); insert.setTimestamp(4, Timestamp.from(clock.now())); insert.executeUpdate();
            } catch (SQLException ex) { throw new IllegalStateException("cannot insert user", ex); }
        }
    }

    public static final class Projects {
        private final Connection connection;
        private final DatabaseClock clock;
        private Projects(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }
        public void insert(String id, String ownerId, String name) {
            try (var insert = connection.prepareStatement("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, ?, 'READY', 0, ?, ?)")) {
                insert.setString(1, id); insert.setString(2, ownerId); insert.setString(3, name); insert.setTimestamp(4, Timestamp.from(clock.now())); insert.setTimestamp(5, Timestamp.from(clock.now())); insert.executeUpdate();
            } catch (SQLException ex) { throw new IllegalStateException("cannot insert project", ex); }
        }
        public boolean createForOwner(String id, String ownerId, String name) {
            try {
                connection.setAutoCommit(false);
                try (var owner = connection.prepareStatement("SELECT id FROM app_user WHERE id = ? FOR UPDATE")) {
                    owner.setString(1, ownerId);
                    try (var rows = owner.executeQuery()) {
                        if (!rows.next()) { connection.rollback(); return false; }
                    }
                }
                try (var count = connection.prepareStatement("SELECT COUNT(*) FROM project WHERE owner_id = ?")) {
                    count.setString(1, ownerId);
                    try (var rows = count.executeQuery()) {
                        if (!rows.next() || rows.getInt(1) >= 3) { connection.rollback(); return false; }
                    }
                }
                insert(id, ownerId, name);
                connection.commit();
                return true;
            } catch (SQLException ex) {
                rollback(connection);
                throw new IllegalStateException("cannot create owner project", ex);
            } finally { restoreAutoCommit(connection); }
        }
        public boolean existsForOwner(String projectId, String ownerId) {
            try (var select = connection.prepareStatement("SELECT 1 FROM project WHERE id = ? AND owner_id = ?")) {
                select.setString(1, projectId); select.setString(2, ownerId);
                try (var rows = select.executeQuery()) { return rows.next(); }
            } catch (SQLException ex) { throw new IllegalStateException("cannot find owner project", ex); }
        }
    }

    public static final class Tickets {
        private final Connection connection;
        private final DatabaseClock clock;
        private Tickets(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }
        public boolean consume(String ticketHash, String userId, String projectId, String runId) {
            try (var update = connection.prepareStatement("UPDATE log_ticket SET consumed_at = ? WHERE ticket_hash = ? AND user_id = ? AND project_id = ? AND run_id = ? AND consumed_at IS NULL AND expires_at > ?")) {
                update.setTimestamp(1, Timestamp.from(clock.now())); update.setString(2, ticketHash); update.setString(3, userId); update.setString(4, projectId); update.setString(5, runId); update.setTimestamp(6, Timestamp.from(clock.now()));
                return update.executeUpdate() == 1;
            } catch (SQLException ex) { throw new IllegalStateException("cannot consume log ticket", ex); }
        }
    }

    public static final class TerminalSessions {
        private final Connection connection;
        private final DatabaseClock clock;
        private TerminalSessions(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }
        public boolean expireReservations() {
            try (var update = connection.prepareStatement("UPDATE terminal_session SET state = 'EXPIRED', version = version + 1 WHERE state = 'RESERVED' AND expires_at <= ?")) {
                update.setTimestamp(1, Timestamp.from(clock.now())); return update.executeUpdate() >= 0;
            } catch (SQLException ex) { throw new IllegalStateException("cannot expire terminal reservations", ex); }
        }
        public boolean transition(String sessionId, TerminalSessionState expected, TerminalSessionState next) {
            try (var update = connection.prepareStatement("UPDATE terminal_session SET state = ?, version = version + 1 WHERE id = ? AND state = ?")) {
                update.setString(1, next.name()); update.setString(2, sessionId); update.setString(3, expected.name()); return update.executeUpdate() == 1;
            } catch (SQLException ex) { throw new IllegalStateException("cannot transition terminal session", ex); }
        }
    }

    public static final class TerminalAudits {
        private final Connection connection;
        private final DatabaseClock clock;
        private TerminalAudits(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }
        public boolean settle(String auditId, String expectedState, String finalState, int exitCode) {
            try (var update = connection.prepareStatement("UPDATE terminal_audit SET state = ?, finished_at = ?, exit_code = ? WHERE id = ? AND state = ?")) {
                update.setString(1, finalState); update.setTimestamp(2, Timestamp.from(clock.now())); update.setInt(3, exitCode); update.setString(4, auditId); update.setString(5, expectedState); return update.executeUpdate() == 1;
            } catch (SQLException ex) { throw new IllegalStateException("cannot settle terminal audit", ex); }
        }
    }

    public static final class Runs {
        private final Connection connection;
        private final DatabaseClock clock;

        private Runs(Connection connection, DatabaseClock clock) { this.connection = connection; this.clock = clock; }

        public void insert(String id, String projectId, long requestedRevision, RunState state, String policyJson) {
            try (var insert = connection.prepareStatement("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version) VALUES (?, ?, ?, ?, ?, 0)")) {
                insert.setString(1, id); insert.setString(2, projectId); insert.setLong(3, requestedRevision); insert.setString(4, state.name()); insert.setString(5, policyJson); insert.executeUpdate();
            } catch (SQLException ex) { throw new IllegalStateException("cannot insert run", ex); }
        }

        public boolean transition(String runId, String projectId, long expectedVersion, RunState nextState, RunState... allowedStates) {
            if (allowedStates.length == 0) throw new IllegalArgumentException("at least one allowed state is required");
            String placeholders = Arrays.stream(allowedStates).map(state -> "?").collect(Collectors.joining(", "));
            String sql = "UPDATE run SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND project_id = ? AND version = ? AND state IN (" + placeholders + ")";
            try (var update = connection.prepareStatement(sql)) {
                update.setString(1, nextState.name()); update.setTimestamp(2, Timestamp.from(clock.now())); update.setString(3, runId); update.setString(4, projectId); update.setLong(5, expectedVersion);
                for (int i = 0; i < allowedStates.length; i++) update.setString(6 + i, allowedStates[i].name());
                return update.executeUpdate() == 1;
            } catch (SQLException ex) { throw new IllegalStateException("cannot transition run", ex); }
        }
    }
}
