package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The exporter may only ever clear its own canonical Maven build directory
 * ({@code target/python-seed-templates}). The cleanup guard must refuse any other location —
 * including a same-named directory anywhere else on disk — before touching anything, so a
 * mistyped {@code manao.seed.output} can never delete foreign data.
 */
class PythonSeedTemplateExporterTest {

    @Test
    void refusesToClearASameNamedDirectoryOutsideTheOwnedBuildDirectory(@TempDir Path temp) throws Exception {
        Path foreign = temp.resolve("python-seed-templates");
        Files.createDirectories(foreign);
        Path valuable = foreign.resolve("valuable.txt");
        Files.writeString(valuable, "keep me", StandardCharsets.UTF_8);

        System.setProperty("manao.seed.output", foreign.toString());
        try {
            assertThatThrownBy(() -> PythonSeedTemplateExporter.main(new String[0]))
                .isInstanceOf(IllegalArgumentException.class);
        } finally {
            System.clearProperty("manao.seed.output");
        }
        // Fail-closed: the refused location is never touched.
        assertThat(valuable).exists();
        assertThat(foreign).exists();
    }

    @Test
    void exportsIntoTheOwnedCanonicalBuildDirectory() throws Exception {
        Path owned = PythonSeedTemplateExporter.ownedDirectory();

        System.setProperty("manao.seed.output", owned.toString());
        try {
            PythonSeedTemplateExporter.main(new String[0]);
        } finally {
            System.clearProperty("manao.seed.output");
        }
        // The canonical owned directory is writable and receives the real rendered variants.
        assertThat(owned.resolve("console").resolve("pyproject.toml")).exists();
        assertThat(owned.resolve("web-mysql-redis").resolve("app").resolve("main.py")).exists();
    }
}
