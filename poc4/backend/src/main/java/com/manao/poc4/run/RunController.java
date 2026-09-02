package com.manao.poc4.run;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.manao.poc4.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Stage-five Run endpoints. Responses carry opaque IDs, states and the fixed policy snapshot;
 * job/pod references, images and environment never leave the server.
 */
@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/projects/{projectId}/runs")
public final class RunController {
    private final RunService runs;

    public RunController(RunService runs) { this.runs = runs; }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    public RunSummary start(Authentication authentication, @PathVariable String projectId,
                            @Valid @RequestBody StartRunRequest request) {
        return runs.start(authentication.getName(), projectId, request.expectedWorkspaceRevision());
    }

    @PostMapping("/{runId}/stop")
    public RunSummary stop(Authentication authentication, @PathVariable String projectId,
                           @PathVariable String runId) {
        return runs.stop(authentication.getName(), projectId, runId);
    }

    @GetMapping("/active")
    public ActiveRunResponse active(Authentication authentication, @PathVariable String projectId) {
        return new ActiveRunResponse(runs.active(authentication.getName(), projectId).orElse(null));
    }

    @GetMapping
    public RunListResponse list(Authentication authentication, @PathVariable String projectId,
                                @RequestParam(name = "cursor", required = false) String cursor,
                                @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        if (limit < 1 || limit > 100) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        RunService.RunList list = runs.list(authentication.getName(), projectId, limit);
        return new RunListResponse(list.items(), list.nextCursor());
    }

    @GetMapping("/{runId}")
    public RunSummary get(Authentication authentication, @PathVariable String projectId,
                          @PathVariable String runId) {
        return runs.get(authentication.getName(), projectId, runId);
    }

    public record ActiveRunResponse(RunSummary run) { }

    public record RunListResponse(List<RunSummary> items, String nextCursor) { }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record StartRunRequest(@NotBlank String expectedWorkspaceRevision) { }
}
