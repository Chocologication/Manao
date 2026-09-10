package com.manao.poc4.workspace;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class WorkspaceCreateHttpContractTest {
    @Test
    void creatingAFileReturnsCreatedWithItsNewRevision() throws Exception {
        WorkspaceService workspace = mock(WorkspaceService.class);
        when(workspace.createEntry("alice-id", "prj-1", "file", "notes.md", "7")).thenReturn(8L);
        when(workspace.meta("alice-id", "prj-1", "notes.md")).thenReturn(new WorkspaceAgent.FileMeta(
            "notes.md", "notes.md", 0L, "text/markdown", "UTF-8", "markdown", "MONACO_TEXT", null,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));

        MockMvcBuilders.standaloneSetup(new WorkspaceController(workspace)).build()
            .perform(post("/api/v1/projects/prj-1/entries")
                .principal(new UsernamePasswordAuthenticationToken("alice-id", "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"kind\":\"file\",\"path\":\"notes.md\",\"expectedWorkspaceRevision\":\"7\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.entry.path").value("notes.md"))
            .andExpect(jsonPath("$.workspaceRevision").value("8"));
    }

    @Test
    void creatingADirectoryAlsoReturnsCreated() throws Exception {
        WorkspaceService workspace = mock(WorkspaceService.class);
        when(workspace.createEntry("alice-id", "prj-1", "directory", "src", "7")).thenReturn(8L);

        MockMvcBuilders.standaloneSetup(new WorkspaceController(workspace)).build()
            .perform(post("/api/v1/projects/prj-1/entries")
                .principal(new UsernamePasswordAuthenticationToken("alice-id", "n/a"))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"kind\":\"directory\",\"path\":\"src\",\"expectedWorkspaceRevision\":\"7\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.entry.kind").value("directory"))
            .andExpect(jsonPath("$.workspaceRevision").value("8"));
    }
}
