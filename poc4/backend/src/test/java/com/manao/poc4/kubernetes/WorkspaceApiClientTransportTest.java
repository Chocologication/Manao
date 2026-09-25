package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceAgentException;
import com.manao.poc4.workspace.WorkspaceCapabilitySigner;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.EdECPrivateKey;
import java.time.Clock;
import java.time.Duration;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class WorkspaceApiClientTransportTest {
    private static final String PROJECT = "prj-transport";
    private static final String OPERATION = "00000000-0000-4000-8000-000000000001";

    @Test
    void classifiesAnUnavailableLoopbackListenerAsConnect() throws Exception {
        int port;
        try (ServerSocket reserved = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            port = reserved.getLocalPort();
        }

        WorkspaceAgentException error = assertTransportFailure(
            newClient("http://127.0.0.1:" + port, Duration.ofSeconds(1)));

        assertThat(error.transportFailure()).isEqualTo(WorkspaceAgentException.TransportFailure.CONNECT);
    }

    @Test
    void classifiesAConnectedServerThatDoesNotRespondAsTimeout() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> {
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            WorkspaceAgentException error = assertTransportFailure(newClient(
                "http://127.0.0.1:" + server.getAddress().getPort(), Duration.ofMillis(100)));

            assertThat(error.transportFailure()).isEqualTo(WorkspaceAgentException.TransportFailure.TIMEOUT);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void classifiesAConnectionClosedWithResetAsReset() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Thread resetter = new Thread(() -> closeAcceptedConnectionWithReset(server), "workspace-reset-test");
            resetter.start();
            WorkspaceAgentException error = assertTransportFailure(newClient(
                "http://127.0.0.1:" + server.getLocalPort(), Duration.ofSeconds(1)));
            resetter.join(2_000);

            assertThat(error.transportFailure()).isEqualTo(WorkspaceAgentException.TransportFailure.RESET);
        }
    }

    @Test
    void classifiesAPlainConnectionResetByPeerIoExceptionAsReset() {
        assertThat(WorkspaceApiClient.classifyTransportFailure(new IOException("Connection reset by peer")))
            .isEqualTo(WorkspaceAgentException.TransportFailure.RESET);
    }

    @Test
    void classifiesAWrappedConnectionResetByPeerCauseAsReset() {
        IOException failure = new IOException("HTTP/1.1 header parser received no bytes",
            new IOException("Connection reset by peer"));

        assertThat(WorkspaceApiClient.classifyTransportFailure(failure))
            .isEqualTo(WorkspaceAgentException.TransportFailure.RESET);
    }

    @Test
    void keepsAnIoExceptionWithoutAnExplicitResetSignalAsOther() {
        IOException failure = new IOException("HTTP/1.1 header parser received no bytes",
            new IOException("broken pipe"));

        assertThat(WorkspaceApiClient.classifyTransportFailure(failure))
            .isEqualTo(WorkspaceAgentException.TransportFailure.OTHER);
    }

    @Test
    void classifiesAnInterruptedRequestAndRestoresTheInterruptFlag() {
        WorkspaceApiClient client = newClient("http://127.0.0.1:1", Duration.ofSeconds(1));
        Thread.currentThread().interrupt();
        try {
            assertThatThrownBy(() -> client.mutate(PROJECT, command()))
                .isInstanceOfSatisfying(WorkspaceAgentException.class, error -> {
                    assertThat(error.status()).isEqualTo(503);
                    assertThat(error.code()).isEqualTo("IO_ERROR");
                    assertThat(error.transportFailure())
                        .isEqualTo(WorkspaceAgentException.TransportFailure.INTERRUPTED);
                });
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @ParameterizedTest
    @MethodSource("httpResponses")
    void keepsHttpErrorsSeparateFromTransportFailures(int status, String code) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> {
            byte[] body = ("{\"code\":\"" + code + "\",\"message\":\"safe\"}")
                .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            try (var output = exchange.getResponseBody()) {
                output.write(body);
            }
        });
        server.start();
        try {
            assertThatThrownBy(() -> newClient("http://127.0.0.1:" + server.getAddress().getPort(), Duration.ofSeconds(1))
                .mutate(PROJECT, command()))
                .isInstanceOfSatisfying(WorkspaceAgentException.class, error -> {
                    assertThat(error.status()).isEqualTo(status);
                    assertThat(error.code()).isEqualTo(code);
                    assertThat(error.transportFailure()).isNull();
                });
        } finally {
            server.stop(0);
        }
    }

    static Stream<Arguments> httpResponses() {
        return Stream.of(
            Arguments.of(401, "CAPABILITY_REJECTED"),
            Arguments.of(409, "OPERATION_CONFLICT"),
            Arguments.of(503, "IO_ERROR"));
    }

    private WorkspaceAgentException assertTransportFailure(WorkspaceApiClient client) {
        try {
            client.mutate(PROJECT, command());
            throw new AssertionError("expected a workspace transport failure");
        } catch (WorkspaceAgentException error) {
            assertThat(error.status()).isEqualTo(503);
            assertThat(error.code()).isEqualTo("IO_ERROR");
            return error;
        }
    }

    private WorkspaceApiClient newClient(String endpoint, Duration timeout) {
        try {
            KeyPair keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            return new WorkspaceApiClient(ignored -> URI.create(endpoint), new WorkspaceCapabilitySigner(
                ((EdECPrivateKey) keyPair.getPrivate()).getBytes().orElseThrow(), Clock.systemUTC()), timeout);
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private WorkspaceAgent.Command command() {
        return new WorkspaceAgent.Command("CREATE", "src", "", "directory", OPERATION, new byte[0],
            "before", "after", "{\"operationId\":\"" + OPERATION + "\"}", "receipt");
    }

    private void closeAcceptedConnectionWithReset(ServerSocket server) {
        try (Socket socket = server.accept()) {
            socket.setSoLinger(true, 0);
        } catch (IOException ignored) {
            // The client may close the socket before the reset test server accepts it.
        }
    }

}