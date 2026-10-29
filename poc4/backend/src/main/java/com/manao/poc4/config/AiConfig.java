package com.manao.poc4.config;

import com.manao.poc4.ai.AgentProjectTools;
import com.manao.poc4.ai.AgentApplicationTools;
import com.manao.poc4.ai.AgentTaskService;
import com.manao.poc4.ai.AgentTaskStore;
import com.manao.poc4.ai.DevelopmentBuildExecutor;
import com.manao.poc4.ai.Fabric8DevelopmentBuildExecutor;
import com.manao.poc4.ai.HttpPiWorkerClient;
import com.manao.poc4.ai.PiWorkerClient;
import com.manao.poc4.ai.ProjectApplicationProbe;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.time.Clock;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Stage-one AI wiring. Everything here is conditional on {@code manao.poc4.ai.enabled}
 * (default false): with AI disabled none of these beans exist and no internal controller
 * is mapped. The backend never receives a model key — its configuration is only the Pi
 * worker route with its token and the internal token workers must present, following
 * the small {@code @ConfigurationProperties}
 * precedent instead of the large BackendProperties constructor.
 */
@Configuration
@Conditional(SecurityConfig.BackendAuthCondition.class)
@EnableConfigurationProperties(AiConfig.AiProperties.class)
public class AiConfig {

    @ConfigurationProperties(prefix = "manao.poc4.ai", ignoreUnknownFields = false)
    // projectId is accepted for existing deployments only; it no longer limits task admission.
    public record AiProperties(boolean enabled, String projectId, Worker worker, Internal internal) {

        public AiProperties {
            projectId = blank(projectId) ? "" : projectId.trim();
            worker = worker == null ? new Worker("", "") : worker;
            internal = internal == null ? new Internal("") : internal;
        }

        /** The Pi worker the backend drives: its base route and the token to present. */
        public record Worker(String baseUrl, String token) {
            public Worker {
                baseUrl = blank(baseUrl) ? "" : baseUrl.trim();
                token = blank(token) ? "" : token.trim();
            }
        }

        /** The token every worker callback must present on the internal routes. */
        public record Internal(String token) {
            public Internal {
                token = blank(token) ? "" : token.trim();
            }
        }

        private static boolean blank(String value) {
            return value == null || value.isBlank();
        }
    }

    /** AI beans exist only while the switch is explicitly on. */
    public static final class AiEnabledCondition implements org.springframework.context.annotation.Condition {
        @Override public boolean matches(org.springframework.context.annotation.ConditionContext context,
                                        org.springframework.core.type.AnnotatedTypeMetadata metadata) {
            Environment environment = context.getEnvironment();
            return Boolean.parseBoolean(environment.getProperty("manao.poc4.ai.enabled", "false"));
        }
    }

    @Bean(destroyMethod = "")
    @Conditional(AiEnabledCondition.class)
    DevelopmentBuildExecutor developmentBuildExecutor(KubernetesClient client, JobResourceFactory factory,
                                                      BackendProperties properties, AgentTaskStore tasks) {
        // The store owns both durable authorization and the create/close critical section.
        return new Fabric8DevelopmentBuildExecutor(client, factory, properties.kubernetes().namespace(),
            (request, identity) -> tasks.bindToolCallIdentity(request.taskId(), request.toolCallId(),
                identity.jobName(), identity.jobUid(), identity.podUid()),
            tasks::createBuildIfAllowed, request -> AgentTaskStore.hasCloseIntent(tasks.settlementView(request.taskId())));
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    ProjectApplicationProbe projectApplicationProbe(KubernetesClient client, BackendProperties properties,
                                                      com.manao.poc4.project.ProjectRuntimeStore runtime) {
        return new ProjectApplicationProbe(client, properties.kubernetes().namespace(), runtime,
            ProjectApplicationProbe.httpClient());
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    AgentApplicationTools agentApplicationTools(AgentTaskStore tasks, com.manao.poc4.run.RunService runs,
                                                com.manao.poc4.run.RunStore runStore,
                                                com.manao.poc4.log.RunLogService logs,
                                                ProjectApplicationProbe probe, ProjectLifecycleGate lifecycle) {
        return new AgentApplicationTools(tasks, runs, runStore, logs, probe, lifecycle);
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    AgentProjectTools agentProjectTools(AgentTaskStore tasks, WorkspaceStore store, WorkspaceService workspace,
                                        WorkspaceOperationService operations, ProjectLifecycleGate lifecycle,
                                        DevelopmentBuildExecutor builds, AgentApplicationTools application) {
        return new AgentProjectTools(tasks, store, workspace, operations, lifecycle, builds, application);
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    PiWorkerClient piWorkerClient(AiProperties properties) {
        if (properties.worker().baseUrl().isBlank() || properties.worker().token().isBlank()) {
            throw new IllegalStateException("ai worker base-url and token are required while AI is enabled");
        }
        return new HttpPiWorkerClient(properties.worker().baseUrl(), properties.worker().token(),
            Duration.ofSeconds(15));
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    com.manao.poc4.ai.AgentConversationStore agentConversationStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager transactions, AgentTaskStore tasks) {
        return new com.manao.poc4.ai.AgentConversationStore(jdbc, transactions, Clock.systemUTC(), tasks);
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    com.manao.poc4.ai.AgentConversationService agentConversationService(com.manao.poc4.ai.AgentConversationStore store,
            ProjectLifecycleGate lifecycle, PiWorkerClient worker) {
        return new com.manao.poc4.ai.AgentConversationService(store, lifecycle, worker);
    }

    @Bean
    @Conditional(AiEnabledCondition.class)
    AgentTaskService agentTaskService(AgentTaskStore tasks, ProjectLifecycleGate lifecycle,
                                      PiWorkerClient worker, AgentProjectTools tools, com.manao.poc4.ai.AgentConversationService conversations) {
        return new AgentTaskService(tasks, lifecycle, worker, tools, conversations);
    }

    @Bean(initMethod = "start",destroyMethod = "close")
    @Conditional(AiEnabledCondition.class)
    com.manao.poc4.ai.AgentTaskReconciler agentTaskReconciler(AgentTaskStore tasks,ProjectLifecycleGate lifecycle,
            PiWorkerClient worker,AgentProjectTools tools) {
        return new com.manao.poc4.ai.AgentTaskReconciler(tasks,
            new com.manao.poc4.ai.AgentTaskSettlementService(tasks,lifecycle,worker,tools));
    }

    @Bean(destroyMethod = "close")
    @Conditional(AiEnabledCondition.class)
    com.manao.poc4.ai.AgentLiveOutput agentLiveOutput(AgentTaskStore tasks) {
        return new com.manao.poc4.ai.AgentLiveOutput(tasks);
    }
}
