package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceCapabilitySigner;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.EdECPrivateKey;
import java.time.Clock;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;

class WorkspaceApiClientTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PROJECT = "prj-contract";
    private static final String OPERATION = "00000000-0000-4000-8000-000000000001";
    private final AtomicReference<Request> received = new AtomicReference<>();
    private HttpServer server;
    private WorkspaceApiClient client;
    private KeyPair keyPair;
    private String responseBody;

    @BeforeEach
    void setUp() throws Exception {
        keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        responseBody = "{\"operationId\":\"" + OPERATION + "\",\"path\":\"src\","
            + "\"beforeSha256\":\"before\",\"afterSha256\":\"after\","
            + "\"receiptPath\":\".manao/receipts/" + OPERATION + ".json\",\"receiptSha256\":\"receipt\"}";
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            received.set(new Request(exchange.getRequestMethod(), exchange.getRequestURI(),
                exchange.getRequestHeaders().getFirst("Content-Type"),
                exchange.getRequestHeaders().getFirst("X-Manao-Workspace-Capability"),
                exchange.getRequestBody().readAllBytes()));
            byte[] response = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (var output = exchange.getResponseBody()) { output.write(response); }
        });
        server.start();
        URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        client = new WorkspaceApiClient(ignored -> endpoint, new WorkspaceCapabilitySigner(
            ((EdECPrivateKey) keyPair.getPrivate()).getBytes().orElseThrow(), Clock.systemUTC()));
    }

    @AfterEach
    void tearDown() { if (server != null) server.stop(0); }

    @Test
    void createUsesJsonAcceptedByTheAgentRequestBodyConverter() throws Exception {
        client.mutate(PROJECT, command("CREATE", "src", "", new byte[0]));
        Request request = received.get();
        assertThat(request.method()).isEqualTo("POST");
        assertThat(request.uri().getPath()).isEqualTo("/agent/v1/entries");
        assertThat(new MappingJackson2HttpMessageConverter().canRead(JsonNode.class,
            MediaType.parseMediaType(request.contentType()))).isTrue();
        assertThat(JSON.readTree(request.body()).get("kind").asText()).isEqualTo("directory");
        assertSignatureMatchesTheActualRequest(request);
    }

    @Test
    void renameIncludesTheDestinationPathInItsJsonBody() throws Exception {
        client.mutate(PROJECT, command("RENAME", "src/old.txt", "src/new name.txt", new byte[0]));
        Request request = received.get();
        assertThat(request.uri().getPath()).isEqualTo("/agent/v1/entries/rename");
        assertThat(JSON.readTree(request.body()).path("nextPath").asText()).isEqualTo("src/new name.txt");
        assertThat(request.contentType()).isEqualTo("application/json");
        assertSignatureMatchesTheActualRequest(request);
    }

    @Test
    void deleteUsesTheEntriesEndpointWithSignedEncodedQueryParameters() throws Exception {
        assertThatCode(() -> client.mutate(PROJECT, command("DELETE", "src/中文 + &.txt", "", new byte[0])))
            .doesNotThrowAnyException();
        Request request = received.get();
        assertThat(request.method()).isEqualTo("DELETE");
        assertThat(request.uri().getPath()).isEqualTo("/agent/v1/entries");
        assertThat(query(request)).containsEntry("path", "src/中文 + &.txt").containsEntry("operationId", OPERATION);
        assertSignatureMatchesTheActualRequest(request);
    }

    @Test
    void receiptUsesTheDigestOfTheStoredReceiptNotTheResponseEnvelope() {
        String persistedDigest = "a".repeat(64);
        responseBody = "{\"operationId\":\"" + OPERATION + "\",\"type\":\"CREATE\",\"path\":\"src\","
            + "\"nextPath\":\"\",\"beforeSha256\":\"before\",\"afterSha256\":\"after\","
            + "\"receiptSha256\":\"" + persistedDigest + "\"}";
        assertThat(client.receipt(PROJECT, OPERATION).orElseThrow().receiptSha256()).isEqualTo(persistedDigest);
    }

    @Test
    void saveKeepsTheExactUtf8BytesAndSignsTheEncodedQuery() throws Exception {
        byte[] content = "class 示例 { }\n".getBytes(StandardCharsets.UTF_8);
        client.mutate(PROJECT, command("SAVE", "src/中文 + &.java", "", content));
        Request request = received.get();
        assertThat(request.method()).isEqualTo("PUT");
        assertThat(request.uri().getPath()).isEqualTo("/agent/v1/content");
        assertThat(request.contentType()).isEqualTo("application/octet-stream");
        assertThat(request.body()).isEqualTo(content);
        assertThat(query(request)).containsEntry("path", "src/中文 + &.java");
        assertSignatureMatchesTheActualRequest(request);
    }

    private WorkspaceAgent.Command command(String type, String path, String nextPath, byte[] content) {
        return new WorkspaceAgent.Command(type, path, nextPath, "directory", OPERATION, content,
            "before", "after", "{\"operationId\":\"" + OPERATION + "\"}", "receipt");
    }

    private Map<String, String> query(Request request) {
        return Arrays.stream(request.uri().getRawQuery().split("&"))
            .map(part -> part.split("=", 2)).collect(Collectors.toMap(pair -> pair[0],
                pair -> URLDecoder.decode(pair[1], StandardCharsets.UTF_8)));
    }

    private void assertSignatureMatchesTheActualRequest(Request request) throws Exception {
        String[] parts = request.capability().split("\\.");
        String canonical = String.join("\n", "v1", request.method(), request.uri().toASCIIString(),
            WorkspaceCapabilitySigner.sha256Hex(request.body()), PROJECT, parts[2], parts[3]);
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(keyPair.getPublic());
        verifier.update(canonical.getBytes(StandardCharsets.UTF_8));
        assertThat(verifier.verify(Base64.getUrlDecoder().decode(parts[4]))).isTrue();
    }

    private record Request(String method, URI uri, String contentType, String capability, byte[] body) { }
}
