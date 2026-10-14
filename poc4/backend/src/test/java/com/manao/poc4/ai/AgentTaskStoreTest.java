package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * Real-MySQL behavior of the persistent agent task store, observed only through its public
 * interface: one project holds at most one write-owning task, idempotent retries answer the
 * original task, foreign durable states refuse registration, and the browser write guard
 * tracks exactly the occupying states.
 */
class AgentTaskStoreTest {
    private static final String OWNER = "ai-owner";
    private static final String PROJECT = "ai-project";
    private static final Instant NOW = Instant.parse("2026-10-13T00:00:00Z");

    @Test
    void aDurableCreationReservationIsOneShotAndClosingWaitsForTheActualCreate() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "build", 7));
            store.registerToolCall(taskId, "call-build", "a".repeat(64), "build", "{\"goal\":\"test\"}", 7, "command-1");
            assertThat(store.markToolCallRunning(taskId, "call-build")).isTrue();
            var request = new AgentContracts.BuildRequest(taskId, "call-build", PROJECT, "command-1", 7,
                AgentContracts.BuildGoal.TEST);
            CountDownLatch creating = new CountDownLatch(1);
            CountDownLatch finishCreate = new CountDownLatch(1);
            CountDownLatch closeAttempted = new CountDownLatch(1);
            var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
            try {
                var creator = pool.submit(() -> store.createBuildIfAllowed(request, () -> {
                    creating.countDown();
                    try {
                        assertThat(finishCreate.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException ex) {
                        throw new IllegalStateException(ex);
                    }
                    return "created";
                }));
                assertThat(creating.await(5, TimeUnit.SECONDS)).isTrue();
                var closer = pool.submit(() -> {
                    closeAttempted.countDown();
                    return store.beginClose(taskId);
                });
                assertThat(closeAttempted.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> closer.get(150, TimeUnit.MILLISECONDS))
                    .isInstanceOf(java.util.concurrent.TimeoutException.class);
                finishCreate.countDown();
                assertThat(creator.get(5, TimeUnit.SECONDS)).isEqualTo("created");
                assertThat(closer.get(5, TimeUnit.SECONDS)).isEqualTo(AgentTaskStore.CloseEntry.START);
                assertThat(store.failClosedTask(taskId, "AI_CLOSED", "still executing")).isFalse();
                // A new store instance represents a restart: the durable reservation survives.
                assertThat(store(db).<String>createBuildIfAllowed(request, () -> {
                    throw new AssertionError("a reserved command may never create twice");
                })).isNull();
                assertThat(store.findToolCall(taskId, "call-build").orElseThrow().jobName()).isNotBlank();
            } finally {
                finishCreate.countDown();
                pool.shutdownNow();
            }
        }
    }

    @Test
    void oneProjectCannotAcquireTwoTasks() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            // V4 made the database clock explicit: seeded rows state their timestamps.
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('ai-owner','ai-owner','unused',NOW(6))");
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('ai-project','ai-owner','ai-project','READY',7,NOW(6),NOW(6))");
            var store = new AgentTaskStore(jdbc,
                new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            var first = new TaskRequest(UUID.randomUUID().toString(), "change demo", 7);
            assertThat(store.create("ai-owner", "ai-project", first).writesLocked()).isTrue();
            assertThat(store.create("ai-owner", "ai-project", first).taskId()).isEqualTo(first.taskId());
            var second = new TaskRequest(UUID.randomUUID().toString(), "change again", 7);
            assertThatThrownBy(() -> store.create("ai-owner", "ai-project", second))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
        }
    }

    @Test
    void sameIdSameRequestRetryReturnsTheOriginalTask() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            var request = new TaskRequest(UUID.randomUUID().toString(), "change demo", 7);
            AgentContracts.TaskSnapshot created = store.create(OWNER, PROJECT, request);
            assertThat(created.state()).isEqualTo(AgentContracts.TaskState.QUEUED);
            assertThat(created.workspaceRevision()).isEqualTo("7");
            assertThat(store.create(OWNER, PROJECT, request)).isEqualTo(created);
        }
    }

    @Test
    void sameIdDifferentRequestIsRejectedAsMismatch() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            // A different goal or a different expected revision is a different request.
            assertThatThrownBy(() -> store.create(OWNER, PROJECT, new TaskRequest(taskId, "change again", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("AI_TASK_MISMATCH");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThatThrownBy(() -> store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 8)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_MISMATCH"));
        }
    }

    @Test
    void anActiveRunBlocksTaskRegistration() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            insertRun(db.jdbc(), "run-starting", "STARTING");
            assertThatThrownBy(() -> store(db).create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("RUN_ALREADY_ACTIVE");
                    assertThat(ex.status()).isEqualTo(409);
                });
        }
    }

    @Test
    void aPendingWorkspaceOperationBlocksTaskRegistration() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            insertPending(db.jdbc(), "op-pending");
            assertThatThrownBy(() -> store(db).create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                    assertThat(ex.status()).isEqualTo(409);
                });
        }
    }

    @Test
    void foreignStatesAndOwnersRefuseRegistration() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            jdbc.update("UPDATE project SET state = 'DELETING' WHERE id = ?", PROJECT);
            assertThatThrownBy(() -> store(db).create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
            jdbc.update("UPDATE project SET state = 'READY' WHERE id = ?", PROJECT);
            // A project of another owner is indistinguishable from a missing one.
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('other-owner','other-owner','unused',NOW(6))");
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) "
                + "VALUES ('other-project','other-owner','other-project','READY',7,NOW(6),NOW(6))");
            assertThatThrownBy(() -> store(db).create(OWNER, "other-project",
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND");
                    assertThat(ex.status()).isEqualTo(404);
                });
            assertThatThrownBy(() -> store(db).create(OWNER, "unknown-project",
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }
    }

    @Test
    void aStaleExpectedRevisionIsARevisionConflict() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            assertThatThrownBy(() -> store(db).create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "change demo", 6)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("WORKSPACE_REVISION_CONFLICT");
                    assertThat(ex.status()).isEqualTo(409);
                });
        }
    }

    @Test
    void promptAndTaskIdAreValidated() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            assertThatThrownBy(() -> store.create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "   ", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("VALIDATION_ERROR");
                    assertThat(ex.status()).isEqualTo(422);
                });
            assertThatThrownBy(() -> store.create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "a".repeat(8001), 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
            assertThatThrownBy(() -> store.create(OWNER, PROJECT,
                    new TaskRequest("not-a-uuid", "change demo", 7)))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
            assertThat(store.create(OWNER, PROJECT,
                    new TaskRequest(UUID.randomUUID().toString(), "a".repeat(8000), 7)).state())
                .isEqualTo(AgentContracts.TaskState.QUEUED);
        }
    }

    @Test
    void browserWritesAreRefusedWhileTheTaskOwnsTheProjectAndAllowedAfterItSettles() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            assertThatThrownBy(() -> store.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE");
                    assertThat(ex.status()).isEqualTo(409);
                });
            // Projects without any task row stay writable, and the old path opens again
            // exactly when the task reaches a terminal state.
            store.requireBrowserWritable("unknown-project");
            db.jdbc().update("UPDATE agent_task SET state = 'COMPLETED' WHERE id = ?", taskId);
            store.requireBrowserWritable(PROJECT);
        }
    }

    @Test
    void needsAttentionKeepsOccupancyWhileTerminalStatesReleaseIt() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            jdbc.update("UPDATE agent_task SET state = 'NEEDS_ATTENTION' WHERE id = ?", taskId);
            AgentContracts.TaskSnapshot attention = store.currentForOwner(OWNER, PROJECT).orElseThrow();
            assertThat(attention.state()).isEqualTo(AgentContracts.TaskState.NEEDS_ATTENTION);
            assertThat(attention.writesLocked()).isTrue();
            assertThatThrownBy(() -> store.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            jdbc.update("UPDATE agent_task SET state = 'FAILED' WHERE id = ?", taskId);
            store.requireBrowserWritable(PROJECT);
            // The released occupancy accepts the next task for the same project.
            String next = UUID.randomUUID().toString();
            assertThat(store.create(OWNER, PROJECT, new TaskRequest(next, "try again", 7)).taskId())
                .isEqualTo(next);
            jdbc.update("UPDATE agent_task SET state = 'COMPLETED' WHERE id = ?", next);
            assertThat(store.currentForOwner(OWNER, PROJECT)).isEmpty();
        }
    }

    @Test
    void lookupsAreOwnerAndProjectScoped() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('other-owner','other-owner','unused',NOW(6))");
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) "
                + "VALUES ('other-project','other-owner','other-project','READY',7,NOW(6),NOW(6))");
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            AgentContracts.TaskSnapshot created = store.create(OWNER, PROJECT,
                new TaskRequest(taskId, "change demo", 7));
            assertThat(store.findForOwner(OWNER, PROJECT, taskId)).contains(created);
            assertThat(store.currentForOwner(OWNER, PROJECT)).contains(created);
            assertThat(store.findForOwner("other-owner", PROJECT, taskId)).isEmpty();
            assertThat(store.findForOwner(OWNER, "other-project", taskId)).isEmpty();
            assertThat(store.currentForOwner("other-owner", PROJECT)).isEmpty();
            assertThat(store.findForOwner(OWNER, PROJECT, UUID.randomUUID().toString())).isEmpty();
        }
    }

    /**
     * The submission-vs-save regression: a browser save that already passed the write guard
     * must not lose against a task submission that starts before the save's durable PENDING
     * registration. The save holds the lifecycle gate across its whole critical section, so
     * the gate-holding submission can only run afterwards — and by then the PENDING row is
     * durable and refuses the task. Both must never pass together.
     */
    @Test
    void aSubmissionCannotSlipBetweenAGuardPassAndThePendingRegistration() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            var gate = new ProjectLifecycleGate();
            CountDownLatch guardPassed = new CountDownLatch(1);
            CountDownLatch registerPending = new CountDownLatch(1);
            AtomicReference<Exception> saverFailure = new AtomicReference<>();
            // The old save path: guard passes while NOTHING is registered yet, then the
            // durable PENDING registration happens inside the SAME gate critical section.
            Thread saver = new Thread(() -> {
                try (var lease = gate.tryAcquire(PROJECT).orElseThrow()) {
                    store.requireBrowserWritable(PROJECT); // passes: no task, no pending row yet
                    guardPassed.countDown();
                    if (!registerPending.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("saver was never released");
                    }
                    insertPending(jdbc, "op-slow-save");
                } catch (Exception ex) {
                    saverFailure.set(ex);
                }
            });
            saver.start();
            assertThat(guardPassed.await(10, TimeUnit.SECONDS)).isTrue();
            // Task submission discipline (Task 4's AgentTaskService): hold the SAME gate first.
            // While the save still holds it, the submission cannot even enter.
            assertThat(gate.tryAcquire(PROJECT)).isEmpty();
            registerPending.countDown();
            saver.join(TimeUnit.SECONDS.toMillis(10));
            assertThat(saverFailure.get()).isNull();
            // Gate is free again; the retried submission holds the gate and still cannot pass:
            // the save's PENDING row is durable and refuses the task registration.
            try (var lease = gate.tryAcquire(PROJECT).orElseThrow()) {
                assertThatThrownBy(() -> store.create(OWNER, PROJECT,
                        new TaskRequest(UUID.randomUUID().toString(), "change demo", 7)))
                    .isInstanceOfSatisfying(ApiException.class, ex -> {
                        assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                        assertThat(ex.status()).isEqualTo(409);
                    });
            }
        }
    }

    @Test
    void bindsTheBuildIdentityToTheToolCallRow() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));

            AgentTaskStore.ToolCallRow row = store.registerToolCall(taskId, "call-1",
                "a".repeat(64), "build", "{}", 7, "command-1");
            assertThat(row.state()).isEqualTo("REGISTERED");

            store.bindToolCallIdentity(taskId, "call-1", "manao-dev-1", "job-uid-1", "pod-uid-1");

            AgentTaskStore.ToolCallRow bound = store.findToolCall(taskId, "call-1").orElseThrow();
            assertThat(bound.state()).isEqualTo("RUNNING");
            assertThat(jdbc.queryForObject(
                "SELECT CONCAT(job_name, '|', job_uid, '|', pod_uid) FROM agent_tool_call "
                    + "WHERE task_id = ? AND tool_call_id = ?",
                String.class, taskId, "call-1")).isEqualTo("manao-dev-1|job-uid-1|pod-uid-1");
        }
    }

    @Test
    void marksARegisteredBuildCallRunningBeforeItsExecution() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.registerToolCall(taskId, "call-1", "a".repeat(64), "build", "{}", 7, "command-1");

            // The REGISTERED->RUNNING transition is the atomic claim of the first execution:
            // exactly one caller wins it, every later caller must follow the recovery path.
            assertThat(store.markToolCallRunning(taskId, "call-1")).isTrue();
            assertThat(store.markToolCallRunning(taskId, "call-1")).isFalse();

            assertThat(store.findToolCall(taskId, "call-1").orElseThrow().state()).isEqualTo("RUNNING");
            // CONCAT_WS skips NULLs entirely: no identity has been bound yet.
            assertThat(jdbc.queryForObject(
                "SELECT CONCAT_WS('|', job_name, job_uid, pod_uid) FROM agent_tool_call "
                    + "WHERE task_id = ? AND tool_call_id = ?",
                String.class, taskId, "call-1")).isEmpty();
            // A settled row can never be claimed either.
            store.bindToolCallIdentity(taskId, "call-1", "manao-dev-1", "job-uid-1", "pod-uid-1");
            store.completeToolCall(taskId, "call-1", "{}");
            assertThat(store.markToolCallRunning(taskId, "call-1")).isFalse();
            assertThat(store.findToolCall(taskId, "call-1").orElseThrow().state()).isEqualTo("COMPLETED");
        }
    }

    @Test
    void readsBackTheBoundBuildIdentityOfAToolCall() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.registerToolCall(taskId, "call-1", "a".repeat(64), "build", "{}", 7, "command-1");
            // The store's own registration gate refuses a second unsettled side-effect
            // call even below the tools layer — the C1 arbitration is authoritative here.
            assertThatThrownBy(() -> store.registerToolCall(taskId, "call-2", "b".repeat(64),
                "build", "{}", 7, "command-2"))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_CALL_UNSETTLED"));
            store.completeToolCall(taskId, "call-1", "{}");
            store.registerToolCall(taskId, "call-2", "b".repeat(64), "build", "{}", 7, "command-2");

            // A call that never started carries no identity to recover.
            assertThat(store.boundBuildIdentity(taskId, "call-1")).isEmpty();
            // The bound row is the recovery's source of truth.
            store.bindToolCallIdentity(taskId, "call-2", "manao-dev-2", "job-uid-2", "pod-uid-2");
            assertThat(store.boundBuildIdentity(taskId, "call-2")).contains(
                new AgentContracts.BuildIdentity("manao-dev-2", "job-uid-2", "pod-uid-2"));
        }
    }

    @Test
    void deletingTheProjectRemovesItsAgentTaskAndToolCallRows() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.registerToolCall(taskId, "call-1", "a".repeat(64), "build", "{}", 7, "command-1");
            jdbc.update("UPDATE project SET state = 'DELETING' WHERE id = ?", PROJECT);

            assertThat(new WorkspaceJdbcStore(jdbc,
                new DataSourceTransactionManager(jdbc.getDataSource())).deleteProject(OWNER, PROJECT)).isTrue();

            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_task", Long.class)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_tool_call", Long.class)).isZero();
        }
    }

    @Test
    void aTerminalCannotSettleWhileAToolCallIsUnsettled() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.registerToolCall(taskId, "call-write", "a".repeat(64), "write_file",
                "{\"path\":\"src/Demo.java\"}", 7, "op-1");
            // The worker reports a terminal verdict while the write call is unsettled:
            // the verdict cannot release the project. The call durably records the
            // pending-terminal marker instead of the reported verdict.
            assertThat(store.applyTerminal(taskId, AgentContracts.TaskState.COMPLETED, "done", null))
                .isTrue();
            var row = jdbc.queryForObject(
                "SELECT CONCAT_WS('|', state, failure_code, IFNULL(summary, '')) FROM agent_task WHERE id = ?",
                String.class, taskId);
            // The report stays recorded as a to-be-verified event: the explicit marker
            // keeps the project occupied and the reported summary is retained.
            assertThat(row).isEqualTo("NEEDS_ATTENTION|" + AgentTaskStore.TERMINAL_PENDING_MARKER + "|done");
            assertThatThrownBy(() -> store.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            // Every side effect settles; the close flow arms its own marker over the
            // pending-terminal one and releases the project.
            store.completeToolCall(taskId, "call-write", "{}");
            assertThat(store.beginClose(taskId)).isEqualTo(AgentTaskStore.CloseEntry.START);
            assertThat(store.failClosedTask(taskId, "AI_CLOSED", "closed")).isTrue();
        }
    }

    @Test
    void aTerminalAppliesOnceEveryToolCallHasSettled() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.registerToolCall(taskId, "call-1", "a".repeat(64), "list_files", "{}", 7, null);
            store.completeToolCall(taskId, "call-1", "{}");
            assertThat(store.applyTerminal(taskId, AgentContracts.TaskState.FAILED, "failed", "AI_PROVIDER_ERROR"))
                .isTrue();
            assertThat(jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?", String.class, taskId))
                .isEqualTo("FAILED");
        }
    }

    @Test
    void theFencingEpochIsPersistedExactlyOnceAtCreation() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            var request = new TaskRequest(taskId, "change demo", 7);
            store.create(OWNER, PROJECT, request);
            assertThat(jdbc.queryForObject("SELECT worker_epoch FROM agent_task WHERE id = ?", Long.class, taskId))
                .isEqualTo(1L);
            // The same-request retry answers the original task and never re-fences it.
            store.create(OWNER, PROJECT, request);
            assertThat(jdbc.queryForObject("SELECT worker_epoch FROM agent_task WHERE id = ?", Long.class, taskId))
                .isEqualTo(1L);
        }
    }

    @Test
    void verifiedWritesAdvanceTheSnapshotRevisionAndAccumulateChangedPaths() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.recordVerifiedWrite(taskId, "src/Demo.java", 8);
            // A replayed settlement (same revision) never regresses or duplicates.
            store.recordVerifiedWrite(taskId, "src/Demo.java", 8);
            store.recordVerifiedWrite(taskId, "pom.xml", 9);
            var snapshot = store.findForOwner(OWNER, PROJECT, taskId).orElseThrow();
            assertThat(snapshot.workspaceRevision()).isEqualTo("9");
            assertThat(snapshot.changedPaths()).containsExactly("src/Demo.java", "pom.xml");
            // The creation revision is preserved for the evidence record while the
            // snapshot carries the latest verified version.
            assertThat(jdbc.queryForObject(
                "SELECT workspace_revision FROM agent_task WHERE id = ?", Long.class, taskId)).isEqualTo(7L);
            // The serialized snapshot keeps the field names the browser parses.
            var json = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(snapshot);
            assertThat(json).contains("\"changedPaths\"").contains("\"workspaceRevision\"");
        }
    }

    @Test
    void aStaleWriteSettlementNeverRegressesTheSnapshotRevision() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            store.recordVerifiedWrite(taskId, "src/Demo.java", 9);
            store.recordVerifiedWrite(taskId, "src/Other.java", 8);
            var snapshot = store.findForOwner(OWNER, PROJECT, taskId).orElseThrow();
            assertThat(snapshot.workspaceRevision()).isEqualTo("9");
            assertThat(snapshot.changedPaths()).containsExactly("src/Demo.java");
        }
    }

    private static AgentTaskStore store(JdbcStoreTestSupport db) {
        var jdbc = db.jdbc();
        return new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
    }

    private static void seed(org.springframework.jdbc.core.JdbcTemplate jdbc) {
        jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?, 'ai-owner', 'unused', ?)",
            OWNER, Timestamp.from(NOW));
        jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) "
            + "VALUES (?, ?, 'ai-project', 'READY', 7, ?, ?)", PROJECT, OWNER, Timestamp.from(NOW), Timestamp.from(NOW));
    }

    private static void insertRun(org.springframework.jdbc.core.JdbcTemplate jdbc, String runId, String state) {
        jdbc.update("""
            INSERT INTO run(id, project_id, requested_revision, state, policy_json, version,
                created_at, updated_at, fencing_token)
            VALUES (?, ?, 0, ?, '{}', 0, ?, ?, 1)
            """, runId, PROJECT, state, Timestamp.from(NOW), Timestamp.from(NOW));
    }

    private static void insertPending(org.springframework.jdbc.core.JdbcTemplate jdbc, String operationId) {
        jdbc.update("""
            INSERT INTO workspace_operation(
                id, project_id, expected_revision, before_sha256, after_sha256,
                receipt_path, receipt_sha256, state, created_at)
            VALUES (?, ?, 0, ?, ?, ?, ?, 'PENDING', ?)
            """, operationId + "-" + PROJECT, PROJECT, "a".repeat(64), "b".repeat(64),
            "receipts/" + operationId, "c".repeat(64), Timestamp.from(NOW));
    }
}
