package com.manao.poc4.config;

import com.manao.poc4.log.LogTicketAuthenticator;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWebSocketHandler;
import com.manao.poc4.run.RunService;
import com.manao.poc4.terminal.PtyBridge;
import com.manao.poc4.terminal.TerminalSessionService;
import com.manao.poc4.terminal.TerminalWebSocketHandler;
import java.time.Clock;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** Registers the stage-five same-origin WebSocket endpoints (log and, later, terminal). */
@Configuration
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class WebSocketConfig implements WebSocketConfigurer {
    @Autowired(required = false)
    private RunLogWebSocketHandler runLogWebSocketHandler;

    @Autowired(required = false)
    private TerminalWebSocketHandler terminalWebSocketHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Same-origin contract: only the local Vite dev server origins are accepted; no wildcard.
        List<String> allowed = java.util.Arrays.stream(new String[] {
                "http://localhost:4173", "http://127.0.0.1:4173",
                System.getenv().getOrDefault("MANAO_WS_EXTRA_ORIGIN", "")})
            .filter(origin -> !origin.isBlank()).toList();
        if (runLogWebSocketHandler != null) {
            registry.addHandler(runLogWebSocketHandler, "/api/v1/ws/run-logs")
                .setAllowedOrigins(allowed.toArray(new String[0]));
        }
        if (terminalWebSocketHandler != null) {
            registry.addHandler(terminalWebSocketHandler, "/api/v1/ws/terminals")
                .setAllowedOrigins(allowed.toArray(new String[0]));
        }
    }

    @Bean
    @ConditionalOnBean({RunLogService.class, LogTicketAuthenticator.class, RunService.class})
    RunLogWebSocketHandler runLogWebSocketHandler(RunLogService logService, LogTicketAuthenticator tickets,
                                                  RunService runService) {
        return new RunLogWebSocketHandler(tickets, logService, runService::findSummaryById, Clock.systemUTC());
    }

    @Bean
    @ConditionalOnBean({TerminalSessionService.class, PtyBridge.class, RunService.class, com.manao.poc4.kubernetes.JobCoordinator.class})
    TerminalWebSocketHandler terminalWebSocketHandler(TerminalSessionService sessions, PtyBridge bridge,
                                                      RunService runService, com.manao.poc4.kubernetes.JobCoordinator coordinator) {
        return new TerminalWebSocketHandler(sessions, bridge, runService::findSummaryById, Clock.systemUTC(),
            runId -> coordinator.findLivePod(runId).map(pod ->
                new com.manao.poc4.kubernetes.JobCoordinator.LivePod(pod.podName(), pod.containerName())));
    }
}
