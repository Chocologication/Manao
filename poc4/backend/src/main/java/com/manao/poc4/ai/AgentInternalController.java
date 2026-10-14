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

    public AgentInternalController(AgentTaskService tasks) {
        this.tasks = tasks;
    }

    /** Submits one tool invocation; the durable ledger deduplicates replays. */
    @PostMapping("/calls/{toolCallId}")
    public AgentContracts.ToolResult invoke(@PathVariable String taskId, @PathVariable String toolCallId,
                                            @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
                                            @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader,
                                            @RequestBody AgentContracts.ToolRequest request) {
        return tasks.invokeTool(taskId, toolCallId, instanceId, parseEpoch(epochHeader), request);
    }

    /** Reconciliation read of a call whose POST response the worker may have lost. */
    @GetMapping("/calls/{toolCallId}")
    public AgentContracts.ToolResult getCall(@PathVariable String taskId, @PathVariable String toolCallId,
                                             @RequestHeader(value = "X-Manao-Worker-Instance", required = false) String instanceId,
                                             @RequestHeader(value = "X-Manao-Worker-Epoch", required = false) String epochHeader) {
        return tasks.getToolCall(taskId, toolCallId, instanceId, parseEpoch(epochHeader))
            .orElseThrow(() -> new ApiException("AI_CALL_NOT_FOUND", 404, "Call not found"));
    }

    /**
     * One monotonic progress item; a sequence gap answers 409 with the expected seq
     * so the worker can replay its buffered range.
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
