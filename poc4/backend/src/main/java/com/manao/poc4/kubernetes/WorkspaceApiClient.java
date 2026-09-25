package com.manao.poc4.kubernetes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceAgentException;
import com.manao.poc4.workspace.WorkspaceCapabilitySigner;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Capability-signed HTTP transport to a project workspace-agent. This is the only backend class
 * allowed to touch workspace Pod file APIs; endpoint resolution is delegated so the 6A profile
 * can substitute a loopback port-forward bridge without changing this boundary.
 */
public final class WorkspaceApiClient implements WorkspaceAgent {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration TIMEOUT = Duration.ofSeconds(30);

    /** Resolves the namespace-internal base URI of a project's workspace-agent. */
    public interface EndpointResolver {
        URI endpoint(String projectId);
    }

    private final EndpointResolver resolver;
    private final WorkspaceCapabilitySigner signer;
    private final HttpClient http;
    private final Duration timeout;

    public WorkspaceApiClient(EndpointResolver resolver, WorkspaceCapabilitySigner signer) {
        this(resolver, signer, TIMEOUT);
    }

    WorkspaceApiClient(EndpointResolver resolver, WorkspaceCapabilitySigner signer, Duration timeout) {
        this.resolver = resolver;
        this.signer = signer;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    /** 6B profile: workspace Service is reachable directly inside the namespace. */
    public static EndpointResolver clusterInternal(String namespace, int agentPort) {
        return projectId -> URI.create("http://manao-ws-" + projectId + "." + namespace + ".svc.cluster.local:" + agentPort);
    }

    @Override
    public Tree tree(String projectId, String directory) {
        JsonNode node = get(projectId, "/agent/v1/tree", "path", directory);
        List<TreeEntry> entries = stream(node.get("entries"))
            .map(WorkspaceApiClient::entry).toList();
        return new Tree(text(node, "directory"), entries);
    }

    @Override
    public FileMeta meta(String projectId, String path) {
        JsonNode node = get(projectId, "/agent/v1/meta", "path", path);
        if (node == null) return null;
        return meta(node);
    }

    @Override
    public Content content(String projectId, String path) {
        JsonNode node = get(projectId, "/agent/v1/content", "path", path);
        return new Content(text(node, "path"), text(node, "content"), text(node, "sha256"));
    }

    @Override
    public Download download(String projectId, String path) {
        String query = "path=" + encode(path);
        HttpRequest request = requestBuilder(projectId, "GET", "/agent/v1/download?" + query, null)
            .GET().build();
        HttpResponse<byte[]> response = send(projectId, request, "GET", "/agent/v1/download?" + query);
        if (response.statusCode() != 200) throw error(response);
        return new Download(path, response.headers().firstValue("Content-Type").orElse("application/octet-stream"),
            response.body());
    }

    @Override
    public MutationResult mutate(String projectId, Command command) {
        return switch (command.type()) {
            case "SAVE" -> mutationFrom(sendJson(projectId, "PUT",
                "/agent/v1/content?" + saveQuery(command), command.content()));
            case "CREATE", "RENAME" -> mutationFrom(sendJson(projectId, "POST",
                command.type().equals("CREATE") ? "/agent/v1/entries" : "/agent/v1/entries/rename",
                body(command).getBytes(StandardCharsets.UTF_8)));
            case "DELETE" -> mutationFrom(sendJson(projectId, "DELETE", "/agent/v1/entries?" + deleteQuery(command), null));
            default -> throw new WorkspaceAgentException(422, "VALIDATION_ERROR", "unsupported mutation");
        };
    }

    @Override
    public Optional<FetchedReceipt> receipt(String projectId, String operationId) {
        HttpRequest request = requestBuilder(projectId, "GET", "/agent/v1/receipts/" + operationId, null)
            .GET().build();
        HttpResponse<byte[]> response = send(projectId, request, "GET", "/agent/v1/receipts/" + operationId);
        if (response.statusCode() == 404) return Optional.empty();
        if (response.statusCode() != 200) throw error(response);
        byte[] body = response.body();
        try {
            JsonNode node = JSON.readTree(new String(body, StandardCharsets.UTF_8));
            return Optional.of(new FetchedReceipt(text(node, "operationId"), text(node, "type"), text(node, "path"),
                text(node, "nextPath"), text(node, "beforeSha256"), text(node, "afterSha256"),
                text(node, "receiptSha256")));
        } catch (Exception ex) {
            throw new WorkspaceAgentException(503, "IO_ERROR", "unreadable receipt");
        }
    }

    private JsonNode get(String projectId, String pathAndQuery, String param, String value) {
        HttpRequest request = requestBuilder(projectId, "GET", pathAndQuery + "?" + param + "=" + encode(value), null)
            .GET().build();
        HttpResponse<byte[]> response = send(projectId, request, "GET", pathAndQuery);
        if (response.statusCode() == 404) throw notFound(response);
        if (response.statusCode() != 200) throw error(response);
        return parse(response.body());
    }

    private JsonNode sendJson(String projectId, String method, String pathAndQuery, byte[] body) {
        byte[] payload = body == null ? new byte[0] : body;
        HttpRequest.Builder builder = requestBuilder(projectId, method, pathAndQuery, payload);
        if ("PUT".equals(method) || "POST".equals(method)) {
            builder.header("Content-Type", "POST".equals(method) ? "application/json" : "application/octet-stream")
                .method(method, HttpRequest.BodyPublishers.ofByteArray(payload));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        HttpResponse<byte[]> response = send(projectId, builder.build(), method, pathAndQuery);
        if (response.statusCode() == 404) throw notFound(response);
        if (response.statusCode() != 200) throw error(response);
        return parse(response.body());
    }

    private String saveQuery(Command command) {
        return "path=" + encode(command.path()) + "&operationId=" + encode(command.operationId())
            + "&expectedBeforeSha256=" + encode(command.expectedBeforeSha256())
            + "&expectedAfterSha256=" + encode(command.expectedAfterSha256())
            + "&receiptJson=" + encode(command.receiptJson())
            + "&expectedReceiptSha256=" + encode(command.expectedReceiptSha256());
    }

    private String deleteQuery(Command command) {
        return "path=" + encode(command.path()) + "&operationId=" + encode(command.operationId())
            + "&expectedBeforeSha256=" + encode(command.expectedBeforeSha256())
            + "&expectedAfterSha256=" + encode(command.expectedAfterSha256())
            + "&receiptJson=" + encode(command.receiptJson())
            + "&expectedReceiptSha256=" + encode(command.expectedReceiptSha256());
    }

    private String body(Command command) {
        return "{\"kind\":" + JSON.valueToTree(command.kind())
            + ",\"path\":" + JSON.valueToTree(command.path())
            + ",\"nextPath\":" + JSON.valueToTree(command.nextPath())
            + ",\"operationId\":" + JSON.valueToTree(command.operationId())
            + ",\"expectedBeforeSha256\":" + JSON.valueToTree(command.expectedBeforeSha256())
            + ",\"expectedAfterSha256\":" + JSON.valueToTree(command.expectedAfterSha256())
            + ",\"receiptJson\":" + JSON.valueToTree(command.receiptJson())
            + ",\"expectedReceiptSha256\":" + JSON.valueToTree(command.expectedReceiptSha256()) + "}";
    }

    private HttpRequest.Builder requestBuilder(String projectId, String method, String pathAndQuery, byte[] body) {
        byte[] payload = body == null ? new byte[0] : body;
        return HttpRequest.newBuilder()
            .uri(resolver.endpoint(projectId).resolve(pathAndQuery))
            .timeout(timeout)
            .header("X-Manao-Workspace-Capability", signer.sign(method, pathAndQuery, payload, projectId));
    }

    private HttpResponse<byte[]> send(String projectId, HttpRequest request, String method, String pathAndQuery) {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new WorkspaceAgentException(503, "IO_ERROR", "workspace API is temporarily unavailable",
                WorkspaceAgentException.TransportFailure.INTERRUPTED);
        } catch (java.io.IOException ex) {
            throw new WorkspaceAgentException(503, "IO_ERROR", "workspace API is temporarily unavailable",
                classifyTransportFailure(ex));
        }
    }

    static WorkspaceAgentException.TransportFailure classifyTransportFailure(Throwable failure) {
        for (Throwable current = failure; current != null; current = current.getCause()) {
            if (current instanceof InterruptedException) return WorkspaceAgentException.TransportFailure.INTERRUPTED;
            if (current instanceof HttpConnectTimeoutException) return WorkspaceAgentException.TransportFailure.CONNECT_TIMEOUT;
            if (current instanceof HttpTimeoutException) return WorkspaceAgentException.TransportFailure.TIMEOUT;
            if (current instanceof ConnectException) return WorkspaceAgentException.TransportFailure.CONNECT;
            if (current instanceof SocketException) return WorkspaceAgentException.TransportFailure.RESET;
            if (current instanceof java.io.IOException && isConnectionReset(current.getMessage()))
                return WorkspaceAgentException.TransportFailure.RESET;
        }
        return WorkspaceAgentException.TransportFailure.OTHER;
    }

    /**
     * A connection reset can surface as a plain {@link java.io.IOException} ("Connection reset by peer")
     * instead of a {@link SocketException}, depending on where the read fails; only match that explicit
     * message so every other unspecified IOException stays fail-closed OTHER.
     */
    private static boolean isConnectionReset(String message) {
        return message != null && message.toLowerCase(Locale.ROOT).contains("connection reset");
    }
    private static MutationResult mutationFrom(JsonNode node) {
        return new MutationResult(text(node, "operationId"), text(node, "path"), text(node, "beforeSha256"),
            text(node, "afterSha256"), text(node, "receiptPath"), text(node, "receiptSha256"));
    }

    private static FileMeta meta(JsonNode node) {
        return new FileMeta(text(node, "path"), text(node, "name"), optLong(node, "sizeBytes"),
            text(node, "mediaType"), optText(node, "encoding"), text(node, "language"),
            text(node, "renderMode"), optText(node, "blockReason"), optText(node, "sha256"));
    }

    private static TreeEntry entry(JsonNode node) {
        return new TreeEntry(text(node, "path"), text(node, "name"), text(node, "kind"), node.get("hidden").asBoolean(),
            node.hasNonNull("sizeBytes") ? node.get("sizeBytes").asLong() : null,
            node.hasNonNull("hasChildren") ? node.get("hasChildren").asBoolean() : null);
    }

    private static WorkspaceAgentException error(HttpResponse<byte[]> response) {
        try {
            JsonNode node = JSON.readTree(new String(response.body(), StandardCharsets.UTF_8));
            return new WorkspaceAgentException(response.statusCode(), text(node, "code"), text(node, "message"));
        } catch (Exception ex) {
            return new WorkspaceAgentException(response.statusCode(), "IO_ERROR", "workspace API error");
        }
    }

    private static WorkspaceAgentException notFound(HttpResponse<byte[]> response) {
        WorkspaceAgentException error = error(response);
        return new WorkspaceAgentException(404, "ENTRY_NOT_FOUND".equals(error.code()) ? "ENTRY_NOT_FOUND" : error.code(),
            error.getMessage());
    }

    private static JsonNode parse(byte[] body) {
        try {
            return JSON.readTree(new String(body, StandardCharsets.UTF_8));
        } catch (Exception ex) {
            throw new WorkspaceAgentException(503, "IO_ERROR", "invalid workspace API response");
        }
    }

    private static String text(JsonNode node, String field) {
        return node.get(field).asText();
    }

    private static String optText(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }

    private static Long optLong(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asLong() : null;
    }

    private static java.util.stream.Stream<JsonNode> stream(JsonNode array) {
        return array == null ? java.util.stream.Stream.empty() : java.util.stream.StreamSupport.stream(
            array.spliterator(), false);
    }

    private static String encode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }
}
