package com.manao.poc4.workspace;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Browser dependency endpoints (design 6.1): one identity per change, a durable COMMITTED answer
 * for lost responses and one reconcile entry per operation. Responses carry opaque business
 * identifiers and fixed states only.
 */
@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/projects/{projectId}")
public final class PythonDependencyController {
    private final PythonDependencyService dependencies;

    public PythonDependencyController(PythonDependencyService dependencies) { this.dependencies = dependencies; }

    @PostMapping("/python-dependencies")
    public StatusResponse change(Authentication authentication, @PathVariable String projectId,
                                 @RequestBody ChangeRequest request) {
        return view(dependencies.change(authentication.getName(), projectId, request.operationId(),
            new WorkspaceAgent.DependencyChange(request.action(), request.packageName(), request.version()),
            request.expectedWorkspaceRevision()));
    }

    /** Batch import: one whole requirements.txt through the same operation/receipt protocol. */
    @PostMapping("/python-dependencies/batch")
    public StatusResponse changeBatch(Authentication authentication, @PathVariable String projectId,
                                      @RequestBody BatchRequest request) {
        return view(dependencies.changeBatch(authentication.getName(), projectId, request.operationId(),
            request.requirementsText(), request.expectedWorkspaceRevision()));
    }

    @GetMapping("/python-dependencies/{operationId}")
    public StatusResponse status(Authentication authentication, @PathVariable String projectId,
                                 @PathVariable String operationId) {
        return view(dependencies.status(authentication.getName(), projectId, operationId));
    }

    @PostMapping("/python-dependencies/{operationId}/reconcile")
    public StatusResponse reconcile(Authentication authentication, @PathVariable String projectId,
                                    @PathVariable String operationId) {
        return view(dependencies.reconcile(authentication.getName(), projectId, operationId));
    }

    @GetMapping("/python-dependencies/pending")
    public PendingResponse pending(Authentication authentication, @PathVariable String projectId) {
        return new PendingResponse(dependencies.pending(authentication.getName(), projectId).stream()
            .map(PythonDependencyController::view).toList());
    }

    private static StatusResponse view(PythonDependencyService.Status status) {
        return new StatusResponse(status.operationId(), status.state(),
            status.resultWorkspaceRevision() == null ? null : Long.toString(status.resultWorkspaceRevision()));
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record StatusResponse(String operationId, String state, String resultWorkspaceRevision) { }

    public record PendingResponse(List<StatusResponse> operations) { }

    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = false)
    public record ChangeRequest(String operationId, String action, String packageName, String version,
                                String expectedWorkspaceRevision) { }

    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = false)
    public record BatchRequest(String operationId, String requirementsText, String expectedWorkspaceRevision) { }
}
