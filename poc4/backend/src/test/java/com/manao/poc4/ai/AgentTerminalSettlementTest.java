package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.ai.AgentContracts.ProgressItem;
import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.ai.AgentContracts.ToolRequest;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.run.JdbcRunStore;
import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunRecoveryService;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * The terminal settlement regression fixtures (repair plan 2026-10-25, task 1). They replay
 * the diagnosed incident (evidence: terminal-settlement-race-safe.json) against the real
 * store and the real project gate on a disposable MySQL schema — only the external
 * {@link JobCoordinator} is mocked. RED baseline: the authenticated terminal report is
 * refused 409 PROJECT_BUSY whenever anything (the Run recovery scan, most visibly) holds
 * the project gate, the refusal leaves no durable receipt, a terminal behind a missing
 * display message is intercepted by the seq check, and the task then stays undecided
 * RUNNING with its occupancy held. After the receipt entry lands (task 2), each report is
 * receipted without the gate, frozen against new side effects, and settled by exactly one
 * durable terminal decision.
 */
class AgentTerminalSettlementTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "settlement-owner";
    private static final String PROJECT = "settlement-project";
    private static final String INSTANCE = "settlement-worker";
    private static final String SUMMARY = "the model has finished the task";
    /**
     * The shared cross-language Unicode vector (design protocol supplement): Chinese,
     * emoji, quotes, an unescaped slash and a newline. The Java and TS identity helpers
     * must agree on its digests byte for byte; the pinned values live in
     * {@code AgentTaskStoreTest} and {@code terminal-delivery.test.ts}.
     */
    private static final String UNICODE_SUMMARY = "模型已完成任务 ✅🚀 \"引用\" a/b\n第二行";

    /**
     * The diagnosed race (acceptance case A): the Run recovery pauses inside its
     * identity-verified observation while holding the project gate; on another thread the
     * worker submits its authenticated terminal report. Desired: the report is receipted
     * without waiting for that gate, new tool admission is blocked, the project's writes
     * stay locked, and when the recovery resumes and its checks pass, ONE terminal decision
     * releases the occupancy.
     */
    @Test
    void terminalReportIsDurableWhileRunRecoveryHoldsTheProjectGate() throws Exception {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            String runId = h.seedRunningServiceRun();
            CountDownLatch observationEntered = new CountDownLatch(1);
            CountDownLatch releaseObservation = new CountDownLatch(1);
            CountDownLatch recoveryFinished = new CountDownLatch(1);
            JobCoordinator coordinator = Mockito.mock(JobCoordinator.class);
            Mockito.when(coordinator.observe(Mockito.any())).thenAnswer(invocation -> {
                observationEntered.countDown();
                if (!releaseObservation.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("the paused observation was never released");
                }
                return new JobCoordinator.JobObservation(JobCoordinator.ObservationKind.FOUND,
                    new JobCoordinator.JobFacts(true, false, false, false, null,
                        "diagnostic-pod", "diagnostic-uid", true, false), null);
            });
            RunRecoveryService recovery = new RunRecoveryService(h.runStore(), coordinator,
                null, null, h.gate, null);
            ExecutorService pool = Executors.newCachedThreadPool();
            try {
                pool.submit(() -> {
                    try {
                        recovery.recoverRuns();
                    } finally {
                        recoveryFinished.countDown();
                    }
                });
                assertThat(observationEntered.await(10, TimeUnit.SECONDS)).isTrue();
                // The recovery now holds the project gate from inside its paused observation.
                assertThat(h.runState(runId)).isEqualTo("RECOVERING");

                // The worker's delivery thread submits the authenticated terminal report.
                Future<Throwable> delivery = pool.submit(() -> {
                    try {
                        h.submitTerminal(37, "COMPLETED");
                        return null;
                    } catch (RuntimeException failure) {
                        return failure;
                    }
                });
                Throwable refusal = delivery.get(10, TimeUnit.SECONDS);
                assertThat(refusal)
                    .as("the authenticated terminal report must be receipted without waiting"
                        + " for the project gate (refused with: %s)", refusal)
                    .isNull();
                // The receipt is durable: a recorded terminal decision frozen for
                // verification — never a bare undecided RUNNING.
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                // New tool admission is blocked while the receipt is unverified.
                assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "post-terminal-call",
                        INSTANCE, 1, new ToolRequest("post-terminal-call", "list_files", 7,
                            JSON.createObjectNode())))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
                // Writes remain locked until the original effects are verified.
                assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));

                // Recovery resumes; its identity-verified observation passes and the run
                // returns to RUNNING.
                releaseObservation.countDown();
                assertThat(recoveryFinished.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(h.runState(runId)).isEqualTo("RUNNING");

                // ONE terminal decision releases the occupancy: the persisted receipt is
                // settled exactly once (the re-delivered identical report is the repaired
                // worker's retry that carries the settlement).
                h.submitTerminal(37, "COMPLETED");
                assertThat(h.rowState()).isEqualTo("COMPLETED");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                h.tasks.requireBrowserWritable(PROJECT);
            } finally {
                releaseObservation.countDown();
                // The recovery thread must finish its own durable writes before this test
                // releases the schema; the bound wait keeps a stuck observation from hanging.
                try {
                    recoveryFinished.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                pool.shutdownNow();
            }
        }
    }

    /**
     * The incident's delivery failure (acceptance case A/J): with the project gate held,
     * the last display message is refused — and the refusing backend must never let that
     * failed delivery end as a claimed acknowledgement. The terminal that the old backend
     * refused behind the SAME busy gate is now diverted to the receipt entry BEFORE the
     * gate (design section 4), so the re-delivered authenticated report is receipted while
     * the gate is STILL held, its re-delivery stays an idempotent ACK, and the one durable
     * decision settles the task afterwards.
     */
    @Test
    void terminalDeliveryFailureNeverClaimsAcknowledgement() throws Exception {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            ExecutorService pool = Executors.newSingleThreadExecutor();
            // The contended gate of the incident, held by this thread; every delivery
            // below runs on a DIFFERENT thread — the gate is reentrant for its owner and
            // a same-thread submission would never see the contention.
            try (ProjectLifecycleGate.Lease contention = h.gate.tryAcquire(PROJECT).orElseThrow()) {
                // The refused delivery of the incident (race-safe.json failedDeliveries).
                Throwable messageRefusal = pool.submit(
                    () -> catchThrowable(() -> h.recordProgress(37))).get(10, TimeUnit.SECONDS);
                assertThat(messageRefusal).isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("PROJECT_BUSY"));
                // A refused delivery claims no acknowledgement: no receipt, no settlement,
                // the display head never moved, the project stays occupied.
                assertThat(h.rowState()).isEqualTo("RUNNING");
                assertThat(h.progressLastSeq()).isEqualTo(36);
                assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                    .isInstanceOfSatisfying(ApiException.class,
                        ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));

                // The repaired delivery retries the SAME authenticated report while the
                // gate is still held: the receipt entry runs BEFORE the gate, so it is
                // receipted instead of refused again.
                Throwable retryRefusal = pool.submit(
                    () -> catchThrowable(() -> h.submitTerminal(38, "COMPLETED"))).get(10, TimeUnit.SECONDS);
                assertThat(retryRefusal)
                    .as("the re-delivered terminal report must be receipted without the"
                        + " project gate (refused with: %s)", retryRefusal)
                    .isNull();
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                // The idempotent re-delivery of the SAME report while the gate is STILL
                // held (another thread again) re-ACKs the same receipt instead of
                // settling through gate luck.
                Throwable redeliveryRefusal = pool.submit(
                    () -> catchThrowable(() -> h.submitTerminal(38, "COMPLETED"))).get(10, TimeUnit.SECONDS);
                assertThat(redeliveryRefusal).isNull();
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            } finally {
                pool.shutdownNow();
            }
            // The gate contention is over: the persisted receipt settles exactly once.
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The terminal receipt must not depend on display-progress continuity (acceptance case
     * B): seq 37 was lost in delivery and the terminal arrives at seq 38. Desired: the
     * receipt lands independently and the missing message is never fabricated. RED
     * baseline: the seq check intercepts the terminal before anything is recorded.
     */
    @Test
    void missingDisplayProgressDoesNotBlockTerminalReceipt() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            Throwable refusal = catchThrowable(() -> h.submitTerminal(38, "COMPLETED"));
            assertThat(refusal)
                .as("the terminal receipt must not depend on display-progress continuity"
                    + " (refused with: %s)", refusal)
                .isNull();
            // The receipt is durable and the gap is never fabricated into the envelope.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            assertThat(h.progressCount()).isEqualTo(36);
            // One terminal decision settles the task; the envelope stays at its real head.
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.progressCount()).isEqualTo(36);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * Concurrent deliveries of the SAME authenticated report (acceptance case C): both
     * must be acknowledged without the project gate, exactly one durable receipt must
     * exist with the canonical content digest, and the display envelope must never move.
     * A later re-delivery after the gate contention settles the task exactly once, and a
     * further identical re-delivery is an idempotent ACK that changes nothing.
     */
    @Test
    void concurrentSameReportReceiptsExactlyOnceWhileTheGateIsHeld() throws Exception {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try (ProjectLifecycleGate.Lease contention = h.gate.tryAcquire(PROJECT).orElseThrow()) {
                java.util.concurrent.Callable<Throwable> delivery =
                    () -> catchThrowable(() -> h.submitTerminal(37, "COMPLETED"));
                var first = pool.submit(delivery);
                var second = pool.submit(delivery);
                Throwable firstRefusal = first.get(10, TimeUnit.SECONDS);
                assertThat(firstRefusal)
                    .as("the first concurrent delivery must be receipted without the project"
                        + " gate (refused with: %s)", firstRefusal)
                    .isNull();
                Throwable secondRefusal = second.get(10, TimeUnit.SECONDS);
                assertThat(secondRefusal)
                    .as("the concurrent re-delivery of the same report must be receipted"
                        + " (refused with: %s)", secondRefusal)
                    .isNull();
                // Exactly one durable receipt with the canonical content digest; the
                // envelope keeps its real head.
                assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
                assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
                assertThat(h.rowSummary()).isEqualTo(SUMMARY);
                assertThat(h.receiptSha256()).isEqualTo(canonicalDigest(
                    1, expectedLegacyReportId(h), "COMPLETED", SUMMARY, null));
                assertThat(h.progressCount()).isEqualTo(36);
            } finally {
                pool.shutdownNow();
            }
            // ONE re-delivery settles the parked receipt; a further identical re-delivery
            // is an idempotent ACK that changes nothing.
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The legitimate late result of an already-closed execution (acceptance case D): it is
     * acknowledged as CLOSING and must never revive or overwrite the close — the state,
     * the failure code and the durable close reason stay exactly as the close decided
     * them, while the late report's identity is recorded as the refused one.
     */
    @Test
    void lateReportAfterAClosedTaskAcknowledgesClosingWithoutReversal() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            h.service.close(h.taskId, "AI_CLOSED", "closed by operator");
            assertThat(h.rowState()).isEqualTo("FAILED");
            Throwable refusal = catchThrowable(() -> h.submitTerminal(37, "COMPLETED"));
            assertThat(refusal)
                .as("the late report of a closed execution must be acknowledged, not refused"
                    + " (refused with: %s)", refusal)
                .isNull();
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
            h.tasks.requireBrowserWritable(PROJECT);
            // The late report's identity is stored as the refused one; the same report
            // re-delivered stays an idempotent CLOSING answer.
            assertThat(h.receiptSha256()).isEqualTo(canonicalDigest(
                1, expectedLegacyReportId(h), "COMPLETED", SUMMARY, null));
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
        }
    }

    /**
     * The receipt identity must hold the canonical bytes for Unicode summaries: the
     * shared cross-language vector (Chinese, emoji, quotes, slash, newline) survives the
     * receipt and settlement exactly, and the durable digest is the one the TS worker
     * computes from the same array.
     */
    @Test
    void unicodeTerminalSummaryKeepsCanonicalIdentityAndExactText() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            h.submitTerminal(37, "COMPLETED", UNICODE_SUMMARY, null);
            // The receipt content digest is the canonical array digest, and the summary
            // is preserved byte for byte through receipt and settlement.
            assertThat(h.receiptSha256()).isEqualTo(canonicalDigest(
                1, expectedLegacyReportId(h), "COMPLETED", UNICODE_SUMMARY, null));
            assertThat(h.rowSummary()).isEqualTo(UNICODE_SUMMARY);
            h.submitTerminal(37, "COMPLETED", UNICODE_SUMMARY, null);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.rowSummary()).isEqualTo(UNICODE_SUMMARY);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The complete terminal JSON is bounded at 8 KiB including escaping overhead
     * (design contract 4): an oversized summary is refused with nothing recorded, and
     * the task stays RUNNING — no half receipt, no settlement.
     */
    @Test
    void terminalOverTheCompleteJsonBoundIsRefusedWithoutReceipt() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            String oversized = "字".repeat(3000);
            Throwable refusal = catchThrowable(
                () -> h.submitTerminal(37, "COMPLETED", oversized, null));
            assertThat(refusal).isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("AI_PROGRESS_TOO_LARGE"));
            assertThat(h.rowState()).isEqualTo("RUNNING");
            assertThat(h.progressCount()).isEqualTo(36);
            assertThat(h.receiptReportId()).isNull();
        }
    }

    /**
     * The receipt freeze must hold at every FINAL side-effect creation gate even for a
     * permission that was read BEFORE the receipt landed (design contract 1/2): a
     * brand-new tool registration, the build create reservation and the application Run
     * reservation are all refused once the receipt has parked the task.
     */
    @Test
    void receiptFreezeBlocksEveryFinalSideEffectCreationGate() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            // A build call and an application start registered while the task was still
            // RUNNING, with their resource creation still pending. The rows are inserted
            // directly (the established Harness pattern): registering the second through
            // the ledger would trip the one-unsettled-call rule, which is not what this
            // test exercises.
            String runId = UUID.randomUUID().toString();
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'frozen-build', ?, 'build', '{"goal":"compile"}', 'RUNNING', 'frozen-command-id', 7, ?, ?)
                """, h.taskId, "b".repeat(64), now, now);
            h.jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'frozen-start', ?, 'application', '{"action":"start"}', 'REGISTERED', ?, 7, ?, ?)
                """, h.taskId, "c".repeat(64), runId, now, now);
            // A gapped terminal is receipted without the display continuity: the task
            // parks under the pending marker.
            Throwable refusal = catchThrowable(() -> h.submitTerminal(38, "COMPLETED"));
            assertThat(refusal)
                .as("the gapped terminal must be receipted (refused with: %s)", refusal)
                .isNull();
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            // (a) a brand-new tool registration is refused.
            assertThatThrownBy(() -> h.service.invokeTool(h.taskId, "post-terminal-call",
                    INSTANCE, 1, new ToolRequest("post-terminal-call", "list_files", 7,
                        JSON.createObjectNode())))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
            // (b) the pending build create reservation is refused.
            var build = new AgentContracts.BuildRequest(h.taskId, "frozen-build", PROJECT,
                "frozen-command-id", 7, AgentContracts.BuildGoal.COMPILE);
            Object buildReservation = h.tasks.createBuildIfAllowed(build, () -> {
                throw new AssertionError("the frozen receipt must not authorize a build create");
            });
            assertThat(buildReservation).isNull();
            // (c) the pending application Run reservation is refused.
            assertThatThrownBy(() -> h.tasks.requireAgentRunCall(h.taskId, PROJECT, "frozen-start",
                    "start", runId))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_NOT_ACTIVE"));
        }
    }

    /**
     * The budget deadline is close-first for reports that arrive without an earlier
     * receipt (design contract 6): the receiving transaction records the budget close
     * intent from the BACKEND clock and answers CLOSING, never trusting the worker's
     * completion time for a retroactive waiver. A report receipted BEFORE the deadline
     * keeps settling after it, and a re-delivery after the budget close stays CLOSING
     * without overwriting the reason.
     */
    @Test
    void aReportAtTheDeadlineRecordsTheBudgetCloseAndKeepsClosing() {
        MutableClock settledBeforeDeadline = new MutableClock(Instant.parse("2026-10-25T00:00:00Z"));
        try (SettlementHarness h = new SettlementHarness(settledBeforeDeadline)) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            settledBeforeDeadline.advance(java.time.Duration.ofSeconds(3600));
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.closeReasonCode()).isNull();
        }
        MutableClock pastDeadline = new MutableClock(Instant.parse("2026-10-25T00:00:00Z"));
        try (SettlementHarness h = new SettlementHarness(pastDeadline)) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            pastDeadline.advance(java.time.Duration.ofSeconds(3600));
            Throwable refusal = catchThrowable(() -> h.submitTerminal(37, "COMPLETED"));
            assertThat(refusal)
                .as("the report at the deadline must be acknowledged CLOSING (refused with: %s)",
                    refusal)
                .isNull();
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_CLOSING");
            assertThat(h.closeReasonCode()).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
            assertThat(h.nextReconcileAt()).isNotNull();
            // The re-delivery stays CLOSING and never overwrites the budget reason.
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.closeReasonCode()).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
        }
    }

    // ------------------------------------------------------------------
    // Task 3: the unified settlement driver (repair design section 6).
    // reconcile(taskId) drives every stored receipt, user close and budget
    // close through the existing business verification; the completion of
    // a parked receipt is a CAS matching the receipt identity/digest with
    // no close intent; a close persists its intent and finishes in
    // re-entrant single steps without any 120s wait.
    // ------------------------------------------------------------------

    /** Progress 1..36 followed by one gapped authenticated terminal that parks the receipt. */
    private static void parkReceipt(SettlementHarness h, String state, String summary, String failureCode) {
        for (long seq = 1; seq <= 36; seq++) {
            h.recordProgress(seq);
        }
        h.submitTerminal(38, state, summary, failureCode);
        assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
        assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
    }

    private static com.manao.poc4.run.RunSummary runSummary(String id, String state, boolean ready) {
        return new com.manao.poc4.run.RunSummary(id, state, "7", JSON.createObjectNode(),
            "2026-10-25T00:00:00Z", null, "CANCELLED".equals(state) ? "2026-10-25T00:01:00Z" : null,
            null, null, false, 0, null, ready ? "2026-10-25T00:00:00Z" : null, null);
    }

    /**
     * The settlement survives a process restart (acceptance case D): a receipt parked
     * before the interruption is driven to its verified completion by a settlement
     * service rebuilt over nothing but the same database — no browser, no re-delivery,
     * no second model or tool side effect. A repeated reconcile of the settled task is
     * a no-op.
     */
    @Test
    void reconcileSettlesAParkedReceiptAfterTheProcessRestarts() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            h.rebuiltSettlement().reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            assertThat(h.rowFailureCode()).isNull();
            h.tasks.requireBrowserWritable(PROJECT);
            // A repeated reconcile after the settled task changes nothing.
            h.rebuiltSettlement().reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.closeReasonCode()).isNull();
        }
    }

    /**
     * The verified success completes WITHOUT touching the task's READY application
     * (acceptance case H): no stop request ever reaches the worker or the Run authority,
     * and a repeated reconcile never repeats a side effect.
     */
    @Test
    void reconcileCompletesTheSuccessWithoutTouchingTheReadyApplication() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            String runId = UUID.randomUUID().toString();
            h.insertCompletedStartCall("start-ready", runId);
            var ready = runSummary(runId, "RUNNING", true);
            Mockito.when(h.runs.get(OWNER, PROJECT, runId)).thenReturn(ready);
            Mockito.when(h.runs.active(OWNER, PROJECT)).thenReturn(java.util.Optional.of(ready));
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            Mockito.verify(h.runs, Mockito.never()).stopForAgent(Mockito.any(), Mockito.any(),
                Mockito.any(), Mockito.any(), Mockito.any());
            Mockito.verify(h.worker, Mockito.never()).stop(Mockito.any());
            h.tasks.requireBrowserWritable(PROJECT);
            // The repeated reconcile never repeats a side effect.
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            Mockito.verify(h.runs, Mockito.never()).stopForAgent(Mockito.any(), Mockito.any(),
                Mockito.any(), Mockito.any(), Mockito.any());
        }
    }

    /**
     * An unresolved effect keeps the occupancy through reconcile (acceptance case G):
     * a REGISTERED call, a NEEDS_ATTENTION call with an unknown outcome, a PENDING
     * workspace receipt and a live execution claim each hold the task parked under the
     * pending marker; once the effect settles durably, the next reconcile completes the
     * task exactly once.
     */
    @Test
    void reconcileKeepsTheOccupancyWhileAnyEffectIsUnresolved() {
        // (a) a REGISTERED call that never executed.
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'call-registered', ?, 'list_files', '{}', 'REGISTERED', NULL, 7, ?, ?)
                """, h.taskId, "a".repeat(64), now, now);
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            h.tasks.completeToolCall(h.taskId, "call-registered", "{}");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
        // (b) a NEEDS_ATTENTION call whose outcome is unknown.
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'call-unknown', ?, 'list_files', '{}', 'NEEDS_ATTENTION', NULL, 7, ?, ?)
                """, h.taskId, "a".repeat(64), now, now);
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            h.tasks.completeToolCall(h.taskId, "call-unknown", "{}");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
        }
        // (c) a PENDING workspace receipt of an unverified write.
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            h.insertPendingReceiptCall("call-write", "op-pending");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            h.jdbc.update("UPDATE workspace_operation SET state = 'COMMITTED' WHERE id = 'op-pending'");
            h.tasks.completeToolCall(h.taskId, "call-write", "{}");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
        // (d) a live execution claim of the parked task.
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            Timestamp now = new Timestamp(System.currentTimeMillis());
            h.jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, 'call-build', ?, 'build', '{"goal":"compile"}', 'REGISTERED', 'cmd-live', 7, ?, ?)
                """, h.taskId, "a".repeat(64), now, now);
            assertThat(h.tasks.markToolCallRunning(h.taskId, "call-build")).isTrue();
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            h.settlement.reconcile(h.taskId);
            // The executing claim holds the occupancy; nothing is settled under it.
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            assertThat(h.callRowState("call-build")).isEqualTo("RUNNING");
            // The execution settles durably and retires its claim; the next reconcile completes.
            h.tasks.completeToolCall(h.taskId, "call-build", "{}");
            h.tasks.releaseBuildClaim(h.taskId, "call-build");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * A parked FAILED receipt drives the close through reconcile: the close intent is
     * persisted from the receipt's own failure code, the worker is stopped, and the
     * verified cessation releases the project with the original failure retained. The
     * cleanup stays scoped to the durable owner's identity.
     */
    @Test
    void aParkedFailedReceiptDrivesTheCloseThroughReconcile() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "FAILED", "provider exploded", "AI_PROVIDER_ERROR");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_PROVIDER_ERROR");
            assertThat(h.closeReasonCode()).isEqualTo("AI_PROVIDER_ERROR");
            assertThat(h.rowSummary()).isEqualTo("provider exploded");
            Mockito.verify(h.worker).stop(h.taskId);
            h.tasks.requireBrowserWritable(PROJECT);
            // A repeated reconcile of the settled task never overwrites the reason.
            h.settlement.reconcile(h.taskId);
            assertThat(h.closeReasonCode()).isEqualTo("AI_PROVIDER_ERROR");
            assertThat(h.rowState()).isEqualTo("FAILED");
        }
    }

    /**
     * An unanswerable worker stop never blocks a close whose durable evidence verifies
     * (the "stop unknown" delivery): the worker may already be gone when the close is
     * driven, and the armed marker already refuses every new call — so the settlement
     * still completes on the verified Run/build/claim evidence and releases the project
     * with the original failure retained.
     */
    @Test
    void aCloseWithAnUnanswerableWorkerStopStillFinishesOnVerifiedEvidence() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "FAILED", "provider exploded", "AI_PROVIDER_ERROR");
            Mockito.doThrow(new RuntimeException("worker is gone")).when(h.worker).stop(h.taskId);
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_PROVIDER_ERROR");
            assertThat(h.closeReasonCode()).isEqualTo("AI_PROVIDER_ERROR");
            Mockito.verify(h.worker).stop(h.taskId);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * A budget close intent recorded at the deadline finishes through reconcile: the
     * persisted reason becomes the final failure once the cessation is verified, and
     * the occupancy is released only then.
     */
    @Test
    void theBudgetCloseIntentFinishesThroughReconcile() {
        MutableClock pastDeadline = new MutableClock(Instant.parse("2026-10-25T00:00:00Z"));
        try (SettlementHarness h = new SettlementHarness(pastDeadline)) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            pastDeadline.advance(java.time.Duration.ofSeconds(3600));
            h.submitTerminal(37, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.CLOSING_MARKER);
            assertThat(h.closeReasonCode()).isEqualTo(AgentTaskStore.BUDGET_CLOSE_REASON);
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.BUDGET_CLOSE_REASON);
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * A user close beats a parked success (acceptance case I): the fast close persists
     * its intent, the late re-delivery of the SAME report answers CLOSING and changes
     * nothing, and the reconcile of the settled task is a no-op.
     */
    @Test
    void aUserCloseBeatsAParkedSuccessAndTheLateReportCannotReverseIt() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            h.service.close(h.taskId, "AI_CLOSED", "closed by the owner");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
            h.submitTerminal(38, "COMPLETED");
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.closeReasonCode()).isEqualTo("AI_CLOSED");
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The completion CAS matches ONLY the stored receipt identity and canonical content
     * digest of a task that carries no close intent (repair plan task 3): a foreign id
     * or digest never completes, an armed close intent blocks the completion, the exact
     * receipt completes exactly once, and a settled task is never completed again.
     */
    @Test
    void theCompletionCasMatchesOnlyTheReceiptIdentityWithoutACloseIntent() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            String reportId = h.receiptReportId();
            String sha = h.receiptSha256();
            // An armed close intent blocks the completion CAS.
            h.tasks.beginClose(h.taskId);
            assertThat(h.tasks.completeFromReceipt(h.taskId, reportId, sha, SUMMARY, null)).isFalse();
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.CLOSING_MARKER);
        }
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            String reportId = h.receiptReportId();
            String sha = h.receiptSha256();
            // A foreign report id or a foreign digest never completes the task.
            assertThat(h.tasks.completeFromReceipt(h.taskId, "f".repeat(64), sha, SUMMARY, null)).isFalse();
            assertThat(h.tasks.completeFromReceipt(h.taskId, reportId, "e".repeat(64), SUMMARY, null)).isFalse();
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            // The exact receipt identity and digest complete it exactly once.
            assertThat(h.tasks.completeFromReceipt(h.taskId, reportId, sha, SUMMARY, null)).isTrue();
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            assertThat(h.tasks.completeFromReceipt(h.taskId, reportId, sha, SUMMARY, null)).isFalse();
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * A replaced application identity holds the success back (acceptance cases G/H): a
     * COMPLETED start whose READY run is no longer the project's active Run is an
     * unresolved effect — the occupancy is retained until the task's own run is the
     * active identity again, and the completion never stops anything.
     */
    @Test
    void reconcileKeepsTheOccupancyWhileTheApplicationIdentityWasReplaced() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "COMPLETED", SUMMARY, null);
            String runId = UUID.randomUUID().toString();
            h.insertCompletedStartCall("start-ready", runId);
            var ready = runSummary(runId, "RUNNING", true);
            Mockito.when(h.runs.get(OWNER, PROJECT, runId)).thenReturn(ready);
            // The project's ACTIVE Run is a different run: the task's application
            // identity was replaced — an unresolved effect, never a completed task.
            Mockito.when(h.runs.active(OWNER, PROJECT))
                .thenReturn(java.util.Optional.of(runSummary("replacement", "RUNNING", true)));
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo(AgentTaskStore.TERMINAL_PENDING_MARKER);
            assertThatThrownBy(() -> h.tasks.requireBrowserWritable(PROJECT))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
            // The task's own run is the active identity again: the success completes
            // without ever stopping the application.
            Mockito.when(h.runs.active(OWNER, PROJECT)).thenReturn(java.util.Optional.of(ready));
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            Mockito.verify(h.runs, Mockito.never()).stopForAgent(Mockito.any(), Mockito.any(),
                Mockito.any(), Mockito.any(), Mockito.any());
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * A close intent with an unconfirmed stop keeps the occupancy and returns without
     * waiting (acceptance case F): the stop request is issued once, the unconfirmed run
     * leaves the step deferred, and the next reconcile round finishes the verified
     * cessation — cleanup always scoped to the durable owner's identity.
     */
    @Test
    void aCloseIntentWithAnUnconfirmedStopStaysOccupiedUntilTheCessationIsVerified() {
        try (SettlementHarness h = new SettlementHarness()) {
            parkReceipt(h, "FAILED", "provider exploded", "AI_PROVIDER_ERROR");
            String runId = UUID.randomUUID().toString();
            h.insertCompletedStartCall("start-done", runId);
            Mockito.when(h.runs.get(OWNER, PROJECT, runId)).thenReturn(runSummary(runId, "STOPPING", false));
            Mockito.when(h.runs.stopForAgent(OWNER, PROJECT, h.taskId, "start-done", runId))
                .thenReturn(runSummary(runId, "STOPPING", false));
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.closeReasonCode()).isEqualTo("AI_PROVIDER_ERROR");
            // The deferral is durable: the next reconcile round is marked on the row.
            assertThat(h.nextReconcileAt()).isNotNull();
            Mockito.verify(h.runs).stopForAgent(OWNER, PROJECT, h.taskId, "start-done", runId);
            // cleanupRun's read plus exactly ONE post-stop re-read: no wait loop.
            Mockito.verify(h.runs, Mockito.times(2)).get(OWNER, PROJECT, runId);
            Mockito.verify(h.runs, Mockito.never()).stopForAgent(Mockito.eq("other-owner"),
                Mockito.any(), Mockito.any(), Mockito.any(), Mockito.any());
            // The verified cessation releases on the next round.
            Mockito.when(h.runs.get(OWNER, PROJECT, runId)).thenReturn(runSummary(runId, "CANCELLED", false));
            h.settlement.reconcile(h.taskId);
            assertThat(h.rowState()).isEqualTo("FAILED");
            assertThat(h.rowFailureCode()).isEqualTo("AI_PROVIDER_ERROR");
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The test's own canonical digest over the fixed JSON array form, independent of the
     * production code and of Jackson (whose default generator escapes non-BMP
     * characters): exactly the JSON.stringify semantics the TS worker uses.
     */
    private static String canonicalDigest(Object... parts) {
        StringBuilder builder = new StringBuilder("[");
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) {
                builder.append(',');
            }
            Object part = parts[i];
            if (part == null) {
                builder.append("null");
            } else if (part instanceof Integer || part instanceof Long) {
                builder.append(part);
            } else {
                builder.append('"');
                for (char c : part.toString().toCharArray()) {
                    switch (c) {
                        case '"' -> builder.append("\\\"");
                        case '\\' -> builder.append("\\\\");
                        case '\n' -> builder.append("\\n");
                        case '\r' -> builder.append("\\r");
                        case '\t' -> builder.append("\\t");
                        case '\b' -> builder.append("\\b");
                        case '\f' -> builder.append("\\f");
                        default -> {
                            if (c < 0x20) {
                                builder.append(String.format("\\u%04x", (int) c));
                            } else {
                                builder.append(c);
                            }
                        }
                    }
                }
                builder.append('"');
            }
        }
        builder.append(']');
        try {
            byte[] bytes = builder.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            StringBuilder digest = new StringBuilder();
            for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) {
                digest.append(String.format("%02x", b));
            }
            return digest.toString();
        } catch (Exception ex) {
            throw new IllegalStateException("cannot compute the test digest", ex);
        }
    }

    /** The legacy report identity the receipt entry must derive for this execution. */
    private static String expectedLegacyReportId(SettlementHarness h) {
        return canonicalDigest(1, h.taskId, 1L, h.tasks.requestSha256Of(h.taskId), "terminal");
    }

    /** A mutable clock so a test can reach the 1800s budget deadline without waiting. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(java.time.Duration step) {
            now = now.plus(step);
        }

        @Override public java.time.ZoneId getZone() {
            return java.time.ZoneOffset.UTC;
        }

        @Override public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override public Instant instant() {
            return now;
        }
    }

    /**
     * The new internal terminal route's service contract (design section 4): the report
     * identity is verified against the recomputed execution identity, the first receipt
     * parks the task and answers RECORDED, foreign ids/content/identities are explicit
     * 409s, the re-delivery of the recorded receipt carries the settlement (the lost-ACK
     * retry), and the read-only reconciliation ACK keeps verifying the execution identity.
     */
    @Test
    void terminalEndpointReceiptsSettlesOnRedeliveryAndRefusesForeignIdentity() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            // No receipt yet: the reconciliation read answers empty (the controller maps it to 404).
            assertThat(h.service.storedTerminalAck(h.taskId, INSTANCE, 1)).isEmpty();
            String requestSha = h.tasks.requestSha256Of(h.taskId);
            String reportId = AgentTaskStore.terminalReportId(h.taskId, 1, requestSha);
            var report = new AgentContracts.TerminalReport(1, reportId,
                AgentContracts.TaskState.COMPLETED, SUMMARY, null);
            var ack = h.service.recordTerminal(h.taskId, INSTANCE, 1, report);
            assertThat(ack.reportId()).isEqualTo(reportId);
            assertThat(ack.reportSha256()).isEqualTo(h.receiptSha256());
            assertThat(ack.disposition()).isEqualTo(AgentContracts.TerminalDisposition.RECORDED);
            assertThat(h.rowState()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.rowFailureCode()).isEqualTo("AI_TERMINAL_PENDING");
            // A forged report id under the same execution is refused before any effect.
            assertThatThrownBy(() -> h.service.recordTerminal(h.taskId, INSTANCE, 1,
                    new AgentContracts.TerminalReport(1, "f".repeat(64),
                        AgentContracts.TaskState.COMPLETED, SUMMARY, null)))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_IDENTITY"));
            // Same id, different content: an explicit conflict, the receipt unchanged.
            assertThatThrownBy(() -> h.service.recordTerminal(h.taskId, INSTANCE, 1,
                    new AgentContracts.TerminalReport(1, reportId,
                        AgentContracts.TaskState.FAILED, "different", "AI_PROVIDER_ERROR")))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_MISMATCH"));
            assertThat(h.rowSummary()).isEqualTo(SUMMARY);
            // Wrong execution identity is refused by the shared fencing checks.
            assertThatThrownBy(() -> h.service.recordTerminal(h.taskId, "other-worker", 1, report))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_INSTANCE_MISMATCH"));
            assertThatThrownBy(() -> h.service.recordTerminal(h.taskId, INSTANCE, 9, report))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_EPOCH_MISMATCH"));
            // The re-delivery of the recorded receipt (the lost-ACK retry) settles.
            var settled = h.service.recordTerminal(h.taskId, INSTANCE, 1, report);
            assertThat(settled.disposition()).isEqualTo(AgentContracts.TerminalDisposition.SETTLED);
            assertThat(settled.reportSha256()).isEqualTo(ack.reportSha256());
            assertThat(h.rowState()).isEqualTo("COMPLETED");
            // The read-only reconciliation ACK carries the stored decision and keeps
            // verifying the execution identity.
            assertThat(h.service.storedTerminalAck(h.taskId, INSTANCE, 1))
                .hasValueSatisfying(stored -> {
                    assertThat(stored.reportId()).isEqualTo(reportId);
                    assertThat(stored.reportSha256()).isEqualTo(ack.reportSha256());
                    assertThat(stored.disposition()).isEqualTo(AgentContracts.TerminalDisposition.SETTLED);
                });
            assertThatThrownBy(() -> h.service.storedTerminalAck(h.taskId, "other-worker", 1))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_INSTANCE_MISMATCH"));
            h.tasks.requireBrowserWritable(PROJECT);
        }
    }

    /**
     * The complete terminal JSON is bounded at 8 KiB including escaping overhead on the
     * new route as well: an oversized report is refused 422 with nothing recorded.
     */
    @Test
    void terminalEndpointRefusesAnOversizedCompleteReport() {
        try (SettlementHarness h = new SettlementHarness()) {
            for (long seq = 1; seq <= 36; seq++) {
                h.recordProgress(seq);
            }
            String requestSha = h.tasks.requestSha256Of(h.taskId);
            String reportId = AgentTaskStore.terminalReportId(h.taskId, 1, requestSha);
            var oversized = new AgentContracts.TerminalReport(1, reportId,
                AgentContracts.TaskState.COMPLETED, "字".repeat(3000), null);
            assertThatThrownBy(() -> h.service.recordTerminal(h.taskId, INSTANCE, 1, oversized))
                .isInstanceOfSatisfying(ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_TERMINAL_TOO_LARGE"));
            assertThat(h.rowState()).isEqualTo("RUNNING");
            assertThat(h.receiptReportId()).isNull();
        }
    }

    /**
     * Real store, real gate, real project tools over mocked transports; only the external
     * cluster boundary stays mocked per test. Mirrors {@link AgentTaskServiceTest} Harness.
     */
    private static final class SettlementHarness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final JdbcTemplate jdbc = db.jdbc();
        final String taskId = UUID.randomUUID().toString();
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final AgentProjectTools tools;
        final AgentTaskService service;
        final AgentTaskSettlementService settlement;
        final PiWorkerClient worker = Mockito.mock(PiWorkerClient.class);
        final com.manao.poc4.run.RunService runs = Mockito.mock(com.manao.poc4.run.RunService.class);
        final com.manao.poc4.run.RunStore runStore = Mockito.mock(com.manao.poc4.run.RunStore.class);
        final com.manao.poc4.log.RunLogService logs = Mockito.mock(com.manao.poc4.log.RunLogService.class);
        final ProjectApplicationProbe probe = Mockito.mock(ProjectApplicationProbe.class);
        private final JdbcRunStore jdbcRunStore;

        SettlementHarness() {
            this(Clock.systemUTC());
        }

        SettlementHarness(Clock clock) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'unused', ?)",
                OWNER, OWNER, now);
            jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                    + " VALUES (?, ?, ?, 'READY', 7, ?, ?)", PROJECT, OWNER, PROJECT, now, now);
            tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()),
                clock);
            WorkspaceAgent agent = Mockito.mock(WorkspaceAgent.class);
            Mockito.when(agent.tree(Mockito.eq(PROJECT), Mockito.anyString()))
                .thenReturn(new WorkspaceAgent.Tree("", List.of()));
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(jdbc,
                new DataSourceTransactionManager(jdbc.getDataSource()));
            WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, gate);
            WorkspaceService workspace = new WorkspaceService(store, operations, agent, gate, tasks);
            tools = new AgentProjectTools(tasks, store, workspace, operations, gate,
                Mockito.mock(DevelopmentBuildExecutor.class),
                new AgentApplicationTools(tasks, runs, runStore, logs, probe, gate));
            service = new AgentTaskService(tasks, gate, worker, tools);
            settlement = new AgentTaskSettlementService(tasks, gate, worker, tools);
            jdbcRunStore = new JdbcRunStore(jdbc);
            // A RUNNING task with its worker identity bound — the authenticated callback state.
            tasks.create(OWNER, PROJECT, new TaskRequest(taskId, "settle the diagnosed race", 7));
            tasks.bindWorkerInstance(taskId, 1, INSTANCE);
        }

        /**
         * A settlement service fully rebuilt over the same database — the post-restart
         * continuation: a fresh store (no inherited in-process claims), fresh tools, the
         * same durable rows. Nothing but the database carries the settlement forward.
         */
        AgentTaskSettlementService rebuiltSettlement() {
            var transactions = new DataSourceTransactionManager(jdbc.getDataSource());
            var rebuiltTasks = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
            WorkspaceAgent agent = Mockito.mock(WorkspaceAgent.class);
            Mockito.when(agent.tree(Mockito.eq(PROJECT), Mockito.anyString()))
                .thenReturn(new WorkspaceAgent.Tree("", List.of()));
            WorkspaceJdbcStore store = new WorkspaceJdbcStore(jdbc, transactions);
            WorkspaceOperationService operations = new WorkspaceOperationService(store, agent, gate);
            WorkspaceService workspace = new WorkspaceService(store, operations, agent, gate, rebuiltTasks);
            AgentProjectTools rebuiltTools = new AgentProjectTools(rebuiltTasks, store, workspace,
                operations, gate, Mockito.mock(DevelopmentBuildExecutor.class),
                new AgentApplicationTools(rebuiltTasks, runs, runStore, logs, probe, gate));
            return new AgentTaskSettlementService(rebuiltTasks, gate, worker, rebuiltTools);
        }

        /** One unverified write call row with its PENDING workspace receipt, inserted directly. */
        void insertPendingReceiptCall(String callId, String operationId) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, ?, ?, 'write_file', '{"path":"src/Demo.java"}', 'REGISTERED', ?, 7, ?, ?)
                """, taskId, callId, "a".repeat(64), operationId, now, now);
            jdbc.update("""
                INSERT INTO workspace_operation(id, project_id, expected_revision, before_sha256, after_sha256,
                    receipt_path, receipt_sha256, state, created_at)
                VALUES (?, ?, 7, ?, ?, ?, ?, 'PENDING', ?)
                """, operationId, PROJECT, "b".repeat(64), "c".repeat(64),
                ".manao/receipts/" + operationId + ".json", "d".repeat(64), now);
        }

        /** A settled application start call row over the given run id. */
        void insertCompletedStartCall(String callId, String runId) {
            Timestamp now = new Timestamp(System.currentTimeMillis());
            jdbc.update("""
                INSERT INTO agent_tool_call(task_id, tool_call_id, request_sha256, tool_name, args_json,
                    state, workspace_operation_id, expected_revision, created_at, updated_at)
                VALUES (?, ?, ?, 'application', '{"action":"start"}', 'COMPLETED', ?, 7, ?, ?)
                """, taskId, callId, "a".repeat(64), runId, now, now);
        }

        /** One authenticated in-order display progress item from the bound worker. */
        void recordProgress(long seq) {
            service.applyProgress(taskId, INSTANCE, 1,
                new ProgressItem(seq, "message", "existing event " + seq, false));
        }

        /** One authenticated terminal report from the bound worker at the given seq. */
        void submitTerminal(long seq, String state) {
            submitTerminal(seq, state, SUMMARY, null);
        }

        /** One authenticated terminal report carrying its own summary and failure code. */
        void submitTerminal(long seq, String state, String summary, String failureCode) {
            var payload = JSON.createObjectNode()
                .put("state", state)
                .put("summary", summary);
            if (failureCode == null) {
                payload.putNull("failureCode");
            } else {
                payload.put("failureCode", failureCode);
            }
            service.applyProgress(taskId, INSTANCE, 1, new ProgressItem(seq, "terminal", payload.toString(), false));
        }

        /** A RUNNING SERVICE run row over the real run store, ready for recovery. */
        String seedRunningServiceRun() {
            var budget = new RunPolicy.Resources(1000, 1073741824L, 1073741824L);
            var policy = new RunPolicy("java-spring-boot-web", new RunPolicy.RuntimeInfo.Java(17, 3),
                "mvn -q -DskipTests spring-boot:run", 1800, "SERVICE", 1800, 7200, budget, budget);
            long fence = jdbcRunStore.acquireFencingToken().orElseThrow();
            String runId = UUID.randomUUID().toString();
            var created = new RunRecord(runId, PROJECT, 7, RunState.STARTING, policy.toJson(),
                null, null, null, null, null, null, 0, Instant.now(), fence);
            jdbcRunStore.insertRun(created, fence);
            jdbcRunStore.markRunning(runId, PROJECT, 0);
            return runId;
        }

        JdbcRunStore runStore() {
            return jdbcRunStore;
        }

        String rowState() {
            return jdbc.queryForObject("SELECT state FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowFailureCode() {
            return jdbc.queryForObject("SELECT failure_code FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String rowSummary() {
            return jdbc.queryForObject("SELECT summary FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String callRowState(String callId) {
            return jdbc.queryForObject(
                "SELECT state FROM agent_tool_call WHERE task_id = ? AND tool_call_id = ?",
                String.class, taskId, callId);
        }

        int progressCount() {
            Integer count = jdbc.queryForObject(
                "SELECT JSON_LENGTH(JSON_EXTRACT(progress_json, '$.items')) FROM agent_task WHERE id = ?",
                Integer.class, taskId);
            return count == null ? 0 : count;
        }

        long progressLastSeq() {
            Integer lastSeq = jdbc.queryForObject(
                "SELECT JSON_EXTRACT(progress_json, '$.lastSeq') FROM agent_task WHERE id = ?",
                Integer.class, taskId);
            return lastSeq == null ? 0 : lastSeq;
        }

        String receiptReportId() {
            return jdbc.queryForObject(
                "SELECT terminal_report_id FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String receiptSha256() {
            return jdbc.queryForObject(
                "SELECT terminal_report_sha256 FROM agent_task WHERE id = ?", String.class, taskId);
        }

        String closeReasonCode() {
            return jdbc.queryForObject(
                "SELECT close_reason_code FROM agent_task WHERE id = ?", String.class, taskId);
        }

        Timestamp nextReconcileAt() {
            return jdbc.queryForObject(
                "SELECT next_reconcile_at FROM agent_task WHERE id = ?", Timestamp.class, taskId);
        }

        String runState(String runId) {
            return jdbc.queryForObject("SELECT state FROM run WHERE id = ?", String.class, runId);
        }

        @Override public void close() {
            db.close();
        }
    }
}
