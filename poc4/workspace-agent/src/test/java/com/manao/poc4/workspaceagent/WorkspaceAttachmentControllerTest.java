package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

class WorkspaceAttachmentControllerTest {
    @TempDir Path root;

    @Test void signedTenMillionByteUploadIsConfirmedAndExpiredWritesCannotResurrectDeletedFile() throws Exception {
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] key = pair.getPublic().getEncoded();
        String publicKey = Base64.getEncoder().encodeToString(Arrays.copyOfRange(key, key.length - 32, key.length));
        try (var context = SpringApplication.run(WorkspaceAgentApplication.class,
            "--server.address=127.0.0.1", "--server.port=0", "--manao.agent.root=" + root,
            "--MANAO_AGENT_PROJECT_ID=image-project", "--MANAO_AGENT_CAPABILITY_PUBLIC_KEY=" + publicKey)) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            String id = UUID.randomUUID().toString();
            byte[] bytes = new byte[10_000_000];
            bytes[0] = 12;
            String sha = sha(bytes);
            String path = "/agent/v1/attachments/" + id;
            String query = "?sha256=" + sha + "&expiresAt=" + Instant.now().plusSeconds(86400).toEpochMilli();
            var client = HttpClient.newHttpClient();
            assertThat(send(client, pair, port, "PUT", path + query, bytes).statusCode()).isEqualTo(200);
            assertThat(send(client, pair, port, "GET", path, new byte[0]).body()).contains(sha).contains("10000000");
            assertThat(send(client, pair, port, "PUT", path + query, bytes).statusCode()).isEqualTo(200);
            byte[] changed = {9};
            assertThat(send(client, pair, port, "PUT", path + "?sha256=" + sha(changed) + "&expiresAt=" + Instant.now().plusSeconds(86400).toEpochMilli(), changed).statusCode()).isEqualTo(409);
            assertThat(send(client, pair, port, "PUT", "/agent/v1/attachments/" + UUID.randomUUID() + query, new byte[10_000_001]).statusCode()).isEqualTo(413);
            assertThat(send(client, pair, port, "PUT", "/agent/v1/attachments;v=1/" + UUID.randomUUID() + query, new byte[10_000_001]).statusCode()).isEqualTo(413);
            assertThat(send(client, pair, port, "PUT", "/agent/v1/att%61chments/" + UUID.randomUUID() + query, new byte[10_000_001]).statusCode()).isEqualTo(413);
            assertThat(send(client, pair, port, "DELETE", path, new byte[0]).statusCode()).isEqualTo(200);
            assertThat(send(client, pair, port, "PUT", path + "?sha256=" + sha + "&expiresAt=1", bytes).statusCode()).isEqualTo(410);
            assertThat(Files.exists(root.resolve(".manao/attachments/" + id))).isFalse();
        }
    }

    private static HttpResponse<String> send(HttpClient client, KeyPair pair, int port, String method, String path, byte[] body) throws Exception {
        long now = System.currentTimeMillis();
        byte[] nonceBytes = new byte[16];
        new SecureRandom().nextBytes(nonceBytes);
        String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes);
        String canonical = "v1\n" + method + "\n" + path + "\n" + sha(body) + "\nimage-project\n" + now + "\n" + nonce;
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(pair.getPrivate());
        signature.update(canonical.getBytes(StandardCharsets.UTF_8));
        return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .header("X-Manao-Workspace-Capability", "v1.image-project." + now + "." + nonce + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign()))
            .header("Content-Type", "application/octet-stream")
            .method(method, body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
    private static String sha(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
}
