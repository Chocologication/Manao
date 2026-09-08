package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.util.HashSet;
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
}
