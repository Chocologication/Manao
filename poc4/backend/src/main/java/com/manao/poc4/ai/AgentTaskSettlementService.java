package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.io.IOException;

/**
 * The unified settlement driver (repair design section 6): every stored terminal
 * receipt, user close and budget close is driven through the existing business
 * verification here — never by the browser's GET and never by ad-hoc cleanup.
 *
 * <p>{@link #reconcile(String)} is ONE re-entrant step. It never waits: an unresolved
 * side effect, an unconfirmed stop or a busy project gate defers the task (the durable
 * {@code next_reconcile_at} marker) and the next round continues from the database —
 * which is also how a settlement survives a process restart. Every external IO (the
 * worker stop, the Run controls, the receipt verification) runs OUTSIDE the project
 * gate and the store monitor; only the short verification recheck and the final CAS
 * take them. A success completion never stops the worker or any READY application:
 * it is pure verification plus the store's receipt-identity CAS.</p>
 */
public final class AgentTaskSettlementService {
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(AgentTaskSettlementService.class);
    private static final java.util.Set<String> SAFE_PULL_CODES=java.util.Set.of(
        "AI_WORKER_NOT_FOUND","AI_WORKER_UNAUTHORIZED","AI_WORKER_BAD_RESPONSE",
        "AI_WORKER_UNREACHABLE","AI_WORKER_IDENTITY_MISMATCH","AI_RECONCILE_DEFERRED");

    private final AgentTaskStore tasks;
    private final ProjectLifecycleGate lifecycle;
    private final PiWorkerClient worker;
    private final AgentProjectTools tools;

