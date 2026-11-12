package com.manao.poc4.ai.studio;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceService;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class StudioReadToolsTest {
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final StudioReadTools reads = new StudioReadTools(workspace, mock(RunStore.class), mock(RunLogService.class));

    private WorkspaceAgent.TreeEntry entry(String path, String kind) {
        return new WorkspaceAgent.TreeEntry(path, path, kind, false, null, null);
    }

    @Test void listsFastApiDirectoriesAndFilesWithoutExposingCredentialsOrGeneratedContent() {
        when(workspace.tree("owner", "project", "")).thenReturn(new WorkspaceAgent.Tree("", List.of(
            entry("app", "directory"), entry("tests", "directory"), entry("src", "directory"),
            entry("README.md", "file"), entry("main.py", "file"), entry("pyproject.toml", "file"),
            entry("uv.lock", "file"), entry(".python-version", "file"),
            entry(".env", "file"), entry(".git", "directory"), entry(".manao-cache", "directory"),
            entry("__pycache__", "directory"), entry("venv", "directory"), entry("node_modules", "directory"),
            entry(".python-version", "directory"), entry(".npmrc", "file"), entry("credentials.json", "file"),
            entry("image.png", "file"), entry("unknown", "symlink"))));

        var result = reads.invoke("owner", "project", "list_files", StudioStore.JSON.createObjectNode());

        assertThat(result.findValuesAsText("path")).containsExactly("app", "tests", "src", "README.md",
            "main.py", "pyproject.toml", "uv.lock", ".python-version");
        verify(workspace).tree("owner", "project", "");
        verifyNoMoreInteractions(workspace);
    }

    @Test void traversesNestedPythonDirectoriesThenReadsTheSourceAsTheSameOwner() {
        when(workspace.tree("owner", "project", "app/api")).thenReturn(new WorkspaceAgent.Tree("app/api", List.of(
            entry("app/api/routes.py", "file"), entry("app/api/subpackage", "directory"),
            entry("app/api/credentials.json", "file"))));
        when(workspace.meta("owner", "project", "app/api/routes.py")).thenReturn(new WorkspaceAgent.FileMeta(
            "app/api/routes.py", "routes.py", 11L, "text/plain", "UTF-8", "text", "MONACO_TEXT", null, "sha"));
        when(workspace.content("owner", "project", "app/api/routes.py")).thenReturn(
            new WorkspaceAgent.Content("app/api/routes.py", "print('ok')", "sha"));

        var listed = reads.invoke("owner", "project", "list_files", StudioStore.JSON.createObjectNode().put("directory", "app/api"));
        assertThat(listed.findValuesAsText("path")).containsExactly("app/api/routes.py", "app/api/subpackage");
        var source = reads.invoke("owner", "project", "read_file", StudioStore.JSON.createObjectNode().put("path", "app/api/routes.py"));
        assertThat(source.path("content").asText()).isEqualTo("print('ok')");
        verify(workspace).tree("owner", "project", "app/api");
        verify(workspace).meta("owner", "project", "app/api/routes.py");
        verify(workspace).content("owner", "project", "app/api/routes.py");
        verifyNoMoreInteractions(workspace);
    }

    @ParameterizedTest
    @ValueSource(strings = {"../app", "/app", "app//api", "app\\api", ".git", ".manao-cache", "app/.env.local",
        "app/credentials.json", "app/server.key", "venv", "__pycache__", "app/__pycache__", "node_modules", "target", "dist"})
    void refusesForbiddenDirectoryPathsBeforeCallingWorkspace(String directory) {
        assertThatThrownBy(() -> reads.invoke("owner", "project", "list_files",
            StudioStore.JSON.createObjectNode().put("directory", directory)))
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo("PATH_FORBIDDEN"));
        verifyNoInteractions(workspace);
    }

    @Test void directoryAccessDoesNotPermitReadingArbitraryFilesOrExecutingMutations() {
        for (String path : List.of("app", "tests", "app/image.png", "app/.env", "app/id_rsa")) {
            assertThatThrownBy(() -> reads.invoke("owner", "project", "read_file", StudioStore.JSON.createObjectNode().put("path", path)))
                .isInstanceOf(ApiException.class);
        }
        for (String tool : List.of("write_file", "build", "application", "python_dependencies", "bash")) {
            assertThatThrownBy(() -> reads.invoke("owner", "project", tool, StudioStore.JSON.createObjectNode()))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo("AI_READ_ONLY"));
        }
        verifyNoInteractions(workspace);
    }
}
