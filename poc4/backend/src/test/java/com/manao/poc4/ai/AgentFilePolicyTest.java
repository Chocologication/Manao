package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class AgentFilePolicyTest {
    @ParameterizedTest
    @ValueSource(strings = {"node-javascript-console", "node-javascript-web", "node-typescript-console", "node-typescript-web"})
    void nodeToolsCanEditBuildFilesWhileChatAndTasksKeepCredentialsAndOutputsPrivate(String template) {
        var policy = policy(template);
        for (String path : List.of("package.json", "pnpm-lock.yaml", "tsconfig.json", "src/main.ts", "src/app.js", "README.md")) {
            assertThat(policy.canRead(path)).as(path).isTrue();
            assertThat(policy.canWrite(path)).as(path).isTrue();
        }
        for (String path : List.of(".npmrc", "src/.env.local", "src/credentials.json", "src/server.pem",
                "src/node_modules/x.js", "src/dist/x.js", "src/coverage/result.json", "../package.json", "pom.xml", "main.py")) {
            assertThat(policy.canRead(path)).as(path).isFalse();
            assertThat(policy.canWrite(path)).as(path).isFalse();
        }
        for (String path : List.of(".npmrc", "src/.env.local", "src/credentials.json", "src/dist/x.js")) {
            assertThat(AgentProjectTools.toolReadable(path)).as(path).isFalse();
        }
        for (String path : List.of("main.py", "pyproject.toml", "package.json", "src/main.ts", "pom.xml")) {
            assertThat(AgentProjectTools.toolReadable(path)).as(path).isTrue();
        }
    }

    private AgentFilePolicy policy(String template) {
        var projects = mock(ProjectRuntimeStore.class);
        boolean service = template.endsWith("web");
        when(projects.loadSpec("project")).thenReturn(new ProjectRuntimeSpec(template, false, false,
            service ? List.of(new ProjectRuntimeSpec.Port("http", 8000, 30001)) : List.of()));
        return AgentFilePolicy.forEnvironment(new AgentProjectEnvironmentService(projects,
            AgentProjectEnvironmentTest.policy()).forProject("project"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"python-console", "python-fastapi-web"})
    void allowsPythonSourceTestsAndTextResources(String template) {
        var policy = policy(template);
        for (String path : List.of("main.py", "app/main.py", "mypkg/lib.py", "src/pkg/types.pyi", "tests/test_main.py",
                "data/a.json", "data/a.toml", "data/a.yaml", "data/a.yml", "settings.ini", "settings.cfg",
                "requirements.txt", "README.md", "docs/a.rst", "docs/a.adoc", "data/a.csv", "data/a.tsv",
                "templates/index.html", "static/site.css", "static/app.js", "db/query.sql")) {
            assertThat(policy.canRead(path)).as("read %s", path).isTrue();
            assertThat(policy.canWrite(path)).as("write %s", path).isTrue();
        }
        for (String directory : List.of("", "app", "mypkg", "mypkg/subpkg", "tests", "templates", "data")) {
            assertThat(policy.canList(directory)).as(directory).isTrue();
        }
        assertThat(policy.canRead("mypkg")).isFalse();
        assertThat(policy.canWrite("image.png")).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"python-console", "python-fastapi-web"})
    void managedRootFilesAreReadableOnlyAndHiddenExceptionCannotBeTraversed(String template) {
        var policy = policy(template);
        for (String path : List.of("pyproject.toml", "uv.lock", ".python-version")) {
            assertThat(policy.canRead(path)).as(path).isTrue();
            assertThat(policy.canWrite(path)).as(path).isFalse();
        }
        assertThat(policy.canList(".python-version")).isFalse();
        assertThat(policy.canRead("pkg/.python-version")).isFalse();
        assertThat(policy.canRead(".python-version/main.py")).isFalse();
        assertThat(policy.canWrite("pkg/pyproject.toml")).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"python-console", "python-fastapi-web"})
    void deniesHiddenCredentialsCachesPomAndMalformedPaths(String template) {
        var policy = policy(template);
        for (String path : List.of("pom.xml", "app/pom.xml", ".git/config", ".env", "app/.hidden/data.json", ".manao-cache/data.json",
                ".venv/lib/site.py", "venv/lib/site.py", "pkg/__pycache__/a.py", ".pytest_cache/a.py", "node_modules/a.js",
                "target/a.txt", "dist/a.js", "build/a.py", "src/id_rsa", "app/credentials.json", "data/server.pem",
                "data/server.key", "data/store.p12", "data/store.jks", "data/store.keystore", "data/store.kdbx",
                "../main.py", "/main.py", "C:/main.py", "app\\main.py", "app//main.py", "app/%2e%2e/main.py")) {
            assertThat(policy.canRead(path)).as("read %s", path).isFalse();
            assertThat(policy.canWrite(path)).as("write %s", path).isFalse();
            assertThat(policy.canList(path)).as("list %s", path).isFalse();
        }
        assertThat(policy.canRead(null)).isFalse();
        assertThat(policy.canWrite("")).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"java-console", "java-spring-boot-web"})
    void keepsJavaSourcePomAndTopLevelDocumentPolicy(String template) {
        var policy = policy(template);
        for (String path : List.of("pom.xml", "src/main/java/App.java", "src/test/java/AppTest.java", "src/main/resources/application.yml", "README.md")) {
            assertThat(policy.canRead(path)).as(path).isTrue();
            assertThat(policy.canWrite(path)).as(path).isTrue();
        }
        assertThat(policy.canList("src/main/java")).isTrue();
        for (String path : List.of("main.py", "tests/test_main.py", "pyproject.toml", "src/server.pem", "src/target/a.txt")) {
            assertThat(policy.canRead(path)).as(path).isFalse();
            assertThat(policy.canWrite(path)).as(path).isFalse();
        }
    }
}
