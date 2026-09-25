package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class WorkspaceTemplateTest {
    @Test
    void createsEveryParentBeforeItsChildrenOnAnEmptyWorkspace() {
        var created = new HashSet<String>();
        created.add("");
        WorkspaceTemplate template = new WorkspaceTemplate();
        for (String directory : template.directories()) {
            Path parent = Path.of(directory).getParent();
            assertThat(created).as("parent exists before CREATE %s", directory)
                .contains(parent == null ? "" : parent.toString().replace('\\', '/'));
            assertThat(created.add(directory)).as("directory is created once: %s", directory).isTrue();
        }
        for (String file : template.files().keySet()) {
            Path parent = Path.of(file).getParent();
            assertThat(created).contains(parent == null ? "" : parent.toString().replace('\\', '/'));
        }
    }

    private static ProjectRuntimeSpec spec(String templateId, boolean mysql, boolean redis) {
        return new ProjectRuntimeSpec(templateId, mysql, redis, java.util.List.of());
    }

    @Test
    void templateWriteOrderIsDeterministicAndMatchesTheManifest() {
        // The manifest iteration order decides the workspace write order; it must not inherit
        // an unspecified Map.of() order, so the exact sequence is locked here.
        WorkspaceTemplate template = new WorkspaceTemplate();
        assertThat(template.files().keySet()).containsExactly(
            "pom.xml", "README.md", ".gitignore",
            "src/main/java/com/example/app/App.java",
            "src/test/java/com/example/app/AppTest.java");
        assertThat(template.files(spec(
                ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true)).keySet())
            .containsExactly(
                "pom.xml", "README.md", ".gitignore",
                "src/main/java/com/example/app/App.java",
                "src/main/java/com/example/app/DemoController.java",
                "src/main/resources/application.yml");
    }

    @Test
    void webTemplateDirectoriesAreParentFirstForEverySelection() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        for (boolean mysql : new boolean[] {false, true}) {
            for (boolean redis : new boolean[] {false, true}) {
                var created = new HashSet<String>();
                created.add("");
                for (String directory : template.directories(spec(
                        ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, mysql, redis))) {
                    Path parent = Path.of(directory).getParent();
                    assertThat(created).as("parent exists before CREATE %s", directory)
                        .contains(parent == null ? "" : parent.toString().replace('\\', '/'));
                    assertThat(created.add(directory)).isTrue();
                }
                Map<String, String> files = template.files(spec(
                    ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, mysql, redis));
                for (String file : files.keySet()) {
                    Path parent = Path.of(file).getParent();
                    assertThat(created).as("directory exists for file %s", file)
                        .contains(parent == null ? "" : parent.toString().replace('\\', '/'));
                }
            }
        }
    }

    @Test
    void webTemplateIncludesExactlyTheSelectedDependencyStarters() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        for (boolean mysql : new boolean[] {false, true}) {
            for (boolean redis : new boolean[] {false, true}) {
                Map<String, String> files = template.files(spec(
                    ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, mysql, redis));
                String pom = files.get("pom.xml");
                assertThat(pom).as("web pom for mysql=%s redis=%s", mysql, redis)
                    .contains("<artifactId>spring-boot-starter-web</artifactId>")
                    .contains("<artifactId>spring-boot-starter-actuator</artifactId>")
                    .contains("3.5.9");
                if (mysql) {
                    assertThat(pom).contains("spring-boot-starter-jdbc").contains("mysql-connector-j");
                } else {
                    assertThat(pom).doesNotContain("spring-boot-starter-jdbc", "mysql-connector-j");
                }
                if (redis) {
                    assertThat(pom).contains("spring-boot-starter-data-redis");
                } else {
                    assertThat(pom).doesNotContain("spring-boot-starter-data-redis");
                }
                String yaml = files.get("src/main/resources/application.yml");
                // Environment mapping follows the selection; unselected variables never appear.
                if (mysql) {
                    assertThat(yaml).contains("MANAO_MYSQL_HOST")
                        .contains("MANAO_MYSQL_USERNAME").contains("MANAO_MYSQL_PASSWORD");
                } else {
                    assertThat(yaml).doesNotContain("MANAO_MYSQL");
                }
                if (redis) {
                    assertThat(yaml).contains("MANAO_REDIS_HOST").contains("MANAO_REDIS_PASSWORD");
                } else {
                    assertThat(yaml).doesNotContain("MANAO_REDIS");
                }
                // The readiness group names only indicators that exist for this selection.
                String include = "include: readinessState" + (mysql ? ",db" : "") + (redis ? ",redis" : "");
                if (mysql || redis) {
                    assertThat(yaml).contains(include);
                    assertThat(yaml).doesNotContain("include: readinessState\n");
                } else {
                    assertThat(yaml).doesNotContain("group:");
                }
                // Health surface stays minimal regardless of the selection.
                assertThat(yaml).contains("show-details: never").contains("include: health");
            }
        }
    }

    @Test
    void webTemplateCreatesTablesSafelyAndNeverDropsThem() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        Map<String, String> files = template.files(spec(
            ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true));
        assertThat(files.get("README.md")).contains("CREATE TABLE IF NOT EXISTS");
        files.values().forEach(content -> assertThat(content).doesNotContain("DROP TABLE"));
    }

    @Test
    void consoleTemplateStaysPlainJavaAndAddsOnlySelectedClients() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        for (boolean mysql : new boolean[] {false, true}) {
            for (boolean redis : new boolean[] {false, true}) {
                Map<String, String> files = template.files(spec(
                    ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE, mysql, redis));
                // The console template never becomes a Spring application.
                assertThat(files).doesNotContainKey("src/main/resources/application.yml")
                    .doesNotContainKey("src/main/java/com/example/app/DemoController.java");
                String pom = files.get("pom.xml");
                assertThat(pom).doesNotContain("spring-boot");
                if (mysql) {
                    assertThat(pom).contains("mysql-connector-j");
                } else {
                    assertThat(pom).doesNotContain("mysql-connector-j");
                }
                if (redis) {
                    assertThat(pom).contains("jedis");
                } else {
                    assertThat(pom).doesNotContain("jedis");
                }
            }
        }
    }

    @Test
    void pythonTemplateIsNotRenderedAsJava() {
        var spec = new ProjectRuntimeSpec("python-console", false, false, List.of());
        var files = new WorkspaceTemplate().files(spec);
        assertThat(files).containsKeys("main.py", "pyproject.toml", "uv.lock")
            .doesNotContainKeys("pom.xml");
        assertThat(files.get("main.py")).contains("Hello from Manao");
    }

    @Test
    void pythonConsoleTemplateShipsTheUvManagedProjectFiles() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        Map<String, String> files = template.files(spec("python-console", false, false));
        assertThat(files.keySet()).containsExactly(
            "pyproject.toml", "uv.lock", ".python-version", ".gitignore", "README.md", "main.py");
        // The console template stays dependency-free with its own real lock. The declaration
        // keeps the brief's requires-python; uv's lock records its canonical form ==3.13.*.
        assertThat(files.get("pyproject.toml"))
            .contains("requires-python = \">=3.13,<3.14\"")
            .contains("dependencies = []");
        assertThat(files.get("uv.lock")).contains("requires-python = \"==3.13.*\"");
        assertThat(files.get(".python-version")).contains("3.13");
        // Console projects reject dependencies, so the rendered files never depend on the flags.
        assertThat(template.files(spec("python-console", true, true)))
            .containsExactlyInAnyOrderEntriesOf(files);
    }

    @Test
    void pythonWebTemplateShipsFastapiUvicornAndTheNamedExtras() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        Map<String, String> files = template.files(spec("python-fastapi-web", true, true));
        assertThat(files.keySet()).containsExactly(
            "pyproject.toml", "uv.lock", ".python-version", ".gitignore", "README.md",
            "app/__init__.py", "app/main.py");
        assertThat(files.get("pyproject.toml"))
            .contains("requires-python = \">=3.13,<3.14\"")
            .contains("\"fastapi")
            .contains("\"uvicorn")
            .contains("[project.optional-dependencies]")
            // uv writes the PEP 503 normalized form of PyMySQL[rsa].
            .contains("pymysql[rsa]")
            .contains("\"redis");
        // Web reuses the console template's interpreter pin and ignore rules.
        assertThat(files.get(".python-version"))
            .isEqualTo(template.files(spec("python-console", false, false)).get(".python-version"));
        assertThat(files.get(".gitignore"))
            .isEqualTo(template.files(spec("python-console", false, false)).get(".gitignore"));
        assertThat(files.get("app/main.py")).contains("/api/demo").contains("/health/ready");
    }

    @Test
    void pythonWebReadinessAndOneLockFollowEveryDependencySelection() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        String sharedLock = template.files(spec("python-fastapi-web", false, false)).get("uv.lock");
        assertThat(sharedLock).isNotBlank();
        for (boolean mysql : new boolean[] {false, true}) {
            for (boolean redis : new boolean[] {false, true}) {
                Map<String, String> files = template.files(spec("python-fastapi-web", mysql, redis));
                // One real lock carries both named extras; the selection only picks install extras.
                assertThat(files.get("uv.lock")).as("lock for mysql=%s redis=%s", mysql, redis)
                    .isEqualTo(sharedLock);
                String main = files.get("app/main.py");
                if (mysql) {
                    assertThat(main).contains("MANAO_MYSQL_HOST");
                } else {
                    assertThat(main).doesNotContain("MANAO_MYSQL");
                }
                if (redis) {
                    assertThat(main).contains("MANAO_REDIS_HOST");
                } else {
                    assertThat(main).doesNotContain("MANAO_REDIS");
                }
            }
        }
    }

    @Test
    void pythonTemplateDirectoriesAreParentFirstForEverySelection() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        for (String templateId : List.of("python-console", "python-fastapi-web")) {
            for (boolean mysql : new boolean[] {false, true}) {
                for (boolean redis : new boolean[] {false, true}) {
                    var created = new HashSet<String>();
                    created.add("");
                    for (String directory : template.directories(spec(templateId, mysql, redis))) {
                        Path parent = Path.of(directory).getParent();
                        assertThat(created).as("parent exists before CREATE %s", directory)
                            .contains(parent == null ? "" : parent.toString().replace('\\', '/'));
                        assertThat(created.add(directory)).isTrue();
                    }
                    Map<String, String> files = template.files(spec(templateId, mysql, redis));
                    for (String file : files.keySet()) {
                        Path parent = Path.of(file).getParent();
                        assertThat(created).as("directory exists for file %s", file)
                            .contains(parent == null ? "" : parent.toString().replace('\\', '/'));
                    }
                }
            }
        }
    }

    @Test
    void javaTemplatesStayExactlyAsBeforeThePythonDispatch() {
        WorkspaceTemplate template = new WorkspaceTemplate();
        assertThat(template.files().keySet())
            .doesNotContain("main.py", "pyproject.toml", "uv.lock", ".python-version");
        assertThat(template.directories()).doesNotContain("app");
        assertThat(template.files(spec(
                ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true)).keySet())
            .doesNotContain("main.py", "pyproject.toml", "uv.lock", ".python-version");
    }
}
