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
        @org.springframework.web.bind.annotation.GetMapping("/test/assistant/{code}")
        String assistant(@org.springframework.web.bind.annotation.PathVariable String code) {
            throw new ApiException(code, 503, "upstream-secret at /private/model-response");
        }
        @org.springframework.web.bind.annotation.GetMapping("/test/error")
        String error() { throw new ApiException("VALIDATION_ERROR", 400, "path=/workspace/secret"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/jwt")
        String jwt() { throw new ApiException("UNAUTHENTICATED", 401, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signature"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/password")
        String password() { throw new ApiException("FORBIDDEN", 403, "hunter2"); }
        @org.springframework.web.bind.annotation.GetMapping("/test/stack")
        String stack() { throw new ApiException("INTERNAL_ERROR", 500, "at com.internal.SecretService.run(SecretService.java:42)"); }
    }

    @Test
    void assistantFailuresKeepTheirCodesWithoutExposingUpstreamResponses() throws Exception {
        for (String code : java.util.List.of(
                "AI_CREDENTIALS_UNAVAILABLE", "AI_VISION_UNSUPPORTED", "AI_APPLY_MISMATCH",
                "AI_APPLY_INTERRUPTED", "AI_APPLY_CONFLICT", "AI_BUSY", "AI_MODEL_REJECTED",
                "AI_MODEL_DISCONNECTED", "AI_MODEL_INCOMPLETE", "AI_MODEL_UNAVAILABLE", "AI_MODEL_PROTOCOL",
                "AI_READ_ONLY", "AI_STOPPED", "AI_TOOL_BUDGET", "AI_REVIEW_ISOLATED", "WORKSPACE_CONFLICT", "PATH_FORBIDDEN",
                "AI_ATTACHMENT_TOO_LARGE", "AI_ATTACHMENT_EXPIRED", "AI_ATTACHMENT_UNAVAILABLE",
                "AI_ATTACHMENT_NOT_FOUND", "AI_ATTACHMENT_CONFLICT", "AI_IMAGE_INPUT_DISABLED")) {
            String body = mockMvc.perform(get("/test/assistant/{code}", code))
                .andExpect(status().isServiceUnavailable()).andReturn().getResponse().getContentAsString();
            Map<String, Object> parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Map.class);
            assertThat(parsed).containsOnlyKeys("code", "message", "traceId").containsEntry("code", code);
            assertThat(parsed.get("message")).isNotEqualTo("Request failed");
            assertThat(body).doesNotContain("upstream-secret", "/private/model-response");
            assertThat(parsed.get("traceId")).asString().matches("[0-9a-f-]{36}");
        }
    }
}
