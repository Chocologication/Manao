package com.manao.poc4.audit;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Real-MySQL coverage for the terminal audit store, including the widened trust_level column. */
class JdbcAuditStoreTest {
    static JdbcStoreTestSupport db;
    JdbcAuditStore store;
    String userId, projectId, runId, sessionId;

    @BeforeAll
    static void up() { db = JdbcStoreTestSupport.create(); }
    @AfterAll
    static void down() { db.close(); }

    @BeforeEach
    void seed() {
        store = new JdbcAuditStore(db.jdbc());
        userId = "u-" + UUID.randomUUID();
        projectId = "p-" + UUID.randomUUID();
        runId = "r-" + UUID.randomUUID();
        sessionId = "s-" + UUID.randomUUID();
        seedRow();
    }

    @Test
    void insertWrapperTransportTrustLevelFitsColumn() {
        String auditId = store.insertRunning(sessionId, projectId, runId, userId, 1, "echo hi", false,
            AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT, Instant.now());
        assertThat(auditId).isNotBlank();   // V6 前：Data too long for column 'trust_level'
    }

    @Test
    void settleIsSingleUseAndListsByRunWithCursorPaging() {
        String auditId = store.insertRunning(sessionId, projectId, runId, userId, 1, "echo hi", false,
            AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT, Instant.now());
        assertThat(store.settle(auditId, "CLOSED", 0, Instant.now())).isTrue();
        assertThat(store.settle(auditId, "CLOSED", 1, Instant.now())).isFalse();

        var page = store.list(runId, 10);
        assertThat(page).anySatisfy(record -> {
            assertThat(record.id()).isEqualTo(auditId);
            assertThat(record.state()).isEqualTo("CLOSED");
            assertThat(record.exitCode()).isZero();
        });
        var older = store.listBefore(runId, Instant.now().plusSeconds(1), "", 10);
        assertThat(older).anySatisfy(record -> assertThat(record.id()).isEqualTo(auditId));
    }

    @Test
    void deleteExpiredBeforeRemovesOnlyOldRows() {
        String oldId = store.insertRunning(sessionId, projectId, runId, userId, 1, "echo old", false,
            AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT, Instant.now().minus(Duration.ofDays(8)));
        String freshId = store.insertRunning(sessionId, projectId, runId, userId, 2, "echo fresh", false,
            AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT, Instant.now());
        int deleted = store.deleteExpiredBefore(Instant.now().minus(Duration.ofDays(7)));
        assertThat(deleted).isGreaterThanOrEqualTo(1);
        var page = store.list(runId, 10);
        assertThat(page).noneSatisfy(record -> assertThat(record.id()).isEqualTo(oldId));
        assertThat(page).anySatisfy(record -> assertThat(record.id()).isEqualTo(freshId));
    }

    private void seedRow() {
        Timestamp now = Timestamp.from(Instant.now());
        db.jdbc().update("INSERT INTO app_user(id, username, password_hash, enabled, created_at) VALUES (?, ?, 'hash', TRUE, ?)",
            userId, "user-" + userId, now);
        db.jdbc().update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'demo', 'READY', 0, ?, ?)",
            projectId, userId, now, now);
        db.jdbc().update("INSERT INTO run(id, project_id, requested_revision, state, policy_json, version, created_at, updated_at, fencing_token) VALUES (?, ?, 0, 'RUNNING', '{}', 0, ?, ?, 1)",
            runId, projectId, now, now);
        db.jdbc().update("INSERT INTO terminal_session(id, project_id, run_id, user_id, state, ticket_hash, expires_at, version) VALUES (?, ?, ?, ?, 'LIVE', ?, ?, 0)",
            sessionId, projectId, runId, userId, UUID.randomUUID().toString().replace("-", ""), Timestamp.from(Instant.now().plusSeconds(3600)));
    }
}
