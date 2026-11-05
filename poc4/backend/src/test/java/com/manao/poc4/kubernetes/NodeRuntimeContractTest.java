package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.manao.poc4.ai.AgentContracts.BuildGoal;
import com.manao.poc4.ai.AgentContracts.BuildRequest;
import com.manao.poc4.ai.AgentProjectTools;
import com.manao.poc4.api.ApiError;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.project.RuntimeTemplate;
import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.workspace.WorkspaceTemplate;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class NodeRuntimeContractTest {
    private static final String PROJECT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4e5f";
    private static final String RUN = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String NODE_IMAGE = "registry.example/node@sha256:" + "c".repeat(64);
    private static final String OTHER_IMAGE = "registry.example/other@sha256:" + "d".repeat(64);
    private static final RunPolicy BASE = new RunPolicy("java-console", new RunPolicy.RuntimeInfo.Java(17, 3),
        "mvn -q -DskipTests compile exec:java", 1800, "TASK", 1800, 0,
        new RunPolicy.Resources(1000, 1L << 30, 1L << 30), new RunPolicy.Resources(4000, 4L << 30, 2L << 30));

    private static List<RuntimeTemplate> templates() {
        return Arrays.stream(RuntimeTemplate.values()).filter(RuntimeTemplate::isNode).toList();
    }

    private static ProjectRuntimeSpec spec(RuntimeTemplate template) {
        return new ProjectRuntimeSpec(template.id(), false, false, List.of());
    }

    private static JobResourceFactory factory(String nodeImage, ProjectRuntimeStore runtimes) {
        var resources = new JobResourceFactory.RunResources(1000, 1L << 30, 1L << 30);
        return new JobResourceFactory("test", 1800, OTHER_IMAGE, resources, resources,
            OTHER_IMAGE, OTHER_IMAGE, nodeImage, runtimes);
    }

    private static RunRecord run(RuntimeTemplate template) {
        return new RunRecord(RUN, PROJECT, 0, RunState.STARTING, BASE.forProject(spec(template)).toJson(),
            null, null, null, null, null, null, 0L, Instant.parse("2026-11-04T00:00:00Z"), 0L);
    }

    @Test void fourTemplatesHaveOwnLanguagePolicyAndPackagedSources() {
        assertThat(templates()).hasSize(4);
        var workspace = new WorkspaceTemplate();
        for (var template : templates()) {
            var spec = spec(template); spec.validate(Set.of(30080));
            var policy = BASE.forProject(spec);
            assertThat(RunPolicy.fromJson(policy.toJson())).isEqualTo(policy);
            assertThat(policy.runtime()).isEqualTo(new RunPolicy.RuntimeInfo.Node(template.language(), 24, "pnpm", 10));
            assertThat(policy.isService()).isEqualTo(template.isService());
            assertThat(spec.primaryPort()).isEqualTo(3000);
            var files = workspace.files(spec);
            String extension = template.language().equals("typescript") ? "ts" : "js";
            assertThat(files).containsKeys("package.json", "pnpm-lock.yaml", ".npmrc", ".gitignore", "README.md", "src/main." + extension);
            assertThat(files).doesNotContainKeys("pom.xml", "main.py");
            assertThat(files.get("package.json")).contains("pnpm@10.33.0", "--test-reporter=junit");
            assertThat(files.get("pnpm-lock.yaml")).contains("lockfileVersion: '9.0'");
            assertThat(workspace.directories(spec)).containsExactly("src");
        }
    }

    @Test void nodeSnapshotRejectsConflictingLanguageVersionsAndCommands() {
        String valid = BASE.forProject(spec(RuntimeTemplate.NODE_TYPESCRIPT_CONSOLE)).toJson();
        for (String changed : List.of(
            valid.replace("\"nodeMajor\":24", "\"nodeMajor\":22"),
            valid.replace("\"pnpmMajor\":10", "\"pnpmMajor\":9"),
            valid.replace("\"nodeMajor\":24", "\"nodeMajor\":24,\"javaMajor\":17"),
            valid.replace("pnpm start", "npm start"),
            valid.replace("\"language\":\"typescript\"", "\"language\":\"javascript\""))) {
            assertThatThrownBy(() -> RunPolicy.fromJson(changed)).isInstanceOf(IllegalStateException.class);
        }
        for (String template : List.of("java-console", "python-console")) {
            String other = BASE.forProject(new ProjectRuntimeSpec(template, false, false, List.of())).toJson();
            String mixed = other.replace("\"runtime\":{", "\"runtime\":{\"nodeMajor\":24,");
            assertThatThrownBy(() -> RunPolicy.fromJson(mixed)).isInstanceOf(IllegalStateException.class);
        }
    }

    @Test void webPortsAndConsoleDependenciesFollowServerValidation() {
        for (var template : templates()) {
            var dependencies = new ProjectRuntimeSpec(template.id(), true, true, List.of());
            if (template.isService()) dependencies.validate(Set.of());
            else assertThatThrownBy(() -> dependencies.validate(Set.of())).isInstanceOf(ApiException.class);
            var port = new ProjectRuntimeSpec(template.id(), false, false,
                List.of(new ProjectRuntimeSpec.Port("web", 3000, 31000)));
            if (template.isService()) port.validate(Set.of());
            else assertThatThrownBy(() -> port.validate(Set.of())).isInstanceOf(ApiException.class);
        }
    }

    @Test void nodeRunsUseOwnImageCacheAndSupervisorProfile() {
        var factory = factory(NODE_IMAGE, null);
        for (var template : templates()) {
            var job = factory.createJob(run(template), PROJECT, 3000, List.of());
            var pod = job.getSpec().getTemplate().getSpec();
            var container = pod.getContainers().get(0);
            assertThat(container.getImage()).isEqualTo(NODE_IMAGE);
            assertThat(container.getCommand()).containsExactlyElementsOf(template.isService()
                ? List.of("/usr/local/bin/manao-run-supervisor", "run", template.id())
                : List.of("/usr/local/bin/manao-node", "console"));
            assertThat(container.getVolumeMounts()).anySatisfy(mount -> {
                assertThat(mount.getMountPath()).isEqualTo("/node-cache");
                assertThat(mount.getSubPath()).isEqualTo(".manao-cache/node");
            });
            assertThat(pod.getVolumes().stream().filter(v -> v.getPersistentVolumeClaim() != null)).hasSize(1);
            if (template.isService()) assertThat(container.getReadinessProbe().getExec().getCommand())
                .containsExactly("/usr/local/bin/manao-run-supervisor", "probe", template.id());
        }
    }

    @Test void missingNodeImageProducesRecognizableSafeError() {
        assertThatThrownBy(() -> factory(null, null).createJob(run(RuntimeTemplate.NODE_JAVASCRIPT_CONSOLE), PROJECT, 3000, List.of()))
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo("NODE_RUNTIME_NOT_CONFIGURED"));
        assertThat(new ApiError("NODE_RUNTIME_NOT_CONFIGURED", "private registry details", "trace").message())
            .isEqualTo("Node.js runtime is not configured");
    }

    @Test void developmentBuildUsesPersistedNodeTemplateAndReadOnlySource() {
        for (var template : templates()) {
            var runtimes = mock(ProjectRuntimeStore.class); when(runtimes.loadSpec(PROJECT)).thenReturn(spec(template));
            var request = new BuildRequest("task", "call", PROJECT, RUN, 1, BuildGoal.TEST,
                new com.manao.poc4.ai.AgentProjectEnvironmentService(runtimes, BASE).forProject(PROJECT),
                Map.of("package.json", "{}", "src/app.ts", "export {};"));
            var job = factory(NODE_IMAGE, runtimes).createDevelopmentJob(request,
                new JobResourceFactory.DevelopmentSourceVolume("nfs.example", "/export/workspaces"));
            var pod = job.getSpec().getTemplate().getSpec();
            assertThat(pod.getContainers().get(0).getImage()).isEqualTo(NODE_IMAGE);
            assertThat(pod.getContainers().get(0).getCommand()).containsExactly("/usr/local/bin/manao-dev-build", "run", "test");
            assertThat(pod.getContainers().get(0).getVolumeMounts()).noneMatch(m -> m.getName().equals("source"));
            assertThat(pod.getVolumes()).anySatisfy(v -> {
                assertThat(v.getName()).isEqualTo("source"); assertThat(v.getNfs().getReadOnly()).isTrue();
            });
            assertThat(pod.getInitContainers()).filteredOn(c -> List.of("source-copy", "review-overlay").contains(c.getName()))
                .allSatisfy(c -> assertThat(c.getImage()).isEqualTo(NODE_IMAGE));
        }
    }

    @Test void agentCanEditNodeBuildFilesButCannotTraverseGeneratedOutputs() {
        for (String path : List.of("package.json", "pnpm-lock.yaml", "tsconfig.json", "src/main.ts"))
            assertThat(AgentProjectTools.toolReadable(path)).as(path).isTrue();
        for (String path : List.of("node_modules/lib/index.js", "src/node_modules/x.js", "src/dist/x.js", "src/coverage/report.json"))
            assertThat(AgentProjectTools.toolReadable(path)).as(path).isFalse();
    }
}
