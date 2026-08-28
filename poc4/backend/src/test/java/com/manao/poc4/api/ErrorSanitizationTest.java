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
}
