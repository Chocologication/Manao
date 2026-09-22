package com.manao.poc4.project;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.BackendProperties;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/projects")
public final class ProjectController {
    private static final Logger LOG = LoggerFactory.getLogger(ProjectController.class);
    private static final String ENDPOINT_ASSIGNED = "ASSIGNED";
    private static final String ENDPOINT_UNKNOWN = "UNKNOWN";

    private final ProjectService projects;
    private final ProjectProvisioningService provisioning;
    private final ProjectCleanupService cleanup;
    private final PublicEndpointGateway endpoints;
    private final ProjectRuntimeStore runtimeStore;
    private final ProjectDependencies dependencies;
    private final Set<Integer> reservedPublicPorts;
    private final String publicEntryHost;

    public ProjectController(ProjectService projects) { this(projects, null, null, null, null, java.util.Set.of()); }

    public ProjectController(ProjectService projects, ProjectProvisioningService provisioning) {
        this(projects, provisioning, null, null, null, java.util.Set.of());
    }

    @Autowired
    public ProjectController(ProjectService projects, ProjectProvisioningService provisioning,
                             ProjectCleanupService cleanup, PublicEndpointGateway endpoints,
                             ProjectRuntimeStore runtimeStore, ProjectDependencies dependencies,
                             BackendProperties properties) {
        this(projects, provisioning, cleanup, endpoints, runtimeStore, dependencies,
            properties == null
                ? java.util.Set.of()
                : java.util.Set.copyOf(properties.runtimeDeps().reservedPublicPorts()),
            properties == null ? null : properties.runtimeDeps().publicEntryHost());
    }

    public ProjectController(ProjectService projects, ProjectProvisioningService provisioning,
                             ProjectCleanupService cleanup, PublicEndpointGateway endpoints,
                             ProjectRuntimeStore runtimeStore, Set<Integer> reservedPublicPorts) {
        this(projects, provisioning, cleanup, endpoints, runtimeStore, null, reservedPublicPorts, null);
    }

    public ProjectController(ProjectService projects, ProjectProvisioningService provisioning,
                             ProjectCleanupService cleanup, PublicEndpointGateway endpoints,
                             ProjectRuntimeStore runtimeStore, ProjectDependencies dependencies,
                             Set<Integer> reservedPublicPorts, String publicEntryHost) {
        this.projects = projects;
        this.provisioning = provisioning;
        this.cleanup = cleanup;
        this.endpoints = endpoints;
        this.runtimeStore = runtimeStore;
        this.dependencies = dependencies;
        this.reservedPublicPorts = Set.copyOf(reservedPublicPorts);
        this.publicEntryHost = publicEntryHost == null || publicEntryHost.isBlank()
            ? null : publicEntryHost.trim();
    }

    @GetMapping
    public ProjectListResponse list(Authentication authentication) {
        return new ProjectListResponse(projects.list(authentication.getName()).stream().map(this::view).toList(), ProjectLimits.MAX_PROJECTS_PER_OWNER);
    }

