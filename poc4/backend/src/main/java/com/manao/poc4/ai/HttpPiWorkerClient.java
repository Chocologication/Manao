package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The HTTP transport to the Pi worker. The client speaks the three worker routes
 * (start/status/stop) with the fixed worker token, never retries a start on its own
 * (a lost start response is reconciled by re-reading the task, never by a second
 * start with a new identity) and maps every failure to a fixed, safe error — no
 * endpoint, header or environment detail ever leaves this class in a message.
 */
public final class HttpPiWorkerClient implements PiWorkerClient {
    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http;
    private final String baseUrl;
    private final String token;
    private final Duration timeout;

    public HttpPiWorkerClient(String baseUrl, String token, Duration timeout) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        this.token = token;
        this.timeout = timeout == null ? Duration.ofSeconds(15) : timeout;
        this.http = HttpClient.newBuilder().connectTimeout(this.timeout).build();
    }

    @Override public AgentContracts.WorkerStatus start(AgentContracts.WorkerStart start) {
        return exchange("POST", "/tasks/" + start.taskId() + "/start", start);
    }

    @Override public AgentContracts.WorkerStatus status(String taskId) {
        return exchange("GET", "/tasks/" + taskId, null);
    }

    @Override public AgentContracts.WorkerStatus stop(String taskId) {
        return exchange("POST", "/tasks/" + taskId + "/stop", new StopBody(taskId));
    }

    @Override public AgentContracts.WorkerProcessStatus processStatus() {
        var response = send("GET", "/status", null);
        if (response.statusCode() != 200) { parse("GET", response); throw new AssertionError("unreachable"); }
        try { return JSON.readValue(response.body(), AgentContracts.WorkerProcessStatus.class); }
        catch (IOException ex) { throw new ApiException("AI_WORKER_BAD_RESPONSE", 502, "The worker answer was unreadable"); }
    }

    @Override public AgentConversationContracts.CompactStatus startCompaction(AgentConversationContracts.CompactStart start) {
        return compactExchange("POST", "/conversations/" + start.conversationId() + "/compact", start);
    }
    @Override public AgentConversationContracts.CompactStatus compactionStatus(String conversationId, String requestId) {
        return compactExchange("GET", "/conversations/" + conversationId + "/compactions/" + requestId, null);
    }
    private AgentConversationContracts.CompactStatus compactExchange(String method, String path, Object body) {
        var response = send(method, path, body);
        if (response.statusCode() != 200) { parse(method, response); throw new AssertionError("unreachable"); }
        try { return JSON.readValue(response.body(), AgentConversationContracts.CompactStatus.class); }
        catch (IOException ex) { throw new ApiException("AI_WORKER_BAD_RESPONSE", 502, "The worker answer was unreadable"); }
    }
    private AgentContracts.WorkerStatus exchange(String method, String path, Object body) {
        return parse(method, send(method, path, body));
    }
    private HttpResponse<String> send(String method, String path, Object body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + path))
            .timeout(ReconcileWorkBudget.requestTimeout(timeout))
            .header("X-Manao-Worker-Token", token);
        if (body == null) {
            builder.GET();
        } else {
            builder.header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(writeJson(body)));
        }
        HttpResponse<String> response;
        try {
            response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException ex) {
            throw new ApiException("AI_WORKER_UNREACHABLE", 502, "the worker could not be reached");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ApiException("AI_WORKER_UNREACHABLE", 502, "the worker call was interrupted");
        }
        return response;
    }

    private AgentContracts.WorkerStatus parse(String method, HttpResponse<String> response) {
        if (response.statusCode() == 200) {
            try {
                return JSON.readValue(response.body(), AgentContracts.WorkerStatus.class);
            } catch (IOException ex) {
                throw new ApiException("AI_WORKER_BAD_RESPONSE", 502, "the worker answer was unreadable");
            }
        }
        if (response.statusCode() == 404) {
            throw new ApiException("AI_WORKER_NOT_FOUND", 404, "The worker task was not found");
        }
        if (response.statusCode() == 401 || response.statusCode() == 403) {
            throw new ApiException("AI_WORKER_UNAUTHORIZED", 502, "The worker refused authentication");
        }
        if (response.statusCode() == 503) {
            throw new ApiException("AI_WORKER_NOT_CONFIGURED", 503, "the worker has no model configuration");
        }
        if (response.statusCode() == 422) {
            try {
                if ("AI_REASONING_UNSUPPORTED".equals(JSON.readTree(response.body()).path("error").asText()))
                    throw new ApiException("AI_REASONING_UNSUPPORTED", 422, "The configured model does not support reasoning effort");
            } catch (IOException ignored) { /* Other responses stay opaque. */ }
        }
        if (response.statusCode() == 409) {
            throw new ApiException("AI_WORKER_CONFLICT", 409, "the worker refused the " + method + " as a conflict");
        }
        throw new ApiException("AI_WORKER_ERROR", 502, "the worker refused the " + method);
    }

    private static String writeJson(Object body) {
        try {
            return JSON.writeValueAsString(body);
        } catch (IOException ex) {
            throw new IllegalStateException("cannot serialize the worker request", ex);
        }
    }

    private record StopBody(String taskId) { }
}
