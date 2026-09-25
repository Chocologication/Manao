package com.manao.poc4.workspace;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/**
 * Build/test-only entry point that exports the rendered Python template variants to a plain
 * directory so the Python runner image can seed its uv cache from the real templates (python
 * runtime plan, task 4). The exporter only renders {@link WorkspaceTemplate#files(ProjectRuntimeSpec)}
 * through the same public entry the workspace provisioning uses and writes the files; it never
 * touches a database or a cluster and never starts a Spring context. It never runs uv itself:
 * the exported declarations and lock are the inputs the image build feeds to uv.
 *
 * <p>The output location comes exclusively from the explicit {@code manao.seed.output} system
 * property (an absolute build directory). A previous export is removed first so a stale variant
 * from an older run can never survive into the image build; the path check makes sure this tool
 * only ever clears a build directory it owns.</p>
 */
public final class PythonSeedTemplateExporter {

    /** The only directory name this exporter is allowed to clear and rewrite. */
    static final String OWNED_DIRECTORY_NAME = "python-seed-templates";

    private PythonSeedTemplateExporter() {
    }

    public static void main(String[] args) throws IOException {
        var specs = new java.util.LinkedHashMap<String, ProjectRuntimeSpec>();
        specs.put("console", new ProjectRuntimeSpec("python-console", false, false, java.util.List.of()));
        specs.put("web", new ProjectRuntimeSpec("python-fastapi-web", false, false, java.util.List.of()));
        specs.put("web-mysql", new ProjectRuntimeSpec("python-fastapi-web", true, false, java.util.List.of()));
        specs.put("web-redis", new ProjectRuntimeSpec("python-fastapi-web", false, true, java.util.List.of()));
        specs.put("web-mysql-redis", new ProjectRuntimeSpec("python-fastapi-web", true, true, java.util.List.of()));
        String output = System.getProperty("manao.seed.output");
        if (output == null || output.isBlank()) throw new IllegalArgumentException("manao.seed.output is required");
        var root = java.nio.file.Path.of(output).toAbsolutePath().normalize();
        clearOwnedDirectory(root);
        var template = new WorkspaceTemplate();
        for (var variant : specs.entrySet()) {
            for (var file : template.files(variant.getValue()).entrySet()) {
                var destination = root.resolve(variant.getKey()).resolve(file.getKey());
                java.nio.file.Files.createDirectories(destination.getParent());
                java.nio.file.Files.writeString(destination, file.getValue(), java.nio.charset.StandardCharsets.UTF_8);
            }
        }
        System.out.println("exported " + specs.size() + " python template variants to " + root);
    }

    /** Deletes a previous export so old variants cannot linger; only the owned name is accepted, even for a fresh export. */
    private static void clearOwnedDirectory(Path root) throws IOException {
        if (!OWNED_DIRECTORY_NAME.equals(root.getFileName().toString())
            || (Files.exists(root) && !Files.isDirectory(root))) {
            throw new IllegalArgumentException(
                "manao.seed.output must be a '" + OWNED_DIRECTORY_NAME + "' directory: " + root);
        }
        if (!Files.exists(root)) {
            return;
        }
        try (var paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException ex) {
                    throw new UncheckedIOException("cannot clear previous export at " + path, ex);
                }
            });
        }
    }
}
