package com.manao.poc4.audit;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Stage-five structured terminal audit listing with keyset pagination. */
@RestController
@ConditionalOnBean({AuditService.class, org.springframework.jdbc.core.JdbcTemplate.class})
public final class AuditController {
    private final AuditService audits;

    public AuditController(AuditService audits) {
        this.audits = audits;
    }

    @GetMapping(path = "/api/v1/projects/{projectId}/runs/{runId}/terminal-audits",
        produces = MediaType.APPLICATION_JSON_VALUE)
    public AuditResponse list(Authentication authentication, @PathVariable String projectId,
                              @PathVariable String runId,
                              @RequestParam(name = "cursor", required = false) String cursor,
                              @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        if (limit < 1 || limit > 100) {
            throw new com.manao.poc4.api.ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        AuditService.AuditPage page = audits.list(runId, cursor, limit);
        return new AuditResponse(page.items().stream()
            .map(record -> new AuditEntry(record.id(), record.sessionId(), record.command(), record.state(),
                record.startedAt().toString(), record.finishedAt() == null ? null : record.finishedAt().toString(),
                record.exitCode()))
            .toList(), page.nextCursor());
    }

    public record AuditEntry(String id, String sessionId, String command, String state, String startedAt,
                             String finishedAt, Integer exitCode) { }

    public record AuditResponse(java.util.List<AuditEntry> items, String nextCursor) { }
}
