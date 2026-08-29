package com.manao.poc4.terminal;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.log.LogTicketService;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunSummary;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketExtension;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

class TerminalWebSocketTest {
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final String SESSION = "sess-1";
    private static final ObjectMapper JSON = new ObjectMapper();

    private StubBridge bridge;
    private CapturingSession session;

    @BeforeEach
    void setUp() throws Exception {
        bridge = new StubBridge();
        session = new CapturingSession();
    }

    private TerminalWebSocketHandler newHandler(String ticketState) throws Exception {
        return newHandler(ticketState, session);
    }

    private TerminalWebSocketHandler newHandler(String ticketState, CapturingSession target) throws Exception {
        TerminalWebSocketHandler handler = new TerminalWebSocketHandler(
            new StubTickets(ticketState), bridge, runId -> summary(RunState.RUNNING, runId),
            new StubClock(), 80, 24);
        handler.afterConnectionEstablished(target);
        return handler;
    }

    private RunSummary summary(RunState state, String runId) {
        return new RunSummary(runId, state.name(), "5", JSON.createObjectNode(),
            "2026-08-29T11:00:00Z", Instant.now().toString(), null, null, null, false, 0, null);
    }

    @Test
    void handshakeConsumesTicketOpensPtyAndSendsReady() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        assertThat(bridge.opened).isTrue();
        assertThat(bridge.podName).isEqualTo("manao-run-" + RUN);
        assertThat(bridge.containerName).isEqualTo("maven");
        JsonNode ready = JSON.readTree(session.text.get(0));
        assertThat(ready.get("type").asText()).isEqualTo("terminal.ready");
        assertThat(ready.get("sessionId").asText()).isEqualTo(SESSION);
    }

    @Test
    void invalidTicketsCloseWith4410WithoutOpeningPty() throws Exception {
        for (String bad : List.of("expired-ticket", "reused-ticket")) {
            CapturingSession badSession = new CapturingSession();
            badSession.setUri("/api/v1/ws/terminals?ticket=" + bad);
            TerminalWebSocketHandler handler = new TerminalWebSocketHandler(new StubTickets(bad), bridge,
                runId -> summary(RunState.RUNNING, runId), new StubClock(), 80, 24);
            handler.afterConnectionEstablished(badSession);
            assertThat(badSession.closed.getCode()).isEqualTo(4410);
        }
        assertThat(bridge.opened).isFalse();
        CapturingSession noTicket = new CapturingSession();
        noTicket.setUri("/api/v1/ws/terminals");
        TerminalWebSocketHandler handler = new TerminalWebSocketHandler(new StubTickets("valid-ticket"), bridge,
            runId -> summary(RunState.RUNNING, runId), new StubClock(), 80, 24);
        handler.afterConnectionEstablished(noTicket);
        assertThat(noTicket.closed.getCode()).isEqualTo(4410);
    }

    @Test
    void binaryOutputIsConservedAndCreditIsEnforced() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        // PTY pushes 300 KiB; only 256 KiB (credit) flows, in <= 32 KiB frames.
        bridge.listener.onOutput(new byte[300 * 1024]);
        assertThat(session.binary).isNotEmpty();
        int totalBytes = 0;
        for (byte[] frame : session.binary) {
            assertThat(frame.length).isLessThanOrEqualTo(32 * 1024);
            totalBytes += frame.length;
        }
        long expected = Math.min(300 * 1024L, TerminalWebSocketHandler.INITIAL_CREDIT_BYTES);
        assertThat(totalBytes).isEqualTo((int) expected);
    }

    @Test
    void ackReturnsCreditAndOverAckCloses4409() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        bridge.listener.onOutput(new byte[32 * 1024]);
        int afterOutput = session.binary.size();
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.output.ack\",\"bytes\":16384}"));
        assertThat(session.closed).isNull();
        // Acknowledging more than outstanding violates the contract and closes 4409.
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.output.ack\",\"bytes\":99999999}"));
        assertThat(session.closed.getCode()).isEqualTo(4409);
    }

    @Test
    void resizeGenerationIsMonotonicAndDimensionsAreValidated() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.resize\",\"cols\":100,\"rows\":30}"));
        assertThat(bridge.resizes).containsExactly("100x30");
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.resize\",\"cols\":100,\"rows\":30}"));
        assertThat(bridge.resizes).hasSize(1);
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.resize\",\"cols\":501,\"rows\":30}"));
        assertThat(bridge.resizes).hasSize(1);
        assertThat(session.closed).isNull();
    }

    @Test
    void oversizedInputFrameFailsClosedWith4410() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        handler.handleMessage(session, new BinaryMessage(new byte[16 * 1024 + 1]));
        assertThat(session.closed.getCode()).isEqualTo(4410);
        assertThat(bridge.closed).isTrue();
    }

    @Test
    void fullInputQueuePausesReadingAndBackpressuresTheClient() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        byte[] maxFrame = new byte[16 * 1024];
        for (int i = 0; i < 4; i++) {
            handler.handleMessage(session, new BinaryMessage(maxFrame));
        }
        JsonNode pause = JSON.readTree(session.text.get(session.text.size() - 1));
        assertThat(pause.get("type").asText()).isEqualTo("terminal.input.pause");
        assertThat(session.closed).isNull();
        int before = session.text.size();
        handler.handleMessage(session, new BinaryMessage(maxFrame));
        assertThat(session.text.size()).isEqualTo(before);
    }

    @Test
    void closeFrameAndPtyExitSettleTheSession() throws Exception {
        TerminalWebSocketHandler handler = newHandler("valid-ticket");
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.close\"}"));
        assertThat(bridge.closed).isTrue();
        assertThat(session.closed).isNotNull();
        JsonNode exit = JSON.readTree(session.text.get(session.text.size() - 1));
        assertThat(exit.get("type").asText()).isEqualTo("terminal.exit");
        assertThat(exit.get("reason").asText()).isEqualTo("CLIENT_CLOSED");

        // PTY exit pushes terminal.exit with the shell's exit code.
        CapturingSession second = new CapturingSession();
        newHandler("valid-ticket", second);
        bridge.listener.onExit(0);
        JsonNode shellExit = JSON.readTree(second.text.get(second.text.size() - 1));
        assertThat(shellExit.get("type").asText()).isEqualTo("terminal.exit");
        assertThat(shellExit.get("exitCode").asInt()).isZero();
        assertThat(shellExit.get("reason").asText()).isEqualTo("SHELL_EXITED");
    }

    static final class StubClock extends java.time.Clock {
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.parse("2026-08-29T12:00:00Z"); }
    }

    static final class StubTickets implements TerminalTicketService {
        private final String accepted;
        StubTickets(String accepted) { this.accepted = accepted; }
        @Override public Optional<TerminalStore.SessionRecord> consume(String ticket) {
            if ("valid-ticket".equals(ticket)) {
                return Optional.of(new TerminalStore.SessionRecord(SESSION, PROJECT, RUN, "user",
                    TerminalTicketService.sha256Hex(ticket), Instant.parse("2026-08-29T12:00:30Z"), null,
                    "RESERVED", null, null, null));
            }
            return Optional.empty();
        }
    }

    static final class StubBridge implements PtyBridge {
        boolean opened;
        boolean closed;
        String podName;
        String containerName;
        PtyBridge.PtyListener listener;
        final List<String> resizes = new ArrayList<>();

        @Override public PtyHandle open(String runId, int cols, int rows, PtyListener listener) {
            this.opened = true;
            this.podName = "manao-run-" + runId;
            this.containerName = "maven";
            this.listener = listener;
            return new PtyHandle() {
                @Override public boolean write(byte[] bytes) { return false; }
                @Override public void resize(int cols, int rows) { resizes.add(cols + "x" + rows); }
                @Override public void close() { closed = true; }
            };
        }
    }

    static final class CapturingSession implements WebSocketSession {
        final List<String> text = new ArrayList<>();
        final List<byte[]> binary = new ArrayList<>();
        CloseStatus closed;
        String uri = "/api/v1/ws/terminals?ticket=valid-ticket";
        private final Map<String, Object> attributes = new ConcurrentHashMap<>();

        void setUri(String uri) { this.uri = uri; }
        private final String id = "session-" + System.nanoTime();
        @Override public String getId() { return id; }
        @Override public URI getUri() { return URI.create(uri); }
        @Override public HttpHeaders getHandshakeHeaders() { return new HttpHeaders(); }
        @Override public Principal getPrincipal() { return null; }
        @Override public String getAcceptedProtocol() { return ""; }
        @Override public List<WebSocketExtension> getExtensions() { return List.of(); }
        @Override public int getTextMessageSizeLimit() { return 512 * 1024; }
        @Override public void setTextMessageSizeLimit(int size) { }
        @Override public int getBinaryMessageSizeLimit() { return 512 * 1024; }
        @Override public java.net.InetSocketAddress getRemoteAddress() { return null; }
        @Override public java.net.InetSocketAddress getLocalAddress() { return null; }
        @Override public void setBinaryMessageSizeLimit(int size) { }
        @Override public Map<String, Object> getAttributes() { return attributes; }
        @Override public boolean isOpen() { return closed == null; }
        @Override public void sendMessage(WebSocketMessage<?> message) throws IOException {
            if (message instanceof TextMessage textMessage) text.add(textMessage.getPayload());
            if (message instanceof BinaryMessage binaryMessage) binary.add(binaryMessage.getPayload().array());
        }
        @Override public void close() { closed = CloseStatus.NORMAL; }
        @Override public void close(CloseStatus status) { closed = status; }
    }
}
