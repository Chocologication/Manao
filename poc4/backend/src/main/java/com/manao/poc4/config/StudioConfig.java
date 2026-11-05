package com.manao.poc4.config;

import com.manao.poc4.ai.*;
import com.manao.poc4.ai.studio.*;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

@Configuration
@Conditional({SecurityConfig.BackendAuthCondition.class, AiConfig.AiEnabledCondition.class})
public class StudioConfig {
    @Bean StudioSecrets studioSecrets(Environment env) { return new StudioSecrets(env.getProperty("MANAO_AI_CREDENTIAL_KEY", "")); }
    @Bean StudioModelStore studioModelStore(JdbcTemplate jdbc, StudioSecrets secrets) { return new StudioModelStore(jdbc, secrets); }
    @Bean StudioStore studioStore(JdbcTemplate jdbc, PlatformTransactionManager tx) { return new StudioStore(jdbc, tx); }
    @Bean StudioAttachments studioAttachments(StudioStore store, JdbcTemplate jdbc) { return new StudioAttachments(store, jdbc); }
    @Bean StudioProposals studioProposals(JdbcTemplate jdbc, WorkspaceService workspace, StudioModelStore models) { return new StudioProposals(jdbc, workspace, models); }
    @Bean StudioReadTools studioReadTools(WorkspaceService workspace, com.manao.poc4.run.RunStore runs, com.manao.poc4.log.RunLogService logs) { return new StudioReadTools(workspace, runs, logs); }
    @Bean StudioOpenAi studioOpenAi() { return new StudioOpenAi(); }
    @Bean(initMethod = "recover", destroyMethod = "close")
    StudioService studioService(StudioStore store, StudioModelStore models, StudioAttachments attachments, StudioReadTools reads,
                                StudioOpenAi openai, StudioProposals proposals, AgentTaskService tasks, AgentConversationService conversations, ProjectLifecycleGate gate) {
        return new StudioService(store, models, attachments, reads, openai, proposals, tasks, conversations, gate);
    }
    @Bean StudioApply studioApply(StudioStore store, StudioProposals proposals, WorkspaceService workspace, AgentTaskStore tasks, AgentProjectTools tools, ProjectLifecycleGate gate) {
        return new StudioApply(store, proposals, workspace, tasks, tools, gate);
    }
}
