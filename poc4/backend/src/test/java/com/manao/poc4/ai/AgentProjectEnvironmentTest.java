package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.run.RunPolicy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class AgentProjectEnvironmentTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @CsvSource({
        "java-console,java,none,task,com.example.app.App,java-v1",
        "java-spring-boot-web,java,spring-boot,service,com.example.app.App,java-v1",
        "python-console,python,none,task,main.py,python-v1",
        "python-fastapi-web,python,fastapi,service,app.main:app,python-v1"
    })
    void derivesCapabilitiesFromTheTrustedTemplate(String template, String language, String framework,
            String kind, String entrypoint, String filePolicy) {
        boolean service = "service".equals(kind);
        var spec = new ProjectRuntimeSpec(template, service, service,
            service ? List.of(new ProjectRuntimeSpec.Port("http", 8123, 30234)) : List.of());
        var runtime = org.mockito.Mockito.mock(ProjectRuntimeStore.class);
        org.mockito.Mockito.when(runtime.loadSpec("project-a")).thenReturn(spec);

        var environment = new AgentProjectEnvironmentService(runtime, policy()).forProject("project-a");

        assertThat(environment.schemaVersion()).isEqualTo(1);
        assertThat(environment.templateId()).isEqualTo(template);
        assertThat(environment.language()).isEqualTo(language);
        assertThat(environment.framework()).isEqualTo(framework);
        assertThat(environment.executionKind()).isEqualTo(kind);
        assertThat(environment.entrypoint()).isEqualTo(entrypoint);
        assertThat(environment.filePolicy()).isEqualTo(filePolicy);
        assertThat(environment.primaryPort()).isEqualTo(service ? 8123 : null);
        assertThat(environment.readinessPath()).isEqualTo(!service ? null
            : "python".equals(language) ? "/health/ready" : "/actuator/health");
        assertThat(environment.pythonVersion()).isEqualTo("python".equals(language) ? "3.13" : null);
        assertThat(environment.mysql()).isEqualTo(service);
        assertThat(environment.redis()).isEqualTo(service);
        assertThat(environment.buildGoals()).isEqualTo("python".equals(language)
            ? List.of("compile", "test") : List.of("compile", "test", "package"));
        assertThat(environment.dependencyGroups()).isEqualTo("python".equals(language)
            ? List.of("main", "test") : List.of());
        var expectedTools = new java.util.ArrayList<>(List.of("list_files", "read_file", "write_file", "build", "application"));
        if (service) expectedTools.add("app_http_get");
        expectedTools.add("read_image");
        if ("python".equals(language)) expectedTools.add("python_dependencies");
        assertThat(environment.tools()).isEqualTo(expectedTools);
        assertThat(environment.canonicalJson()).doesNotContain("password", "Secret", "kubeconfig", "jdbc:", "/workspace");
    }

    @Test void sharesCanonicalJsonAndHashWithTheWorkerGoldenFixture() throws Exception {
        var runtime = org.mockito.Mockito.mock(ProjectRuntimeStore.class);
        org.mockito.Mockito.when(runtime.loadSpec("project-a")).thenReturn(new ProjectRuntimeSpec(
            "python-fastapi-web", false, false, List.of()));
        var environment = new AgentProjectEnvironmentService(runtime, policy()).forProject("project-a");
        var fixture = Files.readString(Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")).strip();
        assertThat(environment.canonicalJson()).isEqualTo(fixture);
        assertThat(environment.sha256()).isEqualTo("b01fa3652c6ce9af1b816a24b783f6c6e12fbfe0716c1de6b05be43772899ea0");
        assertThat(AgentProjectEnvironment.fromJson(fixture)).isEqualTo(environment);
        assertThat(JSON.writeValueAsString(environment)).isEqualTo(fixture);
    }

    @Test void rejectsMissingUnknownAndConflictingEnvironmentFacts() throws Exception {
        var runtime = org.mockito.Mockito.mock(ProjectRuntimeStore.class);
        var service = new AgentProjectEnvironmentService(runtime, policy());
        assertThatThrownBy(() -> service.forProject("project-a")).isInstanceOf(ApiException.class);
        org.mockito.Mockito.when(runtime.loadSpec("project-a")).thenReturn(
            new ProjectRuntimeSpec("unknown", false, false, List.of()));
        assertThatThrownBy(() -> service.forProject("project-a")).isInstanceOf(ApiException.class);
        var golden = Files.readString(Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")).strip();
        for (String invalid : List.of(golden.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
                golden.replace("\"language\":\"python\"", "\"language\":\"java\""),
                golden.replace("[\"compile\",\"test\"]", "[\"compile\",\"test\",\"package\"]"),
                golden.replace("\"primaryPort\":8000", "\"primaryPort\":null"),
                golden.replace("\"redis\":false", "\"redis\":false,\"password\":\"secret\""))) {
            assertThatThrownBy(() -> AgentProjectEnvironment.fromJson(invalid)).isInstanceOf(ApiException.class);
        }
    }

    @Test void v19UpgradeKeepsHistoricalNullAndOriginalExecutionIdentity() {
        try (var db = JdbcStoreTestSupport.createAtVersion("19")) {
            var jdbc = db.jdbc();
            var now = Timestamp.from(Clock.systemUTC().instant());
            String taskId = UUID.randomUUID().toString();
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES ('owner-a','owner-a','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project-a','owner-a','project-a','READY',7,?,?)", now, now);
            jdbc.update("INSERT INTO agent_task(id,project_id,owner_id,request_sha256,prompt,state,worker_epoch,workspace_revision,created_at,updated_at) VALUES (?,'project-a','owner-a',?,'legacy goal','RUNNING',1,7,?,?)", taskId, "a".repeat(64), now, now);

            db.migrateToLatest();

            var tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            assertThat(tasks.environmentOf(taskId)).isNull();
            assertThat(tasks.requestSha256Of(taskId)).isEqualTo("a".repeat(64));
            assertThat(jdbc.queryForObject("SELECT environment_sha256 FROM agent_task WHERE id=?", String.class, taskId)).isNull();
            assertThat(jdbc.queryForObject("SELECT state FROM agent_task WHERE id=?", String.class, taskId)).isEqualTo("RUNNING");
            assertThat(AgentTaskStore.terminalReportId(taskId, 1, tasks.requestSha256Of(taskId)))
                .isEqualTo(AgentTaskStore.terminalReportId(taskId, 1, "a".repeat(64)));
        }
    }

    static RunPolicy policy() {
        return new RunPolicy("java-console", new RunPolicy.RuntimeInfo.Java(17, 3),
            "mvn -q -DskipTests compile exec:java", 1800, "TASK", 1800, 0,
            new RunPolicy.Resources(1000, 1024, 1024), new RunPolicy.Resources(2000, 2048, 2048));
    }
}
