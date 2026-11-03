package com.manao.poc4.ai;

import java.security.Principal;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@org.springframework.context.annotation.Conditional({com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class,com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
public final class AgentImageCapabilitiesController {
    private final com.manao.poc4.workspace.WorkspaceStore projects;
    private final AgentAttachmentService attachments;
    public AgentImageCapabilitiesController(com.manao.poc4.workspace.WorkspaceStore projects,AgentAttachmentService attachments){this.projects=projects;this.attachments=attachments;}
    @GetMapping("/api/v1/projects/{projectId}/ai-capabilities")
    public Map<String,Boolean> capabilities(Principal principal,@PathVariable String projectId){
        if(projects.findProjectForOwner(principal.getName(),projectId)==null)throw new com.manao.poc4.api.ApiException("ENTRY_NOT_FOUND",404,"Project not found");
        return Map.of("imageInput",attachments.imageInputEnabled());
    }
}
