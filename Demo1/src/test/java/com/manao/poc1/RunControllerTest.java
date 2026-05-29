package com.manao.poc1;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc1.run.CodeRunner;
import com.manao.poc1.run.RunRequest;
import com.manao.poc1.run.RunResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest
class RunControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockitoBean
    private CodeRunner codeRunner;

    @Test
    @DisplayName("POST /run rejects blank code")
    void run_whenCodeBlank_returnsBadRequest() throws Exception {
        RunRequest request = new RunRequest("   ");

        mockMvc.perform(post("/run")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
            .andExpect(status().isBadRequest());

        verifyNoInteractions(codeRunner);
    }

    @Test
    @DisplayName("POST /run returns stdout from code runner")
    void run_whenCodeValid_returnsStdout() throws Exception {
        RunRequest request = new RunRequest("public class Main { public static void main(String[] args) { System.out.println(\"Hello World\"); } }");
        when(codeRunner.run(any())).thenReturn(new RunResult("Hello World\n", "", 0, "job-123"));

        mockMvc.perform(post("/run")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.stdout").value("Hello World\n"))
            .andExpect(jsonPath("$.stderr").value(""))
            .andExpect(jsonPath("$.exitCode").value(0))
            .andExpect(jsonPath("$.jobName").value("job-123"));
    }
}
