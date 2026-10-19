package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.AiConfig.AiEnabledCondition;
import com.manao.poc4.config.SecurityConfig.BackendAuthCondition;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Conditional;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.AsyncHandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@Conditional({BackendAuthCondition.class, AiEnabledCondition.class})
public final class AgentLiveOutputController implements WebMvcConfigurer {
    private static final String EMITTER_ATTRIBUTE = AgentLiveOutputController.class.getName();
    private final AgentTaskStore tasks;
    private final AgentLiveOutput live;
    public AgentLiveOutputController(AgentTaskStore tasks, AgentLiveOutput live) { this.tasks = tasks; this.live = live; }

    @org.springframework.web.bind.annotation.ExceptionHandler(org.springframework.web.context.request.async.AsyncRequestNotUsableException.class)
    public void disconnected() {
        // The container already owns this failed SSE response; do not write a JSON error to it.
    }

    @GetMapping("/api/v1/projects/{projectId}/agent-tasks/{taskId}/live-output")
    public ResponseEntity<SseEmitter> subscribe(Authentication authentication, @PathVariable String projectId,
            @PathVariable String taskId, HttpServletRequest request, HttpServletResponse response) {
        var task = tasks.findForOwner(authentication.getName(), projectId, taskId)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Task not found"));
        if (task.conversationId() == null)
            throw new ApiException("AI_LIVE_UNSUPPORTED", 409, "Live output requires a conversation");
        SseEmitter emitter = live.subscribe(taskId);
        if (emitter == null) return ResponseEntity.noContent().header("Cache-Control", "no-store").build();
        response.setHeader("Cache-Control", "no-store");
        response.setContentType("text/event-stream");
        request.setAttribute(EMITTER_ATTRIBUTE, emitter);
        return ResponseEntity.ok().header("Cache-Control", "no-store")
            .header("Content-Type", "text/event-stream").body(emitter);
    }

    @Override public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AsyncHandlerInterceptor() {
            @Override public void afterConcurrentHandlingStarted(HttpServletRequest request, HttpServletResponse response, Object handler) throws java.io.IOException {
                if (request.getAttribute(EMITTER_ATTRIBUTE) instanceof SseEmitter emitter) {
                    // Commit security/response headers on the request thread before sender threads write.
                    response.flushBuffer();
                    live.ready(emitter);
                }
            }
        }).addPathPatterns("/api/v1/projects/*/agent-tasks/*/live-output");
    }
}
