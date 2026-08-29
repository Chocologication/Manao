package com.manao.poc4.terminal;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.manao.poc4.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Issues one terminal reservation (sessionId + ticket) for the run's live application container. */
@RestController
@ConditionalOnBean({TerminalSessionService.class, org.springframework.jdbc.core.JdbcTemplate.class})
public final class TerminalController {
    private final TerminalSessionService sessions;

    public TerminalController(TerminalSessionService sessions) {
        this.sessions = sessions;
    }

    @PostMapping(path = "/api/v1/projects/{projectId}/runs/{runId}/terminal-sessions",
        produces = MediaType.APPLICATION_JSON_VALUE)
    public CreateTerminalSessionResponse create(Authentication authentication, @PathVariable String projectId,
                                                @PathVariable String runId,
                                                @Valid @RequestBody CreateTerminalSessionRequest request) {
        TerminalSessionService.Reservation reservation;
        try {
            reservation = sessions.reserve(request.cols(), request.rows(), authentication.getName(), projectId, runId);
        } catch (ApiException ex) {
            throw ex;
        }
        return new CreateTerminalSessionResponse(reservation.sessionId(), reservation.ticket(),
            reservation.expiresAt().toString());
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record CreateTerminalSessionRequest(@NotNull @Min(1) @Max(500) Integer cols,
                                               @NotNull @Min(1) @Max(200) Integer rows) { }

    public record CreateTerminalSessionResponse(String sessionId, String ticket, String expiresAt) { }
}
