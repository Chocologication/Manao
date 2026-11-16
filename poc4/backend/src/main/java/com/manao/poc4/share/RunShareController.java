package com.manao.poc4.share;

import static com.manao.poc4.share.RunShareContracts.*;
import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@Conditional(SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1")
public final class RunShareController {
    private final RunShareService service;
    public RunShareController(RunShareService service) { this.service = service; }

    @GetMapping("/projects/{projectId}/runs/{runId}/share-preview")
    public Preview preview(Authentication auth, @PathVariable String projectId, @PathVariable String runId) {
        return service.preview(auth.getName(), projectId, runId);
    }

    @PostMapping("/projects/{projectId}/runs/{runId}/shares")
    public ResponseEntity<OwnerShare> publish(Authentication auth, @PathVariable String projectId,
                                            @PathVariable String runId, @RequestBody PublishRequest request) {
        var outcome = service.publish(auth.getName(), projectId, runId, request);
        return ResponseEntity.status(outcome.created() ? 201 : 200).body(outcome.share());
    }

    @GetMapping("/run-shares")
    public SharePage listMine(Authentication auth, @RequestParam(defaultValue = "20") int limit,
                              @RequestParam(required = false) String before) {
        return service.listMine(auth.getName(), limit, before);
    }

    @DeleteMapping("/run-shares/{shareId}")
    public ResponseEntity<Void> revoke(Authentication auth, @PathVariable String shareId) {
        service.revoke(auth.getName(), shareId);
        return ResponseEntity.noContent().build();
    }
}
