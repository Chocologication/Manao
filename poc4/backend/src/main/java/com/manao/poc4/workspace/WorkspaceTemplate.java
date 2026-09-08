package com.manao.poc4.workspace;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

/** Loads the fixed Java 17/Maven template written into every new project via the workspace API. */
public final class WorkspaceTemplate {
    /** CREATE requires an existing parent; bootstrap an empty workspace in parent-first order. */
    private static final List<String> DIRECTORIES = List.of(
        "src", "src/main", "src/main/java", "src/main/java/com", "src/main/java/com/example",
        "src/main/java/com/example/app", "src/test", "src/test/java", "src/test/java/com",
        "src/test/java/com/example", "src/test/java/com/example/app");

    private static final Map<String, String> FILES = new LinkedHashMap<>();

    static {
        FILES.put("pom.xml", "workspace-template/pom.xml");
        FILES.put("README.md", "workspace-template/README.md");
        FILES.put(".gitignore", "workspace-template/.gitignore");
        FILES.put("src/main/java/com/example/app/App.java", "workspace-template/src/main/java/com/example/app/App.java");
        FILES.put("src/test/java/com/example/app/AppTest.java", "workspace-template/src/test/java/com/example/app/AppTest.java");
    }

    public List<String> directories() {
        return DIRECTORIES;
    }

    /** Template file path -> UTF-8 content, in deterministic order. */
    public Map<String, String> files() {
        Map<String, String> loaded = new LinkedHashMap<>();
        FILES.forEach((path, resource) -> loaded.put(path, read(resource)));
        return loaded;
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
