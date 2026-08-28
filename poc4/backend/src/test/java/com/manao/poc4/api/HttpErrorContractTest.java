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

    @Test
    void rawJwtLikeMessageIsReplacedByCodeAllowlistedText() throws Exception {
        String body = mockMvc.perform(get("/test/jwt"))
            .andExpect(status().isUnauthorized()).andReturn().getResponse().getContentAsString();
        Map<String, Object> parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Map.class);
        assertThat(parsed).containsEntry("code", "UNAUTHENTICATED").containsEntry("message", "Authentication required");
    }

    @Test
    void unlabelledPasswordMessageIsNeverReturned() throws Exception {
        String body = mockMvc.perform(get("/test/password"))
            .andExpect(status().isForbidden()).andReturn().getResponse().getContentAsString();
        Map<String, Object> parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Map.class);
        assertThat(parsed).containsEntry("code", "FORBIDDEN").containsEntry("message", "Access denied");
    }

    @Test
    void stackFrameMessageIsNeverReturned() throws Exception {
        String body = mockMvc.perform(get("/test/stack"))
            .andExpect(status().isInternalServerError()).andReturn().getResponse().getContentAsString();
        Map<String, Object> parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Map.class);
        assertThat(parsed).containsEntry("code", "INTERNAL_ERROR").containsEntry("message", "Request failed");
    }

    @org.springframework.web.bind.annotation.RestController
    public static class ErrorProbeController {
        @org.springframework.web.bind.annotation.GetMapping("/test/error")
        String error() { throw new ApiException("VALIDATION_ERROR", 400, "path=/workspace/secret"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/jwt")
        String jwt() { throw new ApiException("UNAUTHENTICATED", 401, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signature"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/password")
        String password() { throw new ApiException("FORBIDDEN", 403, "hunter2"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/stack")
        String stack() { throw new ApiException("INTERNAL_ERROR", 500, "at com.internal.SecretService.run(SecretService.java:42)"); }
    }
}
