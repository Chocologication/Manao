package com.manao.poc4.config;

import com.manao.poc4.log.LogTicketAuthenticator;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWebSocketHandler;
import com.manao.poc4.run.RunService;
import java.time.Clock;
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

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        if (runLogWebSocketHandler != null) {
            registry.addHandler(runLogWebSocketHandler, "/api/v1/ws/run-logs").setAllowedOriginPatterns("*");
        }
    }

    @Bean
    @ConditionalOnBean({RunLogService.class, LogTicketAuthenticator.class, RunService.class})
    RunLogWebSocketHandler runLogWebSocketHandler(RunLogService logService, LogTicketAuthenticator tickets,
                                                  RunService runService) {
        return new RunLogWebSocketHandler(tickets, logService, runService::findSummaryById, Clock.systemUTC());
    }
}
