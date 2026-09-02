package com.manao.poc4.terminal;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunControllerTest.FakeRun;
import com.manao.poc4.run.RunControllerTest.FakeRunStore;
import com.manao.poc4.run.RunRecord;
import com.manao.poc4.run.RunSummary;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
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
    private static final String ALICE = "alice-id";
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");
    private static final ObjectMapper JSON = new ObjectMapper();

    private StubBridge bridge;
    private CapturingSession session;
    private TerminalSessionService sessionService;
    private TerminalSessionServiceTest.FakeTerminalStore store;
    private TerminalSessionServiceTest.MutableClock clock;
    private String liveTicket;

    @BeforeEach
    void setUp() {
        bridge = new StubBridge();
        session = new CapturingSession();
        store = new TerminalSessionServiceTest.FakeTerminalStore();
        clock = new TerminalSessionServiceTest.MutableClock();
        FakeRunStore runStore = new FakeRunStore();
        runStore.projects.put(PROJECT, "READY");
        runStore.projectOwners.put(PROJECT, ALICE);
        runStore.runs.put(RUN, new FakeRun(new RunRecord(RUN, PROJECT, 5, RunState.RUNNING,
            "{}", "manao-run-" + RUN, null, NOW, null, null, null, 1L, NOW.minus(Duration.ofMinutes(1)), 0L)));
        sessionService = new TerminalSessionService(store, runStore, clock);
        liveTicket = sessionService.reserve(100, 30, ALICE, PROJECT, RUN).ticket();
    }

    private RunSummary summary(RunState state, String runId) {
        return new RunSummary(runId, state.name(), "5", JSON.createObjectNode(),
            "2026-08-29T11:00:00Z", Instant.now().toString(), null, null, null, false, 0, null);
    }

    private static final String RESOLVED_POD = "manao-run-" + RUN + "-abcde";

    private TerminalWebSocketHandler newHandler(CapturingSession target, String ticket) throws Exception {
        TerminalWebSocketHandler handler = new TerminalWebSocketHandler(sessionService, bridge,
            runId -> summary(RunState.RUNNING, runId), clock,
            runId -> Optional.of(new com.manao.poc4.kubernetes.JobCoordinator.LivePod(RESOLVED_POD, "maven")));
        target.bind(handler);
        target.setUri("/api/v1/ws/terminals?ticket=" + ticket);
        handler.afterConnectionEstablished(target);
        return handler;
    }

    @Test
    void handshakeConsumesTicketOpensPtyWithReservedDimensionsAndSendsReady() throws Exception {
        newHandler(session, liveTicket);
        assertThat(bridge.opened).isTrue();
        assertThat(bridge.podName).isEqualTo(RESOLVED_POD);
        assertThat(bridge.containerName).isEqualTo("maven");
        assertThat(bridge.cols).isEqualTo(100);
        assertThat(bridge.rows).isEqualTo(30);
        JsonNode ready = JSON.readTree(session.text.get(0));
        assertThat(ready.get("type").asText()).isEqualTo("terminal.ready");
        assertThat(ready.get("sessionId").asText()).isNotBlank();
    }

    @Test
    void reusedAndMissingTicketsCloseWith4410WithoutOpeningPty() throws Exception {
        newHandler(session, liveTicket);
        assertThat(bridge.opened).isTrue();

        CapturingSession reused = new CapturingSession();
        newHandler(reused, liveTicket);
        assertThat(reused.closed.getCode()).isEqualTo(4410);

        CapturingSession missing = new CapturingSession();
        TerminalWebSocketHandler handler = new TerminalWebSocketHandler(sessionService, bridge,
            runId -> summary(RunState.RUNNING, runId), clock,
            runId -> Optional.of(new com.manao.poc4.kubernetes.JobCoordinator.LivePod(RESOLVED_POD, "maven")));
        missing.bind(handler);
        missing.setUri("/api/v1/ws/terminals");
        handler.afterConnectionEstablished(missing);
        assertThat(missing.closed.getCode()).isEqualTo(4410);
    }

    @Test
    void binaryOutputIsConservedAndCreditIsEnforced() throws Exception {
        newHandler(session, liveTicket);
        bridge.listener.onOutput(new byte[300 * 1024]);
        assertThat(session.binary).isNotEmpty();
        int totalBytes = 0;
        for (byte[] frame : session.binary) {
            assertThat(frame.length).isLessThanOrEqualTo(32 * 1024);
            totalBytes += frame.length;
        }
        assertThat(totalBytes).isEqualTo((int) TerminalWebSocketHandler.INITIAL_CREDIT_BYTES);
    }

    @Test
    void ackReturnsCreditAndOverAckCloses4409() throws Exception {
        newHandler(session, liveTicket);
        bridge.listener.onOutput(new byte[32 * 1024]);
        session.handleText("{\"type\":\"terminal.output.ack\",\"bytes\":16384}");
        assertThat(session.closed).isNull();
        session.handleText("{\"type\":\"terminal.output.ack\",\"bytes\":99999999}");
        assertThat(session.closed.getCode()).isEqualTo(4409);
    }

    @Test
    void resizeGenerationIsMonotonicAndDimensionsAreValidated() throws Exception {
        newHandler(session, liveTicket);
        session.handleText("{\"type\":\"terminal.resize\",\"cols\":100,\"rows\":30}");
        assertThat(bridge.resizes).containsExactly("100x30");
        session.handleText("{\"type\":\"terminal.resize\",\"cols\":100,\"rows\":30}");
        assertThat(bridge.resizes).hasSize(1);
        session.handleText("{\"type\":\"terminal.resize\",\"cols\":501,\"rows\":30}");
        assertThat(bridge.resizes).hasSize(1);
        assertThat(session.closed).isNull();
    }

    @Test
    void inputIsWrittenToThePtyAndOversizedFramesFailClosed() throws Exception {
        newHandler(session, liveTicket);
        session.handleBinary(new BinaryMessage("ls\n".getBytes(StandardCharsets.UTF_8)));
        assertThat(bridge.written).containsExactly("ls\n".getBytes(StandardCharsets.UTF_8));

        session.handleBinary(new BinaryMessage(new byte[16 * 1024 + 1]));
        assertThat(session.closed.getCode()).isEqualTo(4410);
        assertThat(bridge.closed).isTrue();
        assertThat(store.sessions.values().stream()
            .filter(record -> "FAILED".equals(record.state())).count()).isEqualTo(1);
    }

    @Test
    void fullInputQueuePausesReadingAndBackpressuresTheClient() throws Exception {
        newHandler(session, liveTicket);
        bridge.acceptWrites = false; // simulate a backpressured PTY stdin
        byte[] maxFrame = new byte[16 * 1024];
        for (int i = 0; i < 4; i++) {
            session.handleBinary(new BinaryMessage(maxFrame));
        }
        JsonNode pause = JSON.readTree(session.text.get(session.text.size() - 1));
        assertThat(pause.get("type").asText()).isEqualTo("terminal.input.pause");
        assertThat(session.closed).isNull();
        int before = session.text.size();
        session.handleBinary(new BinaryMessage(maxFrame));
        assertThat(session.text.size()).isEqualTo(before);
    }

    @Test
    void queueDeadlineExceededFailsClosedAndSettles() throws Exception {
        newHandler(session, liveTicket);
        bridge.acceptWrites = false;
        byte[] maxFrame = new byte[16 * 1024];
        for (int i = 0; i < 4; i++) {
            session.handleBinary(new BinaryMessage(maxFrame));
        }
        clock.advance(Duration.ofSeconds(6));
        session.handleBinary(new BinaryMessage(new byte[16 * 1024]));
        session.handleBinary(new BinaryMessage(new byte[1]));
        assertThat(session.closed.getCode()).isEqualTo(4410);
        assertThat(store.sessions.values().stream()
            .anyMatch(record -> "FAILED".equals(record.state()))).isTrue();
    }

    @Test
    void closeFrameAndPtyExitSettleTheSession() throws Exception {
        newHandler(session, liveTicket);
        session.handleText("{\"type\":\"terminal.close\"}");
        assertThat(bridge.closed).isTrue();
        assertThat(session.closed).isNotNull();
        JsonNode exit = JSON.readTree(session.text.get(session.text.size() - 1));
        assertThat(exit.get("type").asText()).isEqualTo("terminal.exit");
        assertThat(exit.get("reason").asText()).isEqualTo("CLIENT_CLOSED");
        assertThat(store.sessions.values().stream()
            .anyMatch(record -> "CLOSED".equals(record.state())
                && "CLIENT_CLOSED".equals(record.closeReason()))).isTrue();

        // PTY exit settles CLOSED with the shell's exit code on a fresh reservation.
        CapturingSession second = new CapturingSession();
        String secondTicket = sessionService.reserve(80, 24, ALICE, PROJECT, RUN).ticket();
        TerminalWebSocketHandler secondHandler = new TerminalWebSocketHandler(sessionService, bridge,
            runId -> summary(RunState.RUNNING, runId), clock,
            runId -> Optional.of(new com.manao.poc4.kubernetes.JobCoordinator.LivePod(RESOLVED_POD, "maven")));
        second.bind(secondHandler);
        second.setUri("/api/v1/ws/terminals?ticket=" + secondTicket);
        secondHandler.afterConnectionEstablished(second);
        bridge.listener.onExit(0);
        JsonNode shellExit = JSON.readTree(second.text.get(second.text.size() - 1));
        assertThat(shellExit.get("type").asText()).isEqualTo("terminal.exit");
        assertThat(shellExit.get("exitCode").asInt()).isZero();
        assertThat(shellExit.get("reason").asText()).isEqualTo("SHELL_EXITED");
        assertThat(store.sessions.values().stream()
            .anyMatch(record -> "CLOSED".equals(record.state())
                && "SHELL_EXITED".equals(record.closeReason()))).isTrue();
    }

    @Test
    void refusesHandshakeWhenNoLivePodIsVerified() throws Exception {
        TerminalWebSocketHandler handler = new TerminalWebSocketHandler(sessionService, bridge,
            runId -> summary(RunState.RUNNING, runId), clock, runId -> Optional.empty());
        session.bind(handler);
        session.setUri("/api/v1/ws/terminals?ticket=" + liveTicket);
        handler.afterConnectionEstablished(session);
        assertThat(session.closed.getCode()).isEqualTo(4410);
        assertThat(bridge.opened).isFalse();
    }

    @Test
    void persistsPodAndContainerRefsAfterOpen() throws Exception {
        newHandler(session, liveTicket);
        assertThat(store.liveRefs).hasSize(1);
        String[] refs = store.liveRefs.values().iterator().next();
        assertThat(refs[0]).isEqualTo(RESOLVED_POD);
        assertThat(refs[1]).isEqualTo("maven");
    }

    @Test
    void teardownAllSessionsSettlesActivePtyAndNeverReattaches() throws Exception {
        TerminalWebSocketHandler handler = newHandler(session, liveTicket);
        assertThat(bridge.opened).isTrue();

        handler.teardownAllSessions();

        assertThat(store.sessions.values().stream()
            .anyMatch(record -> "INTERRUPTED".equals(record.state()))).isTrue();
        assertThat(bridge.closed).isTrue();
        // The exit frame reason must stay inside the stage-five TerminalExitReason contract.
        com.fasterxml.jackson.databind.JsonNode exit = JSON.readTree(session.text.get(session.text.size() - 1));
        assertThat(exit.get("type").asText()).isEqualTo("terminal.exit");
        assertThat(java.util.List.of("SHELL_EXITED", "RUN_LEFT_RUNNING", "CLIENT_CLOSED", "CONNECTION_LOST", "BACKEND_ERROR"))
            .contains(exit.get("reason").asText());
        handler.teardownAllSessions(); // idempotent second sweep
        assertThat(store.sessions.values().stream()
            .filter(record -> "INTERRUPTED".equals(record.state())).count()).isEqualTo(1);
    }

    @Test
    void connectionLostSettlesInterrupted() throws Exception {
        newHandler(session, liveTicket);
        session.closed = CloseStatus.GOING_AWAY;
        session.containerCallback();
        assertThat(store.sessions.values().stream()
            .anyMatch(record -> "INTERRUPTED".equals(record.state()))).isTrue();
    }


    static final class StubBridge implements PtyBridge {
        boolean acceptWrites = true;
        boolean opened;
        boolean closed;
        String podName;
        String containerName;
        int cols;
        int rows;
        PtyBridge.PtyListener listener;
        final List<String> resizes = new ArrayList<>();
        final List<byte[]> written = new ArrayList<>();

        @Override public PtyHandle open(String openPodName, String openContainerName, int openCols, int openRows, PtyListener listener) {
            this.opened = true;
            this.podName = openPodName;
            this.containerName = openContainerName;
            this.cols = openCols;
            this.rows = openRows;
            this.listener = listener;
            return new PtyHandle() {
                @Override public boolean write(byte[] bytes) {
                    if (!acceptWrites) return false;
                    written.add(bytes);
                    return true;
                }
                @Override public void resize(int resizeCols, int resizeRows) { resizes.add(resizeCols + "x" + resizeRows); }
                @Override public void close() { closed = true; }
            };
        }
    }

    static final class CapturingSession implements WebSocketSession {
        final List<String> text = new ArrayList<>();
        final List<byte[]> binary = new ArrayList<>();
        CloseStatus closed;
        String uri = "/api/v1/ws/terminals?ticket=skip";
        private final String id = "session-" + System.nanoTime();
        private final Map<String, Object> attributes = new ConcurrentHashMap<>();
        private TerminalWebSocketHandler boundHandler;

        void bind(TerminalWebSocketHandler handler) { this.boundHandler = handler; }

        void handleText(String payload) throws Exception {
            if (boundHandler != null) boundHandler.handleMessage(this, new TextMessage(payload));
        }

        void handleBinary(BinaryMessage message) throws Exception {
            if (boundHandler != null) boundHandler.handleMessage(this, message);
        }

        /** Simulates the container invoking afterConnectionClosed for this session. */
        void containerCallback() {
            if (boundHandler != null) {
                boundHandler.afterConnectionClosed(this, closed == null ? CloseStatus.NORMAL : closed);
            }
        }

        void setUri(String uri) { this.uri = uri; }
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
