package com.manao.poc4.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.assertj.core.api.Assertions.assertThat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class HttpErrorContractTest {
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(new ErrorProbeController())
            .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    @Test
    void thrownApiExceptionSerializesOnlyThreeSafeFields() throws Exception {
        String body = mockMvc.perform(get("/test/error"))
            .andExpect(status().isBadRequest())
            .andReturn().getResponse().getContentAsString();
        Map<String, Object> parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Map.class);
        assertThat(parsed).containsOnlyKeys("code", "message", "traceId");
        assertThat(parsed.get("traceId")).asString().matches("[0-9a-f-]{36}");
    }

    @org.springframework.web.bind.annotation.RestController
    public static class ErrorProbeController {
        @org.springframework.web.bind.annotation.GetMapping("/test/error")
        String error() { throw new ApiException("VALIDATION_ERROR", 400, "path=/workspace/secret"); }
    }
}
