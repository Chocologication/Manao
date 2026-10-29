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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private static final String WORKER = "store-worker";
    private static final Instant NOW = Instant.parse("2026-10-13T00:00:00Z");

    private static TaskRequest effortRequest(String id, String effort) {
        return new com.fasterxml.jackson.databind.ObjectMapper().disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .convertValue(java.util.Map.of("taskId", id, "prompt", "goal", "expectedRevision", 7, "reasoningEffort", effort), TaskRequest.class);
    }
    @Test void persistsEffortAndRefusesChangedOrInvalidIntent() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc()); var store = store(db); String id = UUID.randomUUID().toString();
            var snapshot = store.create(OWNER, PROJECT, effortRequest(id, "max"));
            assertThat(new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(snapshot).path("reasoningEffort").asText()).isEqualTo("max");
            assertThat(store.createTask(OWNER, PROJECT, effortRequest(id, "max")).created()).isFalse();
            assertThatThrownBy(() -> store.createTask(OWNER, PROJECT, effortRequest(id, "high")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_MISMATCH"));
            assertThatThrownBy(() -> store.create(OWNER, PROJECT, effortRequest(UUID.randomUUID().toString(), "medium")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        }
    }

    @Test void legacyTaskRequestDigestAndNullableConversationRemainCompatible() {
        try (var db = JdbcStoreTestSupport.createAtVersion("13")) {
            seed(db.jdbc());
            String task = "00000000-0000-4000-8000-000000000011";
            db.jdbc().update("INSERT INTO agent_task(id,project_id,owner_id,request_sha256,prompt,state,worker_epoch,workspace_revision,created_at,updated_at) VALUES (?,?,?,?,'legacy','QUEUED',1,7,?,?)",
                task, PROJECT, OWNER, "2f72ac96a74b07ef49c986f3f19ff9b18e7470aabc02b56bd0b0c3185d3abcf5", Timestamp.from(NOW), Timestamp.from(NOW));
            db.migrateToLatest();
            var taskStore = store(db);
            var request = new TaskRequest(task, "legacy", 7);
            assertThat(taskStore.create(OWNER, PROJECT, request).reasoningEffort()).isNull();
            assertThat(taskStore.requestSha256Of(task)).isEqualTo("2f72ac96a74b07ef49c986f3f19ff9b18e7470aabc02b56bd0b0c3185d3abcf5");
            assertThat(taskStore.createTask(OWNER, PROJECT, request).created()).isFalse();
            assertThatThrownBy(() -> taskStore.createTask(OWNER, PROJECT, new TaskRequest(task, "legacy", 7, "high")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_MISMATCH"));
        }
    }

    @Test
    void applicationStartBudgetAndUnsettledCallExclusionAreDurable() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String task = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(task, "run", 7));
            String run = UUID.randomUUID().toString();
            store.registerToolCall(task, "start-0", "a".repeat(64), "application", "{\"action\":\"start\"}", 7, run);
            assertThatThrownBy(() -> store.registerToolCall(task, "build", "b".repeat(64), "build", "{}", 7, "build-id"))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_CALL_UNSETTLED"));
            store.completeToolCall(task, "start-0", "{}");
            store.registerToolCall(task, "build", "b".repeat(64), "build", "{}", 7, "build-id");
            // Restore an in-flight original start to model a stale/concurrent caller that
            // reached the Run entry after a build registered. The backend must refuse it.
            db.jdbc().update("UPDATE agent_tool_call SET state = 'RUNNING' WHERE task_id = ? AND tool_call_id = 'start-0'", task);
            assertThatThrownBy(() -> store.requireAgentRunCall(task, PROJECT, "start-0", "start", run))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_CALL_UNSETTLED"));
            store.completeToolCall(task, "build", "{}");
            store.completeToolCall(task, "start-0", "{}");
            for (int i = 1; i < 4; i++) {
                store.registerToolCall(task, "start-" + i, "c".repeat(64), "application", "{\"action\":\"start\"}", 7,
                    UUID.randomUUID().toString());
                store.completeToolCall(task, "start-" + i, "{}");
            }
            // A restart sees the four durable starts; replaying an existing identity is free.
            var restarted = store(db);
            assertThat(restarted.registerToolCall(task, "start-0", "a".repeat(64), "application",
                "{\"action\":\"start\"}", 7, run).workspaceOperationId()).isEqualTo(run);
            assertThatThrownBy(() -> restarted.registerToolCall(task, "start-4", "d".repeat(64), "application",
                    "{\"action\":\"start\"}", 7, UUID.randomUUID().toString()))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_APPLICATION_START_LIMIT"));
            assertThat(restarted.applicationCalls(task)).hasSize(4).allMatch(call -> "application".equals(call.toolName()));
        }
    }

    @Test
    void applicationRunAuthorizationUsesTheDurableCallAndClosingScope() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String task = UUID.randomUUID().toString();
            String run = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(task, "run", 7));
            store.registerToolCall(task, "start", "a".repeat(64), "application", "{\"action\":\"start\"}", 7, run);
            store.requireAgentRunCall(task, PROJECT, "start", "start", run);
            for (String[] forged : new String[][] {
                    {task, "foreign", "start", "start", run},
                    {task, PROJECT, "missing", "start", run},
                    {"missing", PROJECT, "start", "start", run},
                    {task, PROJECT, "start", "start", UUID.randomUUID().toString()},
                    {task, PROJECT, "start", "stop", run}}) {
                assertThatThrownBy(() -> store.requireAgentRunCall(forged[0], forged[1], forged[2], forged[3], forged[4]))
                    .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
            }
            store.completeToolCall(task, "start", "{}");
            assertThatThrownBy(() -> store.requireAgentRunCall(task, PROJECT, "start", "start", run))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
            store.registerToolCall(task, "stop", "b".repeat(64), "application",
                "{\"action\":\"stop\",\"runId\":\"old-run\"}", 7, UUID.randomUUID().toString());
            store.requireAgentRunCall(task, PROJECT, "stop", "stop", "old-run");
            store.beginClose(task);
            store.requireAgentRunCall(task, PROJECT, "start", "stop", run);
            store.requireAgentRunCall(task, PROJECT, "stop", "stop", "old-run");
            assertThatThrownBy(() -> store.requireAgentRunCall(task, PROJECT, "start", "start", run))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
            assertThatThrownBy(() -> store.requireAgentRunCall(task, PROJECT, "start", "stop", "old-run"))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
        }
    }

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
    void anActiveRunAllowsTaskRegistration() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            insertRun(db.jdbc(), "run-starting", "STARTING");
            var request = new TaskRequest(UUID.randomUUID().toString(), "stop then change demo", 7);
            assertThat(store(db).create(OWNER, PROJECT, request).writesLocked()).isTrue();
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

    @Test
    void aTerminalDecisionIsAtomicAgainstAConcurrentToolCallRegistration() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            // A SECOND, independent database connection registers an unsettled tool call
            // and holds the insert uncommitted: only a single-statement decision (the
            // side-effect check evaluated by the same UPDATE that transitions the row)
            // can close this window — a check-then-act pair reads through the uncommitted
            // insert and applies the verdict regardless.
            var other = db.jdbc().getDataSource().getConnection();
            var verdictExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                other.setAutoCommit(false);
                var insert = other.prepareStatement("""
                    INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                        state, workspace_operation_id, expected_revision, created_at, updated_at)
                    VALUES (?, ?, ?, 'write_file', '{}', 'REGISTERED', ?, 7, NOW(6), NOW(6))
                    """);
                insert.setString(1, taskId);
                insert.setString(2, "call-concurrent");
                insert.setString(3, "a".repeat(64));
                insert.setString(4, "op-concurrent");
                insert.executeUpdate();
                var verdict = verdictExecutor.submit(
                    () -> store.applyTerminal(taskId, AgentContracts.TaskState.COMPLETED, "done", null));
                // The verdict decision must not complete while the concurrent registration
                // is undecided: the atomic UPDATE blocks on the uncommitted row's lock.
                Thread.sleep(500);
                assertThat(verdict.isDone())
                    .as("the terminal decision waited for the concurrent registration to resolve")
                    .isFalse();
                other.commit();
                assertThat(verdict.get(10, TimeUnit.SECONDS)).isTrue();
                // The decision was made AFTER the registration became visible: the verdict
                // cannot settle the task; the pending-terminal marker keeps the occupancy.
                var row = jdbc.queryForObject(
                    "SELECT CONCAT_WS('|', state, failure_code) FROM agent_task WHERE id = ?",
                    String.class, taskId);
                assertThat(row).isEqualTo("NEEDS_ATTENTION|" + AgentTaskStore.TERMINAL_PENDING_MARKER);
                assertThatThrownBy(() -> store.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            } finally {
                // The independent connection and the executor are always released, so an
                // assertion failure can never leak a thread or block the schema cleanup.
                other.close();
                verdictExecutor.shutdownNow();
            }
        }
    }

    @Test
    void aTerminalCannotSettleWhileAWorkspaceReceiptIsUnverified() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var store = store(db);
            String taskId = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            // A settled-looking call row whose workspace receipt was never verified:
            // the PENDING operation is an unsettled side effect of this task.
            jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'call-write', ?, 'write_file', '{}', 'COMPLETED', 'op-pending', 7, NOW(6), NOW(6))
                """, taskId, "a".repeat(64));
            jdbc.update("""
                INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256,
                    receipt_path, receipt_sha256, state, created_at)
                VALUES ('op-pending', ?, 7, ?, ?, 'receipts/op-pending', ?, 'PENDING', NOW(6))
                """, PROJECT, "b".repeat(64), "c".repeat(64), "d".repeat(64));
            // The verdict is arbitrated atomically: an unverified receipt keeps the
            // task undecided under the pending-terminal marker.
            assertThat(store.applyTerminal(taskId, AgentContracts.TaskState.COMPLETED, "done", null))
                .isTrue();
            assertThat(jdbc.queryForObject(
                "SELECT CONCAT_WS('|', state, failure_code) FROM agent_task WHERE id = ?",
                String.class, taskId)).isEqualTo("NEEDS_ATTENTION|" + AgentTaskStore.TERMINAL_PENDING_MARKER);
            assertThatThrownBy(() -> store.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            // A pending-terminal state is never re-settled by a later verdict; it is
            // resolved by the close flow, which proves the (by now committed) receipt
            // and releases the occupancy.
            jdbc.update("UPDATE workspace_operation SET state = 'COMMITTED' WHERE id = 'op-pending'");
            assertThat(store.beginClose(taskId)).isEqualTo(AgentTaskStore.CloseEntry.START);
            assertThat(store.failClosedTask(taskId, "AI_CLOSED", "closed")).isTrue();
            assertThat(jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?", String.class, taskId))
                .isEqualTo("FAILED");
        }
    }

    @Test
    void aRegistrationRacingATerminalVerdictIsRefusedAsSettled() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            seed(jdbc);
            var registrationStore = store(db);
            // A second store view over its own pooled connection plays the concurrent
            // terminal verdict — the opposite interleaving of the atomic-terminal test
            // above: the pre-check passes, THEN the terminal commits, THEN the
            // registration INSERT runs against the already-settled task.
            var terminalStore = store(db);
            String taskId = UUID.randomUUID().toString();
            registrationStore.create(OWNER, PROJECT, new TaskRequest(taskId, "change demo", 7));
            var spy = org.mockito.Mockito.spy(registrationStore);
            var precheckPassed = new CountDownLatch(1);
            var terminalCommitted = new CountDownLatch(1);
            org.mockito.Mockito.doAnswer(invocation -> {
                precheckPassed.countDown();
                if (!terminalCommitted.await(5, TimeUnit.SECONDS)) {
                    throw new AssertionError("the concurrent terminal never committed");
                }
                return invocation.callRealMethod();
            }).when(spy).hasUnsettledCall(taskId);
            var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var registration = pool.submit(() -> spy.registerToolCall(taskId, "call-raced",
                    "a".repeat(64), "write_file", "{\"path\":\"src/Demo.java\"}", 7, "op-raced"));
                assertThat(precheckPassed.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(terminalStore.applyTerminal(taskId, AgentContracts.TaskState.FAILED,
                    "worker failed", "AI_PROVIDER_ERROR")).isTrue();
                terminalCommitted.countDown();
                var row = registration.get(5, TimeUnit.SECONDS);
                // The INSERT was refused by its own task-state condition: a late
                // REGISTERED row can never land on a settled task. The deterministic,
                // side-effect-free refusal is the call's durable settled answer.
                assertThat(row.state()).isEqualTo("COMPLETED");
                var error = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(row.resultJson()).path("data").path("error");
                assertThat(error.path("code").asText()).isEqualTo("AI_TASK_NOT_ACTIVE");
                // The settled task stays settled and the refusal row never wedges the
                // close flow.
                assertThat(jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?",
                    String.class, taskId)).isEqualTo("FAILED");
                assertThat(spy.beginClose(taskId)).isEqualTo(AgentTaskStore.CloseEntry.SETTLED);
            } finally {
                terminalCommitted.countDown();
                pool.shutdownNow();
            }
        }
    }

    /**
     * The V15 migration is purely additive: the terminal-receipt, deadline, close-reason
     * and reconcile columns appear as NULL, history rows keep their state untouched, and
     * every NEW task binds its budget deadline from the same clock as its creation.
     */
    @Test
    void v15MigrationAddsReceiptColumnsWithoutTouchingHistory() {
        try (var db = JdbcStoreTestSupport.createAtVersion("14")) {
            seed(db.jdbc());
            String legacy = "00000000-0000-4000-8000-000000000021";
            db.jdbc().update("""
                INSERT INTO agent_task(id, project_id, owner_id, request_sha256, prompt, state,
                    worker_epoch, workspace_revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'legacy', 'RUNNING', 1, 7, ?, ?)
                """, legacy, PROJECT, OWNER, "2f72ac96a74b07ef49c986f3f19ff9b18e7470aabc02b56bd0b0c3185d3abcf5",
                Timestamp.from(NOW), Timestamp.from(NOW));
            db.migrateToLatest();
            var row = db.jdbc().queryForMap("""
                SELECT state, terminal_report_id, terminal_report_json, terminal_report_sha256,
                       terminal_received_at, deadline_at, close_reason_code, next_reconcile_at
                FROM agent_task WHERE id = ?
                """, legacy);
            assertThat(row.get("state")).isEqualTo("RUNNING");
            assertThat(row.get("terminal_report_id")).isNull();
            assertThat(row.get("terminal_report_json")).isNull();
            assertThat(row.get("terminal_report_sha256")).isNull();
            assertThat(row.get("terminal_received_at")).isNull();
            assertThat(row.get("deadline_at")).isNull();
            assertThat(row.get("close_reason_code")).isNull();
            assertThat(row.get("next_reconcile_at")).isNull();
            // A NEW task binds created_at + 1800s from the same clock, in one write. It
            // lives in a SECOND project: the untouched legacy RUNNING row still owns the
            // first one.
            String secondProject = PROJECT + "-receipts";
            db.jdbc().update(
                "INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) "
                    + "VALUES (?, ?, ?, 'READY', 7, ?, ?)",
                secondProject, OWNER, secondProject, Timestamp.from(NOW), Timestamp.from(NOW));
            var store = store(db);
            String fresh = UUID.randomUUID().toString();
            store.create(OWNER, secondProject, new TaskRequest(fresh, "fresh task", 7));
            var times = db.jdbc().queryForMap(
                "SELECT created_at, deadline_at FROM agent_task WHERE id = ?", fresh);
            assertThat(((Timestamp) times.get("deadline_at")).getTime())
                .isEqualTo(((Timestamp) times.get("created_at")).getTime() + 1800_000L);
        }
    }

    /**
     * The receipt decision table (design section 4): the first receipt parks the task,
     * the same report re-delivered is an idempotent ACK that rewrites nothing, different
     * content or a foreign identity under the same execution is an explicit 409, and a
     * receipt that settled the task keeps answering SETTLED afterwards.
     */
    @Test
    void terminalReceiptsAreIdempotentConflictingAndIdentityBound() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String task = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(task, "receipt", 7));
            store.bindWorkerInstance(task, 1, WORKER);
            String reportId = AgentTaskStore.terminalReportId(task, 1, store.requestSha256Of(task));
            String reportJson =
                "{\"protocolVersion\":1,\"state\":\"COMPLETED\",\"summary\":\"done\",\"failureCode\":null}";

            var receipt = store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(receipt.firstReceipt()).isTrue();
            assertThat(receipt.disposition()).isEqualTo(AgentContracts.TerminalDisposition.RECORDED);
            assertThat(receipt.contentSha256()).isEqualTo(AgentTaskStore.terminalContentSha256(
                reportId, AgentContracts.TaskState.COMPLETED, "done", null));
            var row = db.jdbc().queryForMap("""
                SELECT state, failure_code, summary, terminal_report_id, terminal_report_sha256,
                       terminal_received_at FROM agent_task WHERE id = ?
                """, task);
            assertThat(row.get("state")).isEqualTo("NEEDS_ATTENTION");
            assertThat(row.get("failure_code")).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(row.get("summary")).isEqualTo("done");
            assertThat(row.get("terminal_report_id")).isEqualTo(reportId);
            assertThat(row.get("terminal_report_sha256")).isEqualTo(receipt.contentSha256());
            assertThat(row.get("terminal_received_at")).isNotNull();

            var redelivered = store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(redelivered.firstReceipt()).isFalse();
            assertThat(redelivered.disposition()).isEqualTo(AgentContracts.TerminalDisposition.RECORDED);

            // Same id, different content: an explicit 409, the stored receipt unchanged.
            assertThatThrownBy(() -> store.recordTerminal(task, 1, WORKER, reportId,
                    "{\"protocolVersion\":1,\"state\":\"FAILED\",\"summary\":\"different\","
                        + "\"failureCode\":\"AI_PROVIDER_ERROR\"}",
                    AgentContracts.TaskState.FAILED, "different", "AI_PROVIDER_ERROR"))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_MISMATCH"));
            assertThat(db.jdbc().queryForObject(
                "SELECT terminal_report_sha256 FROM agent_task WHERE id = ?", String.class, task))
                .isEqualTo(receipt.contentSha256());

            // A foreign report identity under the same execution: explicit 409.
            assertThatThrownBy(() -> store.recordTerminal(task, 1, WORKER, "f".repeat(64),
                    reportJson, AgentContracts.TaskState.COMPLETED, "done", null))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_MISMATCH"));

            // Wrong execution identity is refused inside the receipt transaction.
            assertThatThrownBy(() -> store.recordTerminal(task, 9, WORKER, reportId, reportJson,
                    AgentContracts.TaskState.COMPLETED, "done", null))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_EPOCH_MISMATCH"));
            assertThatThrownBy(() -> store.recordTerminal(task, 1, "other-worker", reportId,
                    reportJson, AgentContracts.TaskState.COMPLETED, "done", null))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_INSTANCE_MISMATCH"));

            // After the receipt settles the task — the receipt-identity CAS is the only
            // path that completes a parked row (repair plan task 3) — the same report
            // stays an idempotent ACK.
            assertThat(store.completeFromReceipt(task, reportId, receipt.contentSha256(), "done", null)).isTrue();
            var settled = store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(settled.disposition()).isEqualTo(AgentContracts.TerminalDisposition.SETTLED);
            assertThat(db.jdbc().queryForObject(
                "SELECT state FROM agent_task WHERE id = ?", String.class, task)).isEqualTo("COMPLETED");
        }
    }

    /**
     * Concurrent deliveries of the SAME report race to exactly ONE recorded park: one
     * caller creates the receipt, the other is the idempotent ACK of the same receipt,
     * and the row lands parked with the one report identity.
     */
    @Test
    void concurrentIdenticalReceiptsRaceToOneRecordedPark() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String task = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(task, "race", 7));
            store.bindWorkerInstance(task, 1, WORKER);
            String reportId = AgentTaskStore.terminalReportId(task, 1, store.requestSha256Of(task));
            String reportJson =
                "{\"protocolVersion\":1,\"state\":\"COMPLETED\",\"summary\":\"done\",\"failureCode\":null}";
            ExecutorService pool = Executors.newFixedThreadPool(2);
            CountDownLatch ready = new CountDownLatch(2);
            var outcomes = new java.util.concurrent.CopyOnWriteArrayList<AgentTaskStore.TerminalReceipt>();
            java.util.concurrent.Callable<Boolean> deliver = () -> {
                ready.countDown();
                ready.await(5, TimeUnit.SECONDS);
                outcomes.add(store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                    AgentContracts.TaskState.COMPLETED, "done", null));
                return true;
            };
            var first = pool.submit(deliver);
            var second = pool.submit(deliver);
            assertThat(first.get(10, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(10, TimeUnit.SECONDS)).isTrue();
            pool.shutdownNow();
            assertThat(outcomes).hasSize(2);
            assertThat(outcomes.stream().filter(AgentTaskStore.TerminalReceipt::firstReceipt).count())
                .isEqualTo(1);
            assertThat(outcomes).allSatisfy(r ->
                assertThat(r.disposition()).isEqualTo(AgentContracts.TerminalDisposition.RECORDED));
            var row = db.jdbc().queryForMap(
                "SELECT state, failure_code, terminal_report_id FROM agent_task WHERE id = ?", task);
            assertThat(row.get("state")).isEqualTo("NEEDS_ATTENTION");
            assertThat(row.get("failure_code")).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(row.get("terminal_report_id")).isEqualTo(reportId);
        }
    }

    /**
     * A stored close intent takes precedence over late reports (design contract 5): the
     * late report is acknowledged CLOSING with its identity recorded as the refused one,
     * the close reason is never overwritten — not by the late report, not by a repeated
     * close — and different late content is an explicit 409.
     */
    @Test
    void closeIntentTakesPrecedenceOverLateReportsWithoutOverwritingTheReason() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String closed = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(closed, "closed", 7));
            store.bindWorkerInstance(closed, 1, WORKER);
            store.beginClose(closed, "AI_CLOSED");
            String closedReportId = AgentTaskStore.terminalReportId(closed, 1, store.requestSha256Of(closed));
            String reportJson =
                "{\"protocolVersion\":1,\"state\":\"COMPLETED\",\"summary\":\"done\",\"failureCode\":null}";
            var late = store.recordTerminal(closed, 1, WORKER, closedReportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(late.disposition()).isEqualTo(AgentContracts.TerminalDisposition.CLOSING);
            var row = db.jdbc().queryForMap(
                "SELECT state, failure_code, close_reason_code, terminal_report_id FROM agent_task WHERE id = ?",
                closed);
            assertThat(row.get("state")).isEqualTo("NEEDS_ATTENTION");
            assertThat(row.get("failure_code")).isEqualTo("AI_CLOSING");
            assertThat(row.get("close_reason_code")).isEqualTo("AI_CLOSED");
            assertThat(row.get("terminal_report_id")).isEqualTo(closedReportId);
            // A repeated close never overwrites the stored reason.
            store.beginClose(closed, "AI_OTHER");
            assertThat(db.jdbc().queryForObject(
                "SELECT close_reason_code FROM agent_task WHERE id = ?", String.class, closed))
                .isEqualTo("AI_CLOSED");
            // The same late report re-delivered stays CLOSING; different content conflicts.
            var again = store.recordTerminal(closed, 1, WORKER, closedReportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(again.disposition()).isEqualTo(AgentContracts.TerminalDisposition.CLOSING);
            assertThatThrownBy(() -> store.recordTerminal(closed, 1, WORKER, closedReportId,
                    "{\"protocolVersion\":1,\"state\":\"FAILED\",\"summary\":\"late\","
                        + "\"failureCode\":\"AI_PROVIDER_ERROR\"}",
                    AgentContracts.TaskState.FAILED, "late", "AI_PROVIDER_ERROR"))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_MISMATCH"));
        }
    }

    /**
     * The identity algorithm is pinned by the cross-language vectors (design protocol
     * supplement): reportId and the content digest are the lowercase SHA-256 of the
     * compact JSON array with raw Unicode, unescaped slashes and preserved nulls. The
     * pinned values below were computed independently (Node) and are asserted identically
     * by the TS test {@code terminal-delivery.test.ts}.
     */
    @Test
    void terminalIdentityMatchesThePinnedCrossLanguageVectors() {
        String taskId = "00000000-0000-4000-8000-000000000002";
        String requestSha256 = "a".repeat(64);
        String summary = "模型已完成任务 ✅🚀 \"引用\" a/b\n第二行";
        assertThat(AgentTaskStore.terminalReportId(taskId, 1, requestSha256))
            .isEqualTo("263ade2fcde171dbcea4fc769d7b2f39ee0c5ef92beee2b559ab75458c4ec606");
        String reportId = AgentTaskStore.terminalReportId(taskId, 1, requestSha256);
        assertThat(AgentTaskStore.terminalContentSha256(reportId, AgentContracts.TaskState.COMPLETED, summary, null))
            .isEqualTo("11feecc769a1fe7f825999d9260131e5a5461b08cf004bcc9d5e88019be70a2a");
        assertThat(AgentTaskStore.terminalContentSha256(reportId, AgentContracts.TaskState.FAILED, summary, "AI_PROVIDER_ERROR"))
            .isEqualTo("2f3c92b5efe892a112a63d6bcdc5372e852aa65f81b8a0e20dd45e0f15ff8051");
    }

    /**
     * A legacy row parked by the pre-receipt backend (NEEDS_ATTENTION under the pending
     * marker with NO receipt — exactly the old deferTerminal outcome) accepts its first
     * terminal callback: the receipt attaches to the already-parked row instead of a
     * claimed-but-unstored acknowledgement, and the parked task then settles exactly like
     * a receipt created here (design section 4: a new terminal callback may establish the
     * receipt of an old task).
     */
    @Test
    void recordTerminalAttachesTheReceiptToALegacyParkedRow() {
        try (var db = JdbcStoreTestSupport.create()) {
            seed(db.jdbc());
            var store = store(db);
            String task = UUID.randomUUID().toString();
            store.create(OWNER, PROJECT, new TaskRequest(task, "legacy park", 7));
            store.bindWorkerInstance(task, 1, WORKER);
            db.jdbc().update("""
                UPDATE agent_task SET state = 'NEEDS_ATTENTION', failure_code = 'AI_TERMINAL_PENDING',
                    summary = 'waiting for verification', updated_at = ?
                WHERE id = ?
                """, Timestamp.from(Instant.now()), task);
            String reportId = AgentTaskStore.terminalReportId(task, 1, store.requestSha256Of(task));
            String reportJson =
                "{\"protocolVersion\":1,\"state\":\"COMPLETED\",\"summary\":\"done\",\"failureCode\":null}";
            var receipt = store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null);
            assertThat(receipt.firstReceipt()).isTrue();
            assertThat(receipt.disposition()).isEqualTo(AgentContracts.TerminalDisposition.RECORDED);
            var row = db.jdbc().queryForMap("""
                SELECT state, failure_code, terminal_report_id, terminal_report_sha256
                FROM agent_task WHERE id = ?
                """, task);
            assertThat(row.get("state")).isEqualTo("NEEDS_ATTENTION");
            assertThat(row.get("failure_code")).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(row.get("terminal_report_id")).isEqualTo(reportId);
            assertThat(row.get("terminal_report_sha256")).isEqualTo(receipt.contentSha256());
            // The re-delivered report is the idempotent ACK of the attached receipt, and
            // the parked task settles exactly like a receipt created here — by the
            // receipt-identity CAS, the only completion path for a parked row.
            assertThat(store.recordTerminal(task, 1, WORKER, reportId, reportJson,
                AgentContracts.TaskState.COMPLETED, "done", null).disposition())
                .isEqualTo(AgentContracts.TerminalDisposition.RECORDED);
            assertThat(store.completeFromReceipt(task, reportId, receipt.contentSha256(), "done", null)).isTrue();
            assertThat(db.jdbc().queryForObject("SELECT state FROM agent_task WHERE id = ?",
                String.class, task)).isEqualTo("COMPLETED");
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
