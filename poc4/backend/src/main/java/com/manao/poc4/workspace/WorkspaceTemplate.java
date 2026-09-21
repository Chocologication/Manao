package com.manao.poc4.workspace;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

/**
 * Loads the fixed Java 17/Maven templates written into every new project via the workspace API.
 * The console template stays a plain Java program; the web template is a Spring Boot
 * application whose JDBC/Redis starters, environment mapping and readiness indicators follow
 * the selected runtime dependencies. Template generation never overwrites an existing project:
 * files are only written during first provisioning of an empty workspace.
 */
public final class WorkspaceTemplate {
    /** CREATE requires an existing parent; bootstrap an empty workspace in parent-first order. */
    private static final List<String> CONSOLE_DIRECTORIES = List.of(
        "src", "src/main", "src/main/java", "src/main/java/com", "src/main/java/com/example",
        "src/main/java/com/example/app", "src/test", "src/test/java", "src/test/java/com",
        "src/test/java/com/example", "src/test/java/com/example/app");

    private static final List<String> WEB_DIRECTORIES = List.of(
        "src", "src/main", "src/main/java", "src/main/java/com", "src/main/java/com/example",
        "src/main/java/com/example/app", "src/main/resources");

    private static final Map<String, String> CONSOLE_FILES = manifest(Map.of(
        "pom.xml", "workspace-template/pom.xml",
        "README.md", "workspace-template/README.md",
        ".gitignore", "workspace-template/.gitignore",
        "src/main/java/com/example/app/App.java", "workspace-template/src/main/java/com/example/app/App.java",
        "src/test/java/com/example/app/AppTest.java", "workspace-template/src/test/java/com/example/app/AppTest.java"));

    private static final Map<String, String> WEB_FILES = manifest(Map.of(
        "pom.xml", "workspace-template-web/pom.xml",
        "README.md", "workspace-template-web/README.md",
        ".gitignore", "workspace-template/.gitignore",
        "src/main/java/com/example/app/App.java", "workspace-template-web/src/main/java/com/example/app/App.java",
        "src/main/java/com/example/app/DemoController.java",
            "workspace-template-web/src/main/java/com/example/app/DemoController.java",
        "src/main/resources/application.yml", "workspace-template-web/src/main/resources/application.yml"));

    /** Conditional blocks: {@code <!-- MANAO:IF mysql -->} / {@code # MANAO:END redis -->} in XML, YAML and Markdown. */
    private static final Pattern MARKER = Pattern.compile("^\\s*(?:<!--|#)\\s*MANAO:(IF|END)\\s+([a-z]+)\\s*(?:-->)?\\s*$");

    /** LinkedHashMap: the manifest order decides the workspace write order and must stay deterministic. */
    private static Map<String, String> manifest(Map<String, String> entries) {
        return new LinkedHashMap<>(entries);
    }

    /** The legacy console template, unchanged for name-only project creation. */
    public List<String> directories() {
        return directories(ProjectRuntimeSpec.console());
    }

    public Map<String, String> files() {
        return files(ProjectRuntimeSpec.console());
    }

    public List<String> directories(ProjectRuntimeSpec spec) {
        return spec.isService() ? WEB_DIRECTORIES : CONSOLE_DIRECTORIES;
    }

    /** Template file path -> UTF-8 content for the selected template and dependencies, in deterministic order. */
    public Map<String, String> files(ProjectRuntimeSpec spec) {
        Map<String, String> manifest = spec.isService() ? WEB_FILES : CONSOLE_FILES;
        Map<String, String> loaded = new LinkedHashMap<>();
        manifest.forEach((path, resource) -> {
            String content = read(resource);
            content = filterConditionals(content, spec, resource);
            if (path.equals("src/main/resources/application.yml")) {
                content = content + readinessDocument(spec);
            }
            loaded.put(path, content);
        });
        return loaded;
    }

    /** Removes every conditional block whose flag is not selected; marker lines never survive. */
    private static String filterConditionals(String content, ProjectRuntimeSpec spec, String resource) {
        String[] lines = content.split("\\R", -1);
        Deque<Boolean> active = new ArrayDeque<>();
        StringBuilder result = new StringBuilder();
        for (String line : lines) {
            Matcher marker = MARKER.matcher(line);
            if (marker.matches()) {
                if ("IF".equals(marker.group(1))) {
                    active.push(flagValue(marker.group(2), spec, resource));
                } else {
                    if (active.isEmpty()) {
                        throw new IllegalStateException("unbalanced MANAO:END " + marker.group(2)
                            + " in template resource " + resource);
                    }
                    active.pop();
                }
                continue;
            }
            boolean suppressed = active.stream().anyMatch(section -> !section);
            if (!suppressed) {
                result.append(line).append('\n');
            }
        }
        if (!active.isEmpty()) {
            throw new IllegalStateException("unclosed MANAO:IF block in template resource " + resource);
        }
        return result.toString();
    }

    private static boolean flagValue(String flag, ProjectRuntimeSpec spec, String resource) {
        return switch (flag) {
            case "mysql" -> spec.mysql();
            case "redis" -> spec.redis();
            default -> throw new IllegalStateException("unknown template flag '" + flag
                + "' in template resource " + resource);
        };
    }

    /**
     * Appended as a second YAML document so Spring merges it with the base file: the readiness
     * group exists only when a dependency is selected and names only existing indicators.
     */
    private static String readinessDocument(ProjectRuntimeSpec spec) {
        if (!spec.mysql() && !spec.redis()) {
            return "";
        }
        String include = "readinessState" + (spec.mysql() ? ",db" : "") + (spec.redis() ? ",redis" : "");
        return "\n---\nmanagement:\n  endpoint:\n    health:\n      group:\n        readiness:\n          include: "
            + include + "\n";
    }

    private static String read(String resource) {
        try {
            byte[] bytes = FileCopyUtils.copyToByteArray(new ClassPathResource(resource).getInputStream());
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new UncheckedIOException("cannot load workspace template resource " + resource, ex);
        }
    }
}
