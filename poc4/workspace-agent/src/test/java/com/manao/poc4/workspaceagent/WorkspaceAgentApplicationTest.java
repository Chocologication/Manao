package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

class WorkspaceAgentApplicationTest {
    @TempDir Path root;

    @Test
    void productionEntrypointStartsAndServesHealthOnAnEphemeralLoopbackPort() throws Exception {
        byte[] encoded = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded();
        String publicKey = Base64.getEncoder().encodeToString(Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length));
        try (var context = SpringApplication.run(WorkspaceAgentApplication.class,
            "--server.address=127.0.0.1", "--server.port=0", "--manao.agent.root=" + root,
            "--MANAO_AGENT_PROJECT_ID=prj-startup", "--MANAO_AGENT_CAPABILITY_PUBLIC_KEY=" + publicKey)) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            var response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/agent/v1/healthz")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body()).isEqualTo("{\"status\":\"UP\"}");
        }
    }
}
