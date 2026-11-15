package com.manao.poc4.completion;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.project.ProjectService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.context.annotation.Conditional;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@Conditional(SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/projects/{projectId}/code-completions")
public final class CodeCompletionController {
    private final ProjectService projects;
    private final DeepSeekFimClient client;

    public CodeCompletionController(ProjectService projects, DeepSeekFimClient client) {
        this.projects = projects;
        this.client = client;
    }

    @PostMapping
    public Response complete(Authentication authentication, @PathVariable String projectId,
                             @Valid @RequestBody Request request) {
        var project = projects.get(authentication.getName(), projectId)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Project not found"));
        if (!"READY".equals(project.state())) return new Response(null);
        return new Response(client.complete(request.prefix(), request.suffix()));
    }

    public record Request(@NotNull @Size(max = 16000) String prefix,
                          @NotNull @Size(max = 16000) String suffix) { }
    public record Response(String completion) { }
}
