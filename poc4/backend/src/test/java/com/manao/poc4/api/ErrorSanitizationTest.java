package com.manao.poc4.api;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ErrorSanitizationTest {
    @Test
    void apiErrorContainsOnlySafeFiniteFields() {
        ApiError error = new ApiError("INTERNAL_ERROR", "Request failed", "trace-opaque");
        assertThat(error.toMap()).containsOnlyKeys("code", "message", "traceId");
        String body = error.toString();
        assertThat(body).doesNotContain("jwt", "password", "PVC", "Pod", "Job", "command", "path", "stack");
    }

    @Test
    void sensitiveMessagesAreReplacedWithFixedText() {
        ApiError error = new ApiError("INTERNAL_ERROR", "JWT password at /tmp/pvc", "trace-opaque");
        assertThat(error.message()).isEqualTo("Request failed");
    }

    @Test
    void pathsTokensAndRequestIdsNeverReachBrowserMessage() {
        for (String value : new String[]{"token abc", "requestId=abc", "path=/workspace/a", "C:\\secret\\file", "../outside"}) {
            assertThat(new ApiError("INTERNAL_ERROR", value, null).message()).isEqualTo("Request failed");
        }
    }

    @Test
    void invalidTraceIdsAreReplacedWithUniqueOpaqueValues() {
        ApiError first = new ApiError("INTERNAL_ERROR", "Request failed", null);
        ApiError second = new ApiError("INTERNAL_ERROR", "Request failed", "request-id");
        assertThat(first.traceId()).matches("[0-9a-f-]{36}");
        assertThat(second.traceId()).matches("[0-9a-f-]{36}");
        assertThat(first.traceId()).isNotEqualTo(second.traceId());
    }

    @Test
    void forbiddenHandlerReturnsApiErrorContract() {
        var response = new GlobalExceptionHandler().forbidden();
        assertThat(response.getStatusCode().value()).isEqualTo(403);
        assertThat(response.getBody().toMap()).containsOnlyKeys("code", "message", "traceId");
    }
}
