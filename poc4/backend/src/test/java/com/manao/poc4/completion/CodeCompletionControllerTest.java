package com.manao.poc4.completion;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.project.ProjectService;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class CodeCompletionControllerTest {
    private final ProjectService projects = mock(ProjectService.class);
    private final DeepSeekFimClient client = mock(DeepSeekFimClient.class);
    private final ObjectMapper json = new ObjectMapper();
    private MockMvc mvc;

    @BeforeEach void setup() {
        mvc = MockMvcBuilders.standaloneSetup(new CodeCompletionController(projects, client))
            .setControllerAdvice(new GlobalExceptionHandler()).build();
        when(projects.get("owner", "project")).thenReturn(Optional.of(
            new ProjectService.Project("project", "owner", "test", "READY", Instant.EPOCH, null)));
    }

    @Test void ownedReadyProjectUsesOnlyPrefixAndSuffixIncludingEmptyStrings() throws Exception {
        when(client.complete("", "")).thenReturn("  a + b\n");
        var result = send("{\"prefix\":\"\",\"suffix\":\"\"}");
        assertThat(result.getStatus()).isEqualTo(200);
        assertThat(json.readTree(result.getContentAsString()).get("completion").asText()).isEqualTo("  a + b\n");
        var order = inOrder(projects, client);
        order.verify(projects).get("owner", "project");
        order.verify(client).complete("", "");
    }

    @Test void missingNullAndOversizedFieldsNeverReachTheModel() throws Exception {
        for (String body : new String[] {"{}", "{\"prefix\":null,\"suffix\":\"\"}", "{\"prefix\":\"\"}",
            json.writeValueAsString(Map.of("prefix", "x".repeat(16001), "suffix", "")),
            json.writeValueAsString(Map.of("prefix", "", "suffix", "x".repeat(16001)))}) {
            assertThat(send(body).getStatus()).as(body.substring(0, Math.min(body.length(), 60))).isEqualTo(422);
        }
        verifyNoInteractions(client);
    }

    @Test void exactly16000Utf16UnitsAreAccepted() throws Exception {
        String text = "\uD83D\uDE00".repeat(8000);
        assertThat(send(json.writeValueAsString(Map.of("prefix", text, "suffix", text))).getStatus()).isEqualTo(200);
        verify(client).complete(text, text);
    }

    @Test void absentOrForeignProjectReturns404BeforeCallingModel() throws Exception {
        when(projects.get("owner", "project")).thenReturn(Optional.empty());
        var result = send("{\"prefix\":\"\",\"suffix\":\"\"}");
        assertThat(result.getStatus()).isEqualTo(404);
        assertThat(result.getContentAsString()).contains("ENTRY_NOT_FOUND");
        verifyNoInteractions(client);
    }

    @Test void notReadyProjectReturnsAnEmptySuggestion() throws Exception {
        when(projects.get("owner", "project")).thenReturn(Optional.of(
            new ProjectService.Project("project", "owner", "test", "CREATING", Instant.EPOCH, null)));
        var result = send("{\"prefix\":\"\",\"suffix\":\"\"}");
        assertThat(result.getStatus()).isEqualTo(200);
        assertThat(json.readTree(result.getContentAsString()).get("completion").isNull()).isTrue();
        verifyNoInteractions(client);
    }

    private org.springframework.mock.web.MockHttpServletResponse send(String body) throws Exception {
        return mvc.perform(post("/api/v1/projects/project/code-completions")
            .principal(new org.springframework.security.authentication.UsernamePasswordAuthenticationToken("owner", null))
            .contentType("application/json").content(body)).andReturn().getResponse();
    }
}