    public AgentTaskSettlementService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle,
                                      PiWorkerClient worker, AgentProjectTools tools) {
        this.tasks = tasks;
        this.lifecycle = lifecycle;
        this.worker = worker;
        this.tools = tools;
    }

    /**
     * One re-entrant settlement step for one task. A settled task is a final no-op; a
     * persisted close intent drives the close finishing; a parked receipt settles by
     * its verdict (FAILED enters the close flow, COMPLETED completes only after every
     * side effect verifies); a task with no receipt and no close intent is still
     * executing — the worker status poll and the no-receipt budget close belong to the
     * background scheduler, and nothing is settleable here yet.
     */
    public void reconcile(String taskId) {
        reconcile(taskId,new ReconcileWorkBudget(taskId));
    }

    void reconcile(String taskId, ReconcileWorkBudget budget) {
        tasks.armExpiredBudget(taskId);
        if(ReconcileWorkBudget.inFlight(taskId)) return;
        AgentTaskStore.SettlementView view = tasks.settlementView(taskId);
        if ("COMPLETED".equals(view.state()) || "FAILED".equals(view.state())) {
            return;
        }
        if (AgentTaskStore.hasCloseIntent(view)) {
            settleCloseIntent(taskId, null, null,budget);
            return;
        }
        if(view.terminalReportId()==null) {
            try { importTerminal(taskId,budget); }
            catch(RuntimeException ex) {
                String code=ex instanceof ApiException api && SAFE_PULL_CODES.contains(api.code())
                    ? api.code() : "AI_RECONCILE_UNRESOLVED";
                LOG.warn("taskId={} kind=worker-reconcile code={}",taskId,code);
                tasks.scheduleReconcile(taskId);
                return;
            }
            view=tasks.settlementView(taskId);
            if(AgentTaskStore.hasCloseIntent(view)) { settleCloseIntent(taskId,null,null,budget); return; }
        }
        if (view.terminalReportId() != null) {
            AgentTaskStore.StoredTerminal receipt = tasks.storedTerminalReport(taskId).orElse(null);
            if (receipt == null) {
                // The receipt body is unreadable: defer rather than guess.
                tasks.scheduleReconcile(taskId);
                return;
            }
            if (receipt.state() == AgentContracts.TaskState.FAILED) {
                if (!armCloseIntent(taskId, receipt.failureCode())) {
                    tasks.scheduleReconcile(taskId);
                    return;
                }
                settleCloseIntent(taskId, receipt.failureCode(), receipt.summary(),budget);
                return;
            }
            settleCompletedReceipt(taskId, view, receipt);
        }
    }

    /**
     * The delivery-driven settlement of one parked receipt: FAILED reports enter the
     * close flow (the close intent persists the receipt's own failure code first),
     * reports over unsettled side effects stay parked, and a clear report settles by
     * the store's receipt CAS. The decision needs the project gate; a busy gate leaves
     * the receipt parked for the next re-delivery or the reconcile scan — the refusal
     * is never projected onto the worker.
     */
    public void settleParkedTerminal(String taskId, String reportId, String contentSha256,
                                     AgentContracts.TaskState state, String summary, String failureCode) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        var lease = lifecycle.tryAcquire(owner.projectId());
        if (lease.isEmpty()) {
            return;
        }
        boolean failed = false;
        try (ProjectLifecycleGate.Lease gateLease = lease.get()) {
            synchronized (tasks) {
                if (!tasks.terminalReceiptParked(taskId, reportId, contentSha256)) {
                    return;
                }
                if (state == AgentContracts.TaskState.FAILED) {
                    tasks.beginClose(taskId, failureCode);
                    failed = true;
                } else if (!completeFromVerifiedReceipt(taskId, reportId, contentSha256, summary, failureCode)) {
                    // Side effects still unsettled or a close intent won the race: the
                    // receipt stays parked for the close flow or the reconcile scan; the
                    // project keeps its occupancy.
                }
            }
        }
        if (failed) {
            settleCloseIntent(taskId, failureCode, summary);
        }
    }

    /**
     * One re-entrant close-finishing step: the worker is told to stop on every drive
     * (the marker already refuses every new call and side effect), then the evidence is
     * finished OUTSIDE the project gate and the store monitor — each check exits
     * immediately while a live claim executes or evidence is unknown, marking the next
     * round. The project is released ONLY under the final short gate+monitor recheck
     * when every piece of evidence is provably finished. No step ever waits on a run:
     * the old 120s budget wait is gone, and an unconfirmed stop returns for the next
     * reconcile round.
     */
    public void settleCloseIntent(String taskId, String failureCode, String summary) {
        settleCloseIntent(taskId,failureCode,summary,new ReconcileWorkBudget(taskId));
    }

    private void settleCloseIntent(String taskId, String failureCode, String summary, ReconcileWorkBudget budget) {
        if(ReconcileWorkBudget.inFlight(taskId)) return;
        var candidate = tasks.reconcileCandidate(taskId);
        var closeView = tasks.settlementView(taskId);
        boolean strictStop = "AI_PAUSED_BY_OWNER".equals(closeView.closeReasonCode())
            || "AI_WORKER_RESTARTED".equals(closeView.closeReasonCode());
        // Resource progress must not be starved by repeated slow worker observations.
        boolean finished=false;
        try {
            if(!tasks.hasLiveToolClaims(taskId)) finished=budget.io(() -> tools.finishForClose(taskId))
                && budget.io(() -> tools.finishApplication(taskId));
        } catch(RuntimeException ex) { /* unknown evidence retains occupancy and any live seat */ }
        try {
            budget.io(() -> worker.stop(taskId));
        } catch (RuntimeException ex) {
            // The worker may already be gone; the marker already blocks new calls.
        }
        boolean workerExited = !strictStop;
        if (strictStop) {
            try { workerExited = workerExited(candidate, budget); }
            catch (RuntimeException ex) { /* unknown worker evidence retains occupancy */ }
        }
        if (!finished || !workerExited) {
            tasks.scheduleReconcile(taskId);
            return;
        }
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        var lease = lifecycle.tryAcquire(owner.projectId());
        if (lease.isEmpty()) {
            tasks.scheduleReconcile(taskId);
            return;
        }
        try (ProjectLifecycleGate.Lease gateLease = lease.get()) {
            synchronized (tasks) {
                var current = tasks.reconcileCandidate(taskId);
                if (tasks.hasLiveToolClaims(taskId) || !tools.applicationCanRelease(taskId, false)
                    || strictStop && (current.epoch() != candidate.epoch()
                        || !java.util.Objects.equals(current.instanceId(), candidate.instanceId())
                        || !java.util.Objects.equals(tasks.settlementView(taskId).closeReasonCode(), closeView.closeReasonCode()))) {
                    tasks.scheduleReconcile(taskId);
                    return;
                }
                // The original failure comes from the stored receipt first; the frozen
                // progress envelope stays the source for pre-receipt legacy rows; a close
                // without either falls back to the persisted close reason — the
                // deterministic answer a restarted settlement can still produce.
                TerminalReport original = tasks.storedTerminalReport(taskId)
                    .map(stored -> new TerminalReport(stored.state(), stored.summary(), stored.failureCode()))
                    .filter(report -> report.state() == AgentContracts.TaskState.FAILED)
                    .orElseGet(() -> tasks.terminalProgress(taskId)
                        .map(item -> parseTerminal(item.text()))
                        .filter(report -> report.state() == AgentContracts.TaskState.FAILED)
                        .orElse(null));
                String code = original == null
                    ? (closeView.closeReasonCode() != null ? closeView.closeReasonCode()
                        : failureCode != null ? failureCode : fallbackCloseCode(taskId))
                    : original.failureCode();
                String text = original == null
                    ? (summary != null ? summary : fallbackCloseCode(taskId))
                    : original.summary();
                tasks.failClosedTask(taskId, code, text);
            }
        }
    }

    /** Observe execution and delivery independently of resource cleanup; no stop response is proof. */
    private boolean workerExited(AgentTaskStore.ReconcileCandidate candidate, ReconcileWorkBudget budget) {
        if (candidate.instanceId() == null) return false;
        var process = budget.io(worker::processStatus);
        validateProcess(process);
        if (!candidate.instanceId().equals(process.instanceId())) {
            try { budget.io(() -> worker.status(candidate.taskId())); return false; }
            catch (ApiException ex) {
                return "AI_WORKER_NOT_FOUND".equals(ex.code()) && stableReplacement(candidate, process, budget);
            }
        }
        AgentContracts.WorkerStatus status;
        try { status = budget.io(() -> worker.status(candidate.taskId())); }
        catch (ApiException ex) {
            var stored = tasks.settlementView(candidate.taskId());
            return "AI_WORKER_NOT_FOUND".equals(ex.code()) && stored.terminalReportId() != null
                && tasks.storedTerminalReport(candidate.taskId()).isPresent()
                && !candidate.taskId().equals(process.activeTaskId());
        }
        validateStatus(candidate, process, status);
        if (!"COMPLETED".equals(status.executionState()) && !"FAILED".equals(status.executionState())) return false;
        var delivery = status.terminalDelivery();
        var report = validatedReport(status);
        recordObserved(candidate, report);
        return ("ACKED".equals(delivery.state()) || "CLOSING".equals(delivery.state()))
            && !candidate.taskId().equals(process.activeTaskId());
    }

    private static void validateProcess(AgentContracts.WorkerProcessStatus process) {
        if (process == null || process.bootId() == null || process.bootId().isBlank()
            || process.instanceId() == null || !process.instanceId().endsWith("-" + process.bootId())) throw badWorker();
    }

    private static void validateStatus(AgentTaskStore.ReconcileCandidate candidate,
            AgentContracts.WorkerProcessStatus process, AgentContracts.WorkerStatus status) {
        if (status == null || !candidate.taskId().equals(status.taskId()) || !process.instanceId().equals(status.instanceId())
            || candidate.instanceId() != null && !candidate.instanceId().equals(status.instanceId())
            || !Integer.valueOf(1).equals(status.protocolVersion()) || !Long.valueOf(candidate.epoch()).equals(status.workerEpoch())
            || !candidate.requestSha256().equals(status.requestSha256()) || status.executionState() == null
            || !status.executionState().equals(status.state())) throw badWorker();
    }

    private static AgentContracts.TerminalReport validatedReport(AgentContracts.WorkerStatus status) {
        var delivery = status.terminalDelivery();
        var report = delivery == null ? null : delivery.report();
        if (report == null || report.state() == null || !report.state().name().equals(status.executionState())
            || !report.reportId().equals(delivery.reportId())
            || !AgentTaskStore.terminalContentSha256(report.reportId(), report.state(), report.summary(), report.failureCode())
                .equals(delivery.reportSha256())) throw badWorker();
        return report;
    }

    /**
     * The verified success completion (design section 6): live claims, durable unsettled
     * calls, PENDING task-linked receipts and {@code applicationCanRelease(true)} — all
     * four must verify before the receipt CAS completes the task. The verification is
     * pure reading; the READY application of a completed task survives untouched.
     */
    private boolean completeFromVerifiedReceipt(String taskId, String reportId, String contentSha256,
                                                String summary, String failureCode) {
        synchronized (tasks) {
            if (ReconcileWorkBudget.inFlight(taskId) || tasks.hasLiveToolClaims(taskId) || tasks.hasUnsettledCall(taskId)
                || tasks.hasPendingReceipts(taskId) || !tools.applicationCanRelease(taskId, true)) {
                return false;
            }
            return tasks.completeFromReceipt(taskId, reportId, contentSha256, summary, failureCode);
        }
    }

    private void settleCompletedReceipt(String taskId, AgentTaskStore.SettlementView view,
                                        AgentTaskStore.StoredTerminal receipt) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        var lease = lifecycle.tryAcquire(owner.projectId());
        if (lease.isEmpty()) {
            tasks.scheduleReconcile(taskId);
            return;
        }
        try (ProjectLifecycleGate.Lease gateLease = lease.get()) {
            if (!completeFromVerifiedReceipt(taskId, view.terminalReportId(), view.terminalReportSha256(),
                receipt.summary(), receipt.failureCode())) {
                tasks.scheduleReconcile(taskId);
            }
        }
    }

    /** Arms the close intent inside the project gate; false when the gate is busy. */
    private boolean armCloseIntent(String taskId, String reasonCode) {
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        var lease = lifecycle.tryAcquire(owner.projectId());
        if (lease.isEmpty()) {
            return false;
        }
        try (ProjectLifecycleGate.Lease gateLease = lease.get()) {
            tasks.beginClose(taskId, reasonCode);
        }
        return true;
    }

    /** The persisted close reason is the deterministic fallback of a restarted close. */
    private String fallbackCloseCode(String taskId) {
        String reason = tasks.settlementView(taskId).closeReasonCode();
        return reason != null && !reason.isBlank() ? reason : AgentTaskStore.CLOSING_MARKER;
    }

    /** Worker observations are authenticated and complete; never infer terminality from 404 or silence. */
    private void importTerminal(String taskId, ReconcileWorkBudget budget) {
        var candidate=tasks.reconcileCandidate(taskId);
        var legacy=tasks.terminalProgress(taskId);
        if(legacy.isPresent() && candidate.instanceId()!=null) {
            TerminalReport old=parseTerminal(legacy.get().text());
            String id=AgentTaskStore.terminalReportId(taskId,candidate.epoch(),candidate.requestSha256());
            recordObserved(candidate,new AgentContracts.TerminalReport(1,id,old.state(),old.summary(),old.failureCode()));
            return;
        }
        AgentContracts.WorkerProcessStatus process=budget.io(worker::processStatus);
        validateProcess(process);
        AgentContracts.WorkerStatus status;
        try { status = budget.io(() -> worker.status(taskId)); }
        catch (ApiException ex) {
            if (!"AI_WORKER_NOT_FOUND".equals(ex.code()) || !stableReplacement(candidate, process, budget)) throw ex;
            var owner = tasks.taskOwner(taskId);
            var lease = lifecycle.tryAcquire(owner.projectId());
            if (lease.isEmpty()) { tasks.scheduleReconcile(taskId); return; }
            try (var held = lease.get()) {
                tasks.armExpiredBudget(taskId);
                tasks.beginWorkerRestartClose(taskId, candidate.epoch(), candidate.instanceId());
            }
            return;
        }
        validateStatus(candidate, process, status);
        // The bound instance carries the process boot identity. A slot for another task does not
        // invalidate retained terminal history; it may never establish this task's completion.
        if(candidate.instanceId()==null) tasks.requireWorkerIdentity(taskId,candidate.epoch(),status.instanceId());
        if(!"COMPLETED".equals(status.executionState()) && !"FAILED".equals(status.executionState())) return;
        var report = validatedReport(status);
        recordObserved(tasks.reconcileCandidate(taskId),report);
    }

    /** Called only after an authenticated explicit task 404, within the same bounded observation. */
    private boolean stableReplacement(AgentTaskStore.ReconcileCandidate candidate,
            AgentContracts.WorkerProcessStatus first, ReconcileWorkBudget budget) {
        if (candidate.instanceId() == null || candidate.instanceId().equals(first.instanceId())
            || candidate.instanceId().endsWith("-" + first.bootId())
            || candidate.taskId().equals(first.activeTaskId())) return false;
        var second = budget.io(worker::processStatus);
        validateProcess(second);
        return first.bootId().equals(second.bootId()) && first.instanceId().equals(second.instanceId())
            && !candidate.taskId().equals(second.activeTaskId());
    }

    private void recordObserved(AgentTaskStore.ReconcileCandidate candidate,AgentContracts.TerminalReport report) {
        if(report.protocolVersion()!=1 || report.summary()==null
            || !AgentTaskStore.terminalReportId(candidate.taskId(),candidate.epoch(),candidate.requestSha256()).equals(report.reportId())) throw badWorker();
        var json=REPORT_JSON.createObjectNode().put("protocolVersion",1).put("state",report.state().name()).put("summary",report.summary());
        if(report.failureCode()==null) json.putNull("failureCode"); else json.put("failureCode",report.failureCode());
        if(json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>8192) throw badWorker();
        tasks.recordTerminal(candidate.taskId(),candidate.epoch(),candidate.instanceId(),report.reportId(),json.toString(),
            report.state(),report.summary(),report.failureCode());
    }

    private static ApiException badWorker() { return new ApiException("AI_WORKER_IDENTITY_MISMATCH",502,"Worker evidence did not match the execution"); }

    /** The normalized terminal verdict behind a receipt or a frozen progress item. */
    record TerminalReport(AgentContracts.TaskState state, String summary, String failureCode) { }

    private static final com.fasterxml.jackson.databind.ObjectMapper REPORT_JSON =
        new com.fasterxml.jackson.databind.ObjectMapper();

    static TerminalReport parseTerminal(String text) {
        try {
            com.fasterxml.jackson.databind.JsonNode node = REPORT_JSON.readTree(text);
            String stateName = node.path("state").asText("");
            if (!"COMPLETED".equals(stateName) && !"FAILED".equals(stateName)) {
                throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
            }
            String summary = node.path("summary").asText(null);
            com.fasterxml.jackson.databind.JsonNode failureCodeNode = node.path("failureCode");
            String failureCode = failureCodeNode.isNull() || failureCodeNode.isMissingNode()
                ? null : failureCodeNode.asText(null);
            return new TerminalReport(AgentContracts.TaskState.valueOf(stateName), summary, failureCode);
        } catch (IOException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }
}
