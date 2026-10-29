package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.AiConfig.AiEnabledCondition;
import com.manao.poc4.config.SecurityConfig.BackendAuthCondition;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The worker-facing internal routes. Authentication is the separate internal token
 * chain in SecurityConfig (a browser JWT never matches); this controller then
 * validates the worker's fencing identity (epoch and instance) against the durable
 * task before any tool or progress effect. Task identity always resolves through the
 * durable task row — nothing here trusts model- or request-supplied project owner.
 * Every error is a fixed, safe code; no header, endpoint or environment detail is
 * ever echoed.
 */
@RestController
@org.springframework.context.annotation.Conditional({BackendAuthCondition.class, AiEnabledCondition.class})
@RequestMapping("/internal/ai/tasks/{taskId}")
public final class AgentInternalController {
    private final AgentTaskService tasks;
    private final AgentTaskStore store;
    private final AgentLiveOutput live;

    public AgentInternalController(AgentTaskService tasks, AgentTaskStore store, AgentLiveOutput live) {
        this.tasks = tasks;
        this.store = store;
        this.live = live;
    }

    @PostMapping("/live-output")
    public ResponseEntity<Void> liveOutput(@PathVariable String taskId,
            @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
            @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader,
            @RequestBody com.fasterxml.jackson.databind.JsonNode snapshot) {
        store.requireBoundWorkerIdentity(taskId, parseEpoch(epochHeader), instanceId);
        live.accept(taskId, snapshot);
        return ResponseEntity.noContent().build();
    }

    /** Submits one tool invocation; the durable ledger deduplicates replays. */
    @PostMapping("/calls/{toolCallId}")
    public AgentContracts.ToolResult invoke(@PathVariable String taskId, @PathVariable String toolCallId,
                                            @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
                                            @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader,
                                            @RequestBody AgentContracts.ToolRequest request) {
        return tasks.invokeTool(taskId, toolCallId, instanceId, parseEpoch(epochHeader), request);
    }

    /**
     * Reconciliation read of one call: 404 when the id was never registered, otherwise
     * the call's state — RUNNING while it executes, COMPLETED with its durable result,
     * NEEDS_ATTENTION while the outcome is unknown (review fix I3).
     */
    @GetMapping("/calls/{toolCallId}")
    public AgentContracts.ToolCallStatus getCall(@PathVariable String taskId, @PathVariable String toolCallId,
                                                 @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
                                                 @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader) {
        return tasks.toolCallStatus(taskId, toolCallId, instanceId, parseEpoch(epochHeader))
            .orElseThrow(() -> new ApiException("AI_CALL_NOT_FOUND", 404, "Call not found"));
    }

    /**
     * One monotonic progress item; a sequence gap answers 409 with the expected seq
     * so the worker can replay its buffered range. A terminal item is diverted to the
     * receipt entry before the gate and the seq check and answers like any other item.
     */
    @PostMapping("/progress")
    public ResponseEntity<Object> progress(@PathVariable String taskId,
                                           @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
                                           @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader,
                                           @RequestBody AgentContracts.ProgressItem item) {
        try {
            tasks.applyProgress(taskId, instanceId, parseEpoch(epochHeader), item);
            return ResponseEntity.ok(java.util.Map.of("accepted", true));
        } catch (ProgressGapException gap) {
            return ResponseEntity.status(409).body(java.util.Map.of(
                "code", "AI_PROGRESS_GAP", "expectedSeq", gap.expectedSeq()));
        }
    }

    /**
     * One terminal execution report (repair design section 4): the durable receipt entry.
     * The 200 answer carries the committed TerminalAck — RECORDED (the receipt parks the
     * task for verification), SETTLED (the receipt decided the task) or CLOSING (a close
     * intent or the budget deadline governs). Conflicts and foreign identities are
     * explicit 409s, never successes.
     */
    @PostMapping("/terminal")
    public AgentContracts.TerminalAck terminal(@PathVariable String taskId,
            @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
            @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader,
            @RequestBody AgentContracts.TerminalReport report) {
        return tasks.recordTerminal(taskId, instanceId, parseEpoch(epochHeader), report);
    }

    /**
     * Read-only reconciliation of one stored terminal decision: the stored TerminalAck,
     * or 404 while no receipt exists. It never starts a side effect, and the execution
     * identity is verified exactly as for a delivery.
     */
    @GetMapping("/terminal")
    public AgentContracts.TerminalAck terminalAck(@PathVariable String taskId,
            @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
            @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader) {
        return tasks.storedTerminalAck(taskId, instanceId, parseEpoch(epochHeader))
            .orElseThrow(() -> new ApiException("AI_TERMINAL_NOT_FOUND", 404, "Terminal report not found"));
    }

    /** The fencing epoch header: required, a non-negative integer, validated before any effect. */
    private static long parseEpoch(String epochHeader) {
        if (epochHeader == null) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        try {
            long epoch = Long.parseLong(epochHeader);
            if (epoch < 0) {
                throw new NumberFormatException();
            }
            return epoch;
        } catch (NumberFormatException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }
}
