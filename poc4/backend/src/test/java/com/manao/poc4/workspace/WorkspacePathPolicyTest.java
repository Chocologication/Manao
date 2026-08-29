package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class WorkspacePathPolicyTest {
    @Test
    void acceptsProjectRelativePaths() {
        assertThat(WorkspacePathPolicy.validateRelativePath("pom.xml")).isEqualTo("pom.xml");
        assertThat(WorkspacePathPolicy.validateRelativePath("src/main/java/com/example/App.java"))
            .isEqualTo("src/main/java/com/example/App.java");
        assertThat(WorkspacePathPolicy.validateRelativePath(".gitignore")).isEqualTo(".gitignore");
        assertThat(WorkspacePathPolicy.validateRelativePath("docs/notes.deep.md")).isEqualTo("docs/notes.deep.md");
    }

    @Test
    void rejectsAbsoluteAndWindowsPaths() {
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("/etc/passwd"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("C:/temp/a.txt"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("C:\\temp\\a.txt"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("\\\\server\\share\\a.txt"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
    }

    @Test
    void rejectsTraversalEmptyAndReservedSegments() {
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath(".."))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("src/../../etc/passwd"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("src/./App.java"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("src//App.java"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("src/"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath(""))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath(null))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
    }

    @Test
    void rejectsControlCharactersAndEncodedTraversalPayloads() {
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("a\0b"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        // The servlet decodes %2e%2e before validation, so the decoded form must be rejected.
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("%2e%2e/escape"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath("a\nb"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
    }

    @Test
    void rejectsAgentInternalDirectoryNames() {
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath(".manao"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        assertThatThrownBy(() -> WorkspacePathPolicy.validateRelativePath(".manao/receipts/op.json"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
    }
}
