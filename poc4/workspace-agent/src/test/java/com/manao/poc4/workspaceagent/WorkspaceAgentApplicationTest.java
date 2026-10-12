package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

class WorkspaceAgentApplicationTest {
    private static final String PROJECT_ID = "prj-startup";

    @TempDir Path root;

    @Test
    void productionEntrypointStartsAndServesHealthOnAnEphemeralLoopbackPort() throws Exception {
        String publicKey = rawPublicKey();
        try (var context = SpringApplication.run(WorkspaceAgentApplication.class,
            "--server.address=127.0.0.1", "--server.port=0", "--manao.agent.root=" + root,
            "--MANAO_AGENT_PROJECT_ID=" + PROJECT_ID, "--MANAO_AGENT_CAPABILITY_PUBLIC_KEY=" + publicKey)) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            var response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/agent/v1/healthz")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body()).isEqualTo("{\"status\":\"UP\"}");
        }
    }

    /**
     * The Python dependency endpoints are ordinary capability-signed agent endpoints: unsigned
     * requests are rejected by the same filter, malformed changes fail validation, and a commit
     * without a prepared journal fails closed — the dependency editor introduces no second
     * authentication path.
     */
    @Test
    void pythonDependencyEndpointsGoThroughTheSameCapabilityAndValidationRules() throws Exception {
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String publicKey = Base64.getEncoder().encodeToString(Arrays.copyOfRange(
            pair.getPublic().getEncoded(), pair.getPublic().getEncoded().length - 32, pair.getPublic().getEncoded().length));
        try (var context = SpringApplication.run(WorkspaceAgentApplication.class,
            "--server.address=127.0.0.1", "--server.port=0", "--manao.agent.root=" + root,
            "--MANAO_AGENT_PROJECT_ID=" + PROJECT_ID, "--MANAO_AGENT_CAPABILITY_PUBLIC_KEY=" + publicKey)) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            HttpClient client = HttpClient.newHttpClient();
            String operationId = "33333333-3333-4333-8333-333333333333";
            String requestSha = "a".repeat(64);
            String body = "{\"operationId\":\"" + operationId + "\",\"requestSha256\":\"" + requestSha
                + "\",\"change\":{\"action\":\"ADD\",\"packageName\":\"httpx\",\"version\":\"0.28.1\"}}";
            String commitBody = "{\"prepared\":{\"operationId\":\"" + operationId
                + "\",\"requestSha256\":\"" + requestSha + "\",\"beforeSha256\":\"" + "b".repeat(64)
                + "\",\"afterSha256\":\"" + "c".repeat(64)
                + "\"},\"receiptJson\":\"{}\",\"receiptSha256\":\"" + "d".repeat(64) + "\"}";

            HttpResponse<String> unsigned = client.send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/agent/v1/python-dependencies/prepare"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
            assertThat(unsigned.statusCode()).isEqualTo(401);
            assertThat(unsigned.body()).contains("CAPABILITY_REJECTED");

            HttpResponse<String> invalidPackage = client.send(signedPost(pair, port,
                "/agent/v1/python-dependencies/prepare", body), HttpResponse.BodyHandlers.ofString());
            assertThat(invalidPackage.statusCode()).isEqualTo(422);
            assertThat(invalidPackage.body()).contains("VALIDATION_ERROR");

            HttpResponse<String> commitWithoutJournal = client.send(signedPost(pair, port,
                "/agent/v1/python-dependencies/commit", commitBody), HttpResponse.BodyHandlers.ofString());
            assertThat(commitWithoutJournal.statusCode()).isEqualTo(409);
            assertThat(commitWithoutJournal.body()).contains("OPERATION_CONFLICT");

            // No journal content, no receipt, no file writes: the empty workspace proves both
            // rejections were side-effect free. (The empty per-operation lock file from
            // acquiring the serialization lock is bookkeeping, not operation state.)
            assertThat(Files.exists(root.resolve(
                ".manao/python-dependencies/" + operationId + "/manifest.json"))).isFalse();
            assertThat(Files.exists(root.resolve(".manao/receipts"))).isFalse();
        }
    }

    private static String rawPublicKey() throws Exception {
        byte[] encoded = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded();
        return Base64.getEncoder().encodeToString(Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length));
    }

    private HttpRequest signedPost(KeyPair pair, int port, String pathAndQuery, String body) throws Exception {
        long issuedAt = System.currentTimeMillis();
        String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce16());
        String canonical = "v1\nPOST\n" + pathAndQuery + "\n" + sha256Hex(body.getBytes(StandardCharsets.UTF_8))
            + "\n" + PROJECT_ID + "\n" + issuedAt + "\n" + nonce;
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(pair.getPrivate());
        signature.update(canonical.getBytes(StandardCharsets.UTF_8));
        String signed = Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign());
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + pathAndQuery))
            .header("Content-Type", "application/json")
            .header("X-Manao-Workspace-Capability", "v1." + PROJECT_ID + "." + issuedAt + "." + nonce + "." + signed)
            .POST(HttpRequest.BodyPublishers.ofString(body)).build();
    }

    private static byte[] nonce16() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        return bytes;
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
