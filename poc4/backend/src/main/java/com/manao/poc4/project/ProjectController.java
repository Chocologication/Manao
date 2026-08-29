package com.manao.poc4.project;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.manao.poc4.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnBean({ProjectService.class, org.springframework.jdbc.core.JdbcTemplate.class})
@RequestMapping("/api/v1/projects")
public final class ProjectController {
    private final ProjectService projects;
    private final ProjectProvisioningService provisioning;

    public ProjectController(ProjectService projects) { this(projects, null); }

    @Autowired
    public ProjectController(ProjectService projects, ProjectProvisioningService provisioning) {
        this.projects = projects;
        this.provisioning = provisioning;
    }

    @GetMapping
    public ProjectListResponse list(Authentication authentication) {
        return new ProjectListResponse(projects.list(authentication.getName()).stream().map(ProjectController::view).toList(), 3);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ProjectView create(Authentication authentication, @Valid @RequestBody CreateProjectRequest request) {
        return projects.create(authentication.getName(), request.name())
            .map(project -> {
                if (provisioning != null) {
                    provisioning.provisionAsync(project.id());
                }
                return view(project);
            })
            .orElseThrow(() -> new ApiException("PROJECT_LIMIT_REACHED", 409, "Project limit reached"));
    }

    @GetMapping("/{projectId}")
    public ProjectView get(Authentication authentication, @PathVariable String projectId) {
        return projects.get(authentication.getName(), projectId)
            .map(ProjectController::view)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Project not found"));
    }

    private static ProjectView view(ProjectService.Project project) {
        String reason = "WORKSPACE_RECONCILIATION_REQUIRED".equals(project.failureReason())
            ? project.failureReason() : null;
        return new ProjectView(project.id(), project.name(), project.state(), project.createdAt().toString(), reason);
    }

    static ProjectView getViewForTest(ProjectService.Project project) { return view(project); }

    public record ProjectView(String id, String name, String state, String createdAt, String failureReason) {}
    public record ProjectListResponse(List<ProjectView> items, int limit) {}

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record CreateProjectRequest(@NotBlank @Size(max = 160) String name) {}
}
