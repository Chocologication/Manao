package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class NodeFileMetadataTest {
    @TempDir Path directory;

    @Test void nodeSourcesAndBuildFilesReachEditorWithCorrectLanguage() throws Exception {
        var service = new WorkspaceFileService(directory);
        for (var file : Map.of("main.js", "javascript", "main.mjs", "javascript", "main.cjs", "javascript",
                "main.ts", "typescript", "types.d.ts", "typescript", "package.json", "json", "pnpm-lock.yaml", "yaml").entrySet()) {
            Files.writeString(directory.resolve(file.getKey()), "// Manao\n");
            var meta = service.meta(file.getKey());
            assertThat(meta.language()).as(file.getKey()).isEqualTo(file.getValue());
            assertThat(meta.renderMode()).isEqualTo("MONACO_TEXT");
            assertThat(service.content(file.getKey()).content()).isEqualTo("// Manao\n");
        }
    }
}
