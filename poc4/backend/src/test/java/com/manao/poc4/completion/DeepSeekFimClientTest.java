package com.manao.poc4.completion;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class DeepSeekFimClientTest {
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicInteger calls = new AtomicInteger();
    private HttpServer server;
    private ExecutorService executor;
    private JsonNode received;
    private String authorization;
    private String method;
    private String response = "{\"choices\":[{\"text\":\"a + b\\n\"}]}";
    private int status = 200;
    private long delay;
    private boolean earlyHeaders;

    @BeforeEach void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        server.createContext("/beta/completions", exchange -> {
            calls.incrementAndGet();
            method = exchange.getRequestMethod();
            authorization = exchange.getRequestHeaders().getFirst("Authorization");
            received = json.readTree(exchange.getRequestBody());
            try {
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                if (earlyHeaders) exchange.sendResponseHeaders(status, bytes.length);
                Thread.sleep(delay);
                if (!earlyHeaders) exchange.sendResponseHeaders(status, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally { exchange.close(); }
        });
        server.start();
    }

    @AfterEach void stop() {
        server.stop(0);
        executor.shutdownNow();
    }

    private DeepSeekFimClient client(String key, Duration timeout) {
        return new DeepSeekFimClient(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build(), json,
            URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/beta/completions"),
            key, "fixture-model", timeout);
    }

    @Test void preservesFimWhitespaceAndReturnsFirstTextWithoutFormatting() {
        assertThat(client("fixture-key", Duration.ofSeconds(2)).complete("def add(a, b):\n    return ", "\n"))
            .isEqualTo("a + b\n");
        assertThat(method).isEqualTo("POST");
        assertThat(authorization).isEqualTo("Bearer fixture-key");
        assertThat(received.get("prompt").asText()).isEqualTo("def add(a, b):\n    return ");
        assertThat(received.get("suffix").asText()).isEqualTo("\n");
        assertThat(received.get("model").asText()).isEqualTo("fixture-model");
        assertThat(received.get("max_tokens").asInt()).isEqualTo(256);
        assertThat(received.get("temperature").asDouble()).isZero();
        assertThat(received.get("stream").asBoolean()).isFalse();
        assertThat(received.size()).isEqualTo(6);
        assertThat(calls).hasValue(1);
    }

    @Test void emptyKeyDoesNotContactUpstreamAndDefaultConfigStarts() {
        assertThat(client("  ", Duration.ofSeconds(2)).complete("", "")).isNull();
        assertThat(calls).hasValue(0);
        new ApplicationContextRunner().withUserConfiguration(CodeCompletionConfig.class)
            .withBean(ObjectMapper.class, () -> json)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(DeepSeekFimClient.class).complete("", "")).isNull();
            });
    }

    @ParameterizedTest
    @ValueSource(strings = {"{\"choices\":[]}", "{\"choices\":[{\"text\":null}]}", "{\"choices\":[{\"text\":\"\"}]}"})
    void emptyResultsAreNull(String body) {
        response = body;
        assertThat(client("fixture-key", Duration.ofSeconds(2)).complete("", "")).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"not json fixture-key source-code", "null", "{}", "{\"choices\":{}}",
        "{\"choices\":[{}]}", "{\"choices\":[null]}", "{\"choices\":[{\"text\":123}]}"})
    void malformedProtocolHasOnlyAnOpaqueError(String body) {
        response = body;
        assertSafeFailure(502, "AI_MODEL_PROTOCOL");
    }

    @Test void upstreamFailureIsNotRetriedOrLeaked() {
        status = 429;
        response = "fixture-key source-code provider diagnostic";
        assertSafeFailure(503, "AI_MODEL_UNAVAILABLE");
        assertThat(calls).hasValue(1);
    }

    @Test void timeoutBoundsTheWholeResponseIncludingItsBody() {
        delay = 600;
        long start = System.nanoTime();
        assertSafeFailure(503, "AI_MODEL_UNAVAILABLE", Duration.ofMillis(100));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofMillis(550));
        assertThat(calls).hasValue(1);
    }

    @Test void networkFailureIsOpaque() {
        server.stop(0);
        assertSafeFailure(503, "AI_MODEL_UNAVAILABLE");
    }

    @Test void bodyStallingAfterHeadersStillTimesOut() {
        earlyHeaders = true;
        timeoutBoundsTheWholeResponseIncludingItsBody();
    }

    private void assertSafeFailure(int expectedStatus, String code) {
        assertSafeFailure(expectedStatus, code, Duration.ofSeconds(2));
    }

    private void assertSafeFailure(int expectedStatus, String code, Duration timeout) {
        assertThatThrownBy(() -> client("fixture-key", timeout).complete("source-code", ""))
            .isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.status()).isEqualTo(expectedStatus);
                assertThat(error.code()).isEqualTo(code);
                assertThat(error.getMessage()).doesNotContain("fixture-key", "source-code", "provider");
                assertThat(error.getCause()).isNull();
            });
    }
}
