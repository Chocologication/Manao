package com.manao.poc4.persistence;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;

/**
 * Legacy raw-connection lease implementation, kept only for the persistence repository tests.
 *
 * @deprecated Production fencing goes through {@code com.manao.poc4.run.JdbcRunStore}, which owns
 *     the single {@code instance_lease} row ("backend"), renews the lease inside markRunning and
 *     settle, and bumps the token only when the holder changes. Do not add production callers.
 */
@Deprecated
public final class InstanceLeaseRepository {
    private static final String LEASE_ID = "backend-authority";
    private final Connection connection;
    private final DatabaseClock clock;

    InstanceLeaseRepository(Connection connection, DatabaseClock clock) {
        this.connection = connection;
        this.clock = clock;
    }

    public Long acquire(String holderId, Instant expiresAt) {
        requireFutureExpiry(expiresAt);
        try {
            connection.setAutoCommit(false);
            Long currentToken = null;
            try (var select = connection.prepareStatement("SELECT holder_id, fencing_token, expires_at FROM instance_lease WHERE id = ? FOR UPDATE")) {
                select.setString(1, LEASE_ID);
                try (var rows = select.executeQuery()) {
                    if (rows.next()) {
                        if (rows.getTimestamp("expires_at").toInstant().isAfter(clock.now())
                            && !holderId.equals(rows.getString("holder_id"))) {
                            connection.rollback();
                            return null;
                        }
                        currentToken = rows.getLong("fencing_token");
                    }
                }
            }
            long nextToken = currentToken == null ? 1L : currentToken + 1L;
            if (currentToken == null) {
                try (var insert = connection.prepareStatement("INSERT INTO instance_lease(id, holder_id, fencing_token, expires_at) VALUES (?, ?, ?, ?)")) {
                    insert.setString(1, LEASE_ID); insert.setString(2, holderId); insert.setLong(3, nextToken); insert.setTimestamp(4, Timestamp.from(expiresAt)); insert.executeUpdate();
                }
            } else {
                try (var update = connection.prepareStatement("UPDATE instance_lease SET holder_id = ?, fencing_token = ?, expires_at = ? WHERE id = ? AND fencing_token = ?")) {
                    update.setString(1, holderId); update.setLong(2, nextToken); update.setTimestamp(3, Timestamp.from(expiresAt)); update.setString(4, LEASE_ID); update.setLong(5, currentToken);
                    if (update.executeUpdate() != 1) { connection.rollback(); return null; }
                }
            }
            connection.commit();
            return nextToken;
        } catch (SQLException ex) {
            rollback();
            throw new IllegalStateException("cannot acquire instance lease", ex);
        } finally {
            restoreAutoCommit();
        }
    }

    public boolean renew(String holderId, long fencingToken, Instant expiresAt) {
        requireFutureExpiry(expiresAt);
        try (var update = connection.prepareStatement("UPDATE instance_lease SET expires_at = ? WHERE id = ? AND holder_id = ? AND fencing_token = ? AND expires_at > ?")) {
            update.setTimestamp(1, Timestamp.from(expiresAt)); update.setString(2, LEASE_ID); update.setString(3, holderId); update.setLong(4, fencingToken); update.setTimestamp(5, Timestamp.from(clock.now()));
            return update.executeUpdate() == 1;
        } catch (SQLException ex) {
            throw new IllegalStateException("cannot renew instance lease", ex);
        }
    }

    private void rollback() { try { connection.rollback(); } catch (SQLException ignored) { } }
    private void restoreAutoCommit() { try { connection.setAutoCommit(true); } catch (SQLException ignored) { } }

    private void requireFutureExpiry(Instant expiresAt) {
        if (expiresAt == null || !expiresAt.isAfter(clock.now())) {
            throw new IllegalArgumentException("lease expiry must be strictly in the future");
        }
    }
}
