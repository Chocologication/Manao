package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Regression for the stage 6B packaging defect (acceptance §4.0): the accepted
 * backend image shipped a jar whose default Maven excludes silently dropped the
 * {@code workspace-template/.gitignore} classpath resource, so every project
 * provisioning failed with {@code FileNotFoundException} while the same source
 * tree passed tests. This test walks the full {@link WorkspaceTemplate} manifest
 * through the production loading mechanism ({@code files()} -> ClassPathResource)
 * and asserts every entry exists on the runtime classpath and is non-empty.
 */
class WorkspaceTemplateClasspathResourceTest {

    @Test
    void loadsEveryManifestTemplateResourceFromTheClasspathNonEmpty() {
        Map<String, String> files = new WorkspaceTemplate().files();
        assertThat(files).as("workspace template manifest must not be empty").isNotEmpty();
        // The exact manifest entries provisioned into every new project; .gitignore
        // is the entry the packaging defect dropped from the accepted image.
        assertThat(files).containsKeys("pom.xml", "README.md", ".gitignore",
            "src/main/java/com/example/app/App.java",
            "src/test/java/com/example/app/AppTest.java");
        files.forEach((path, content) ->
            assertThat(content).as("template resource %s must load non-empty via classpath", path)
                .isNotBlank());
    }

    @Test
    void loadsEveryWebTemplateResourceFromTheClasspathNonEmpty() {
        var spec = new com.manao.poc4.project.ProjectRuntimeSpec(
            com.manao.poc4.project.ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true,
            java.util.List.of());
        Map<String, String> files = new WorkspaceTemplate().files(spec);
        assertThat(files).as("web template manifest must not be empty").isNotEmpty();
        assertThat(files).containsKeys("pom.xml", "README.md", ".gitignore",
            "src/main/java/com/example/app/App.java",
            "src/main/java/com/example/app/DemoController.java",
            "src/main/resources/application.yml");
        files.forEach((path, content) ->
            assertThat(content).as("web template resource %s must load non-empty via classpath", path)
                .isNotBlank());
    }

    @Test
    void loadsEveryPythonConsoleTemplateResourceFromTheClasspathNonEmpty() {
        var spec = new com.manao.poc4.project.ProjectRuntimeSpec(
            "python-console", false, false, java.util.List.of());
        Map<String, String> files = new WorkspaceTemplate().files(spec);
        assertThat(files).as("python console template manifest must not be empty").isNotEmpty();
        assertThat(files).containsKeys("pyproject.toml", "uv.lock", ".python-version",
            ".gitignore", "README.md", "main.py");
        files.forEach((path, content) ->
            assertThat(content)
                .as("python console resource %s must load non-empty via classpath", path)
                .isNotBlank());
        // UTF-8 text resources decode cleanly and never carry a byte order mark.
        assertThat(files.get("main.py")).doesNotStartWith("\uFEFF");
        assertThat(files.get("uv.lock")).contains("requires-python = \"==3.13.*\"");
    }

    @Test
    void loadsEveryPythonWebTemplateResourceFromTheClasspathNonEmpty() {
        var spec = new com.manao.poc4.project.ProjectRuntimeSpec(
            "python-fastapi-web", true, true, java.util.List.of());
        Map<String, String> files = new WorkspaceTemplate().files(spec);
        assertThat(files).as("python web template manifest must not be empty").isNotEmpty();
        assertThat(files).containsKeys("pyproject.toml", "uv.lock", ".python-version",
            ".gitignore", "README.md", "app/__init__.py", "app/main.py");
        files.forEach((path, content) ->
            assertThat(content)
                .as("python web resource %s must load non-empty via classpath", path)
                .isNotBlank());
        assertThat(files.get("app/main.py")).doesNotStartWith("\uFEFF");
        assertThat(files.get("pyproject.toml")).contains("pymysql[rsa]").contains("\"redis");
    }
}
