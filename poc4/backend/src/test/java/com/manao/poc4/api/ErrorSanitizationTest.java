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

    @Test
    void publicPortErrorsKeepTheirFixedCodeAndSafeMessage() {
        // Port errors must not degrade to INTERNAL_ERROR and must never carry the raw
        // Kubernetes response forward.
        assertThat(new ApiError("PUBLIC_PORT_RESERVED", "raw kubernetes status payload", null))
            .extracting(ApiError::code, ApiError::message)
            .containsExactly("PUBLIC_PORT_RESERVED", "Public port is reserved. Choose another port.");
        assertThat(new ApiError("PUBLIC_PORT_IN_USE", "raw kubernetes status payload", null))
            .extracting(ApiError::code, ApiError::message)
            .containsExactly("PUBLIC_PORT_IN_USE", "Public port is already in use. Choose another port.");
    }

    @Test
    void publicPortPreflightUnavailableKeepsFixedCodeAndSafeMessage() {
        // An uncertain preflight must fail closed without revealing anything: no occupied/free
        // claim, no namespace, no owner and no raw Kubernetes reason may reach the browser.
        ApiError error = new ApiError("PUBLIC_PORT_PREFLIGHT_UNAVAILABLE",
            "Forbidden: services is forbidden for user manao-backend in namespace other-ns", null);
        assertThat(error.code()).isEqualTo("PUBLIC_PORT_PREFLIGHT_UNAVAILABLE");
        assertThat(error.message())
            .isEqualTo("Public port availability cannot be verified right now. Try again later.");
        assertThat(error.toString()).doesNotContain("forbidden", "other-ns", "manao-backend");
    }

    @Test
    void creationMismatchKeepsItsFixedCodeAndSafeMessage() {
        assertThat(new ApiError("CREATE_REQUEST_MISMATCH", "digest abc123 does not match def456", null))
            .extracting(ApiError::code, ApiError::message)
            .containsExactly("CREATE_REQUEST_MISMATCH", "Creation request does not match the original request");
    }

    @Test
    void unknownCodesStillDegradeToInternalError() {
        ApiError error = new ApiError("SOME_UNLISTED_CODE", "anything", null);
        assertThat(error.code()).isEqualTo("INTERNAL_ERROR");
        assertThat(error.message()).isEqualTo("Request failed");
    }

    @Test
    void internalHandlerDoesNotLeakExceptionMessage() {
        var response = new GlobalExceptionHandler().internal(
            new IllegalStateException("token=leak kubeconfig=/tmp/secret"));
        assertThat(response.getStatusCode().value()).isEqualTo(500);
        assertThat(response.getBody().message()).isEqualTo("Request failed");
        assertThat(response.getBody().toString()).doesNotContain("token", "kubeconfig", "secret");
    }
}