    /**
     * Fixed creation order: validate the exact ports against the reserved set -> atomically
     * persist key/digest/CREATING -> apply the port group -> only a confirmed application
     * continues into workspace provisioning. A deterministic conflict cancels the temporary
     * row (quota is free again); an unknown outcome keeps the record queryable. A retry with
     * the same key and digest reuses the stable application; it never creates a second project.
     */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ProjectView create(Authentication authentication, @Valid @RequestBody CreateProjectRequest request) {
        String ownerId = authentication.getName();
        ProjectRuntimeSpec runtime = request.runtime();
        runtime.validate(reservedPublicPorts);
        String creationKey = request.creationKey();
        if (request.configured() && creationKey == null) {
            // A configured form without a creation key would silently drop the config; refuse it.
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        java.util.Optional<ProjectService.Project> created =
            projects.create(ownerId, request.name(), creationKey, runtime);
        if (created.isEmpty() && creationKey != null) {
            // Either the quota or a concurrent duplicate: re-entry resolves the replay (with
            // the digest check) instead of misreporting a lost response as a limit.
            created = projects.create(ownerId, request.name(), creationKey, runtime);
        }
        ProjectService.Project project = created.orElse(null);
        if (project == null) {
            throw new ApiException("PROJECT_LIMIT_REACHED", 409, "Project limit reached");
        }
        if (endpoints != null && !runtime.publicPorts().isEmpty()) {
            PublicEndpointGateway.ApplyResult result;
            try {
                result = endpoints.ensure(project.id(), runtime.publicPorts());
            } catch (RuntimeException ex) {
                // Transport-level unknown: keep the CREATING identity queryable, never blind-retry.
                markEndpointState(project.id(), ENDPOINT_UNKNOWN);
                return view(project);
            }
            if (result == PublicEndpointGateway.ApplyResult.CONFLICT) {
                cancelCreation(ownerId, project.id(), creationKey);
                throw new ApiException("PUBLIC_PORT_IN_USE", 409,
                    "Public port is already in use. Choose another port.");
            }
            if (result == PublicEndpointGateway.ApplyResult.UNKNOWN) {
                markEndpointState(project.id(), ENDPOINT_UNKNOWN);
                return view(project);
            }
            markEndpointState(project.id(), ENDPOINT_ASSIGNED);
        }
        if (provisioning != null) {
            provisioning.provisionAsync(project.id());
        }
        return view(project);
    }

    /** Owner-scoped creation lookup: same key always returns the same project identity. */
    @GetMapping("/creation/{creationKey}")
    public ProjectView findCreation(Authentication authentication, @PathVariable String creationKey) {
        return projects.findCreation(authentication.getName(), creationKey)
            .map(this::view)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Project not found"));
    }

    private void markEndpointState(String projectId, String state) {
        if (runtimeStore != null) {
            runtimeStore.setEndpointState(projectId, state);
        }
    }

    /**
     * A deterministic conflict with no Service left behind cancels this attempt's temporary
     * row so the project quota is not consumed by a rejected form submission. The endpoint
     * state is marked unknown before the rollback: if the rollback fails, the surviving row is
     * visible to the startup recovery scan and the failure is logged with the attempt's
     * identity instead of silently holding quota with no explanation.
     */
    private void cancelCreation(String ownerId, String projectId, String creationKey) {
        markEndpointState(projectId, ENDPOINT_UNKNOWN);
        try {
            projects.deleteProjectRow(ownerId, projectId);
        } catch (RuntimeException ex) {
            LOG.warn("creation rollback failed after a port conflict; the CREATING row stays and "
                    + "the startup recovery scan owns it: projectId={} creationKey={}",
                projectId, creationKey, ex);
        }
    }

    @DeleteMapping("/{projectId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(Authentication authentication, @PathVariable String projectId) {
        if (cleanup == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        cleanup.delete(authentication.getName(), projectId);
    }

    @GetMapping("/{projectId}")
    public ProjectView get(Authentication authentication, @PathVariable String projectId) {
        String ownerId = authentication.getName();
        ProjectService.Project project = projects.get(ownerId, projectId)
            .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Project not found"));
        if (provisioning != null && "READY".equals(project.state())) {
            provisioning.ensureWorkspaceAvailable(projectId);
            project = projects.get(ownerId, projectId)
                .orElseThrow(() -> new ApiException("ENTRY_NOT_FOUND", 404, "Project not found"));
        }
        return view(project);
    }

    /**
     * Browser view: identity and state plus the non-sensitive runtime facts — the runtime
     * configuration, the endpoint application state, live dependency readiness and the public
     * access endpoints. No resource names, credentials or environment values ever appear here.
     */
    private ProjectView view(ProjectService.Project project) {
        String reason = "WORKSPACE_RECONCILIATION_REQUIRED".equals(project.failureReason())
            ? project.failureReason() : null;
        if (ProjectProvisioningService.WORKSPACE_STORAGE_MISSING.equals(project.failureReason())) {
            reason = "Workspace storage is missing. Existing files cannot be accessed.";
        }
        ProjectRuntimeSpec spec = runtimeStore == null
            ? ProjectRuntimeSpec.console() : runtimeStore.loadSpec(project.id());
        String endpointState = runtimeStore == null
            ? ProjectRuntimeStore.ENDPOINT_NONE : runtimeStore.endpointState(project.id());
        ProjectDependencies.DependencyStatus status = dependencies == null
            ? null : dependencies.status(project.id(), spec);
        List<ProjectView.EndpointView> endpointViews = new ArrayList<>();
        for (ProjectRuntimeSpec.Port port : spec.publicPorts()) {
            endpointViews.add(new ProjectView.EndpointView(port.name(), port.targetPort(),
                port.publicPort(), endpointUrl(port.publicPort())));
        }
        return new ProjectView(project.id(), project.name(), project.state(),
            project.createdAt().toString(), reason,
            new ProjectView.RuntimeView(spec.templateId(), spec.mysql(), spec.redis(),
                spec.publicPorts().stream()
                    .map(port -> new ProjectView.PortView(port.name(), port.targetPort(), port.publicPort()))
                    .toList()),
            endpointState,
            status == null ? null : new ProjectView.DependencyView(status.mysql(), status.redis()),
            List.copyOf(endpointViews));
    }

    /** The public entry host is deployment configuration; without it only the ports are known. */
    private String endpointUrl(int publicPort) {
        return publicEntryHost == null ? null : "http://" + publicEntryHost + ":" + publicPort;
    }

    ProjectView getViewForTest(ProjectService.Project project) { return view(project); }

    public record ProjectView(String id, String name, String state, String createdAt, String failureReason,
                              RuntimeView runtime, String endpointState,
                              DependencyView dependencies, List<EndpointView> endpoints) {
        /** The exact requested runtime configuration; the first port decides the primary port. */
        public record RuntimeView(String templateId, boolean mysql, boolean redis,
                                  List<PortView> publicPorts) {}
        public record PortView(String name, int targetPort, int publicPort) {}
        /** Live dependency readiness; a dependency that was never selected stays ABSENT. */
        public record DependencyView(String mysql, String redis) {}
        /** One public access point; the URL needs a deployment-configured public entry host. */
        public record EndpointView(String name, int targetPort, int publicPort, String url) {}
    }
    public record ProjectListResponse(List<ProjectView> items, int limit) {}

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record CreateProjectRequest(@NotBlank @Size(max = 160) String name,
                                       String creationKey, String templateId, Boolean mysql,
                                       Boolean redis, List<ProjectRuntimeSpec.Port> publicPorts) {
        /** True when the request carries any template configuration beyond the legacy name. */
        public boolean configured() {
            return templateId != null || mysql != null || redis != null
                || (publicPorts != null && !publicPorts.isEmpty());
        }

        /** Name-only legacy requests map to the console template; configured forms are structured. */
        public ProjectRuntimeSpec runtime() {
            if (!configured()) {
                return ProjectRuntimeSpec.console();
            }
            return new ProjectRuntimeSpec(
                templateId == null ? ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE : templateId,
                Boolean.TRUE.equals(mysql), Boolean.TRUE.equals(redis),
                publicPorts == null ? List.of() : publicPorts);
        }
    }
}
