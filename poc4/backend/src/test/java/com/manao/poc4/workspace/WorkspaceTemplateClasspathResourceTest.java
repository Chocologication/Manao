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
}
