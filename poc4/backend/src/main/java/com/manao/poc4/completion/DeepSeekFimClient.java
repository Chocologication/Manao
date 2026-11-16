package com.manao.poc4.completion;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** One platform-configured FIM request; never logs source or supplier diagnostics. */
public final class DeepSeekFimClient {
    private static final Logger LOG = LoggerFactory.getLogger(DeepSeekFimClient.class);
    private final HttpClient http;
    private final ObjectMapper json;
    private final URI endpoint;
    private final String apiKey;
    private final String model;
    private final Duration requestTimeout;

    public DeepSeekFimClient(HttpClient http, ObjectMapper json, URI endpoint,
                             String apiKey, String model, Duration requestTimeout) {
        this.http = http;
        this.json = json;
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.model = model;
        this.requestTimeout = requestTimeout;
    }

    public String complete(String prefix, String suffix) {
        if (apiKey.isBlank()) return null;
        long start = System.nanoTime();
        CompletableFuture<HttpResponse<String>> pending = null;
        try {
            var payload = Map.of("model", model, "prompt", prefix, "suffix", suffix,
                "max_tokens", 256, "temperature", 0, "stream", false);
            var request = HttpRequest.newBuilder(endpoint).timeout(requestTimeout)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(payload))).build();
            // HttpRequest.timeout alone need not bound a stalled response body. Bound
            // completion of the whole exchange and cancel its future on expiry.
            pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
            var response = pending.get(requestTimeout.toNanos(), TimeUnit.NANOSECONDS);
            if (response.statusCode() < 200 || response.statusCode() >= 300) throw unavailable();
            var root = json.readTree(response.body());
            if (root == null || !root.isObject()) throw protocol();
            var choices = root.get("choices");
            if (choices == null || !choices.isArray()) throw protocol();
            if (choices.isEmpty()) return null;
            var text = choices.get(0).get("text");
            if (text == null) throw protocol();
            if (text.isNull()) return null;
            if (!text.isTextual()) throw protocol();
            return text.textValue().isEmpty() ? null : text.textValue();
        } catch (InterruptedException interrupted) {
            if (pending != null) pending.cancel(true);
            Thread.currentThread().interrupt();
            throw failure(unavailable(), start);
        } catch (TimeoutException timeout) {
            if (pending != null) pending.cancel(true);
            throw failure(unavailable(), start);
        } catch (ExecutionException transport) {
            throw failure(unavailable(), start);
        } catch (JsonProcessingException malformed) {
            throw failure(protocol(), start);
        } catch (ApiException error) {
            throw failure(error, start);
        }
    }

    private static ApiException unavailable() {
        return new ApiException("AI_MODEL_UNAVAILABLE", 503, "Completion unavailable");
    }

    private static ApiException protocol() {
        return new ApiException("AI_MODEL_PROTOCOL", 502, "Completion response invalid");
    }

    private static ApiException failure(ApiException error, long start) {
        LOG.warn("FIM {} elapsedMs={}", error.code(), (System.nanoTime() - start) / 1_000_000);
        return error;
    }
}
