package com.manao.poc4.log;

import com.manao.poc4.api.ApiException;
import java.time.Clock;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** Issues single-use, 30-second log tickets bound to the authenticated owner's run. */
@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
public final class RunLogController {
    private final LogTicketService tickets;

    public RunLogController(LogTicketService tickets) {
        this.tickets = tickets;
    }

    @PostMapping(path = "/api/v1/projects/{projectId}/runs/{runId}/log-ticket",
        produces = MediaType.APPLICATION_JSON_VALUE)
    public TicketResponse issueLogTicket(Authentication authentication, @PathVariable String projectId,
                                         @PathVariable String runId) {
        LogTicketService.IssuedTicket ticket = tickets.issue(authentication.getName(), projectId, runId);
        return new TicketResponse(ticket.ticket(), ticket.expiresAt().toString());
    }

    public record TicketResponse(String ticket, String expiresAt) { }
}
