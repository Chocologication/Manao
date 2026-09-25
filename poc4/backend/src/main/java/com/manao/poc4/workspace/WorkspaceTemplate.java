package com.manao.poc4.workspace;

import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.RuntimeTemplate;
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
 * Loads the fixed workspace templates written into every new project via the workspace API.
 * Java projects get the Java 17/Maven templates (plain console program or Spring Boot
 * application whose JDBC/Redis starters, environment mapping and readiness indicators follow
 * the selected runtime dependencies); Python projects get uv-managed templates whose
 * mysql/redis clients are named extras in one real lock. Template generation never overwrites
 * an existing project: files are only written during first provisioning of an empty workspace.
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

    private static final List<String> PYTHON_CONSOLE_DIRECTORIES = List.of();

    private static final List<String> PYTHON_WEB_DIRECTORIES = List.of("app");

    /**
     * Built with explicit put() calls: the manifest iteration order decides the workspace write
     * order and must stay deterministic. A Map.of() source would leak its unspecified iteration
     * order through any wrapping map, so the pairs are never routed through one.
     */
    private static final Map<String, String> CONSOLE_FILES = new LinkedHashMap<>();
    private static final Map<String, String> WEB_FILES = new LinkedHashMap<>();
    private static final Map<String, String> PYTHON_CONSOLE_FILES = new LinkedHashMap<>();
    private static final Map<String, String> PYTHON_WEB_FILES = new LinkedHashMap<>();
    static {
        CONSOLE_FILES.put("pom.xml", "workspace-template/pom.xml");
        CONSOLE_FILES.put("README.md", "workspace-template/README.md");
        CONSOLE_FILES.put(".gitignore", "workspace-template/.gitignore");
        CONSOLE_FILES.put("src/main/java/com/example/app/App.java", "workspace-template/src/main/java/com/example/app/App.java");
        CONSOLE_FILES.put("src/test/java/com/example/app/AppTest.java", "workspace-template/src/test/java/com/example/app/AppTest.java");
        WEB_FILES.put("pom.xml", "workspace-template-web/pom.xml");
        WEB_FILES.put("README.md", "workspace-template-web/README.md");
        WEB_FILES.put(".gitignore", "workspace-template/.gitignore");
        WEB_FILES.put("src/main/java/com/example/app/App.java", "workspace-template-web/src/main/java/com/example/app/App.java");
        WEB_FILES.put("src/main/java/com/example/app/DemoController.java", "workspace-template-web/src/main/java/com/example/app/DemoController.java");
        WEB_FILES.put("src/main/resources/application.yml", "workspace-template-web/src/main/resources/application.yml");
        PYTHON_CONSOLE_FILES.put("pyproject.toml", "workspace-template-python/pyproject.toml");
        PYTHON_CONSOLE_FILES.put("uv.lock", "workspace-template-python/uv.lock");
        PYTHON_CONSOLE_FILES.put(".python-version", "workspace-template-python/.python-version");
        PYTHON_CONSOLE_FILES.put(".gitignore", "workspace-template-python/.gitignore");
        PYTHON_CONSOLE_FILES.put("README.md", "workspace-template-python/README.md");
        PYTHON_CONSOLE_FILES.put("main.py", "workspace-template-python/main.py");
        PYTHON_WEB_FILES.put("pyproject.toml", "workspace-template-python-web/pyproject.toml");
        PYTHON_WEB_FILES.put("uv.lock", "workspace-template-python-web/uv.lock");
        PYTHON_WEB_FILES.put(".python-version", "workspace-template-python/.python-version");
        PYTHON_WEB_FILES.put(".gitignore", "workspace-template-python/.gitignore");
        PYTHON_WEB_FILES.put("README.md", "workspace-template-python-web/README.md");
        PYTHON_WEB_FILES.put("app/__init__.py", "workspace-template-python-web/app/__init__.py");
        PYTHON_WEB_FILES.put("app/main.py", "workspace-template-python-web/app/main.py");
    }

    /** Conditional blocks: {@code <!-- MANAO:IF mysql -->} / {@code # MANAO:END redis -->} in XML, YAML, Markdown and Python. */
    private static final Pattern MARKER = Pattern.compile("^\\s*(?:<!--|#)\\s*MANAO:(IF|END)\\s+([a-z]+)\\s*(?:-->)?\\s*$");

    /** The legacy console template, unchanged for name-only project creation. */
    public List<String> directories() {
        return directories(ProjectRuntimeSpec.console());
    }

    public Map<String, String> files() {
        return files(ProjectRuntimeSpec.console());
    }

    public List<String> directories(ProjectRuntimeSpec spec) {
        return switch (RuntimeTemplate.fromId(spec.templateId())) {
            case JAVA_CONSOLE -> CONSOLE_DIRECTORIES;
            case JAVA_SPRING_BOOT_WEB -> WEB_DIRECTORIES;
            case PYTHON_CONSOLE -> PYTHON_CONSOLE_DIRECTORIES;
            case PYTHON_FASTAPI_WEB -> PYTHON_WEB_DIRECTORIES;
        };
    }

    /** Template file path -> UTF-8 content for the selected template and dependencies, in deterministic order. */
    public Map<String, String> files(ProjectRuntimeSpec spec) {
        Map<String, String> manifest = switch (RuntimeTemplate.fromId(spec.templateId())) {
            case JAVA_CONSOLE -> CONSOLE_FILES;
            case JAVA_SPRING_BOOT_WEB -> WEB_FILES;
            case PYTHON_CONSOLE -> PYTHON_CONSOLE_FILES;
            case PYTHON_FASTAPI_WEB -> PYTHON_WEB_FILES;
        };
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
