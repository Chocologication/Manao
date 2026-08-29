package com.manao.poc4.log;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunSummary;
import java.net.URI;
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
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketExtension;
import org.springframework.web.socket.WebSocketSession;


class RunLogWebSocketTest {
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final Instant NOW = Instant.parse("2026-08-29T11:00:00Z");
    private static final ObjectMapper JSON = new ObjectMapper();

    private RunLogWebSocketHandler handler;
    private CapturingSession session;
    private RunLogService logService;
    private RunLogWindow window;

    @BeforeEach
    void setUp() throws Exception {
        RunLogService.ChunkStore chunks = new RunLogService.ChunkStore() {
            final Map<String, List<RunLogWindow.Chunk>> stored = new HashMap<>();
            @Override public void insertChunk(String runId, RunLogWindow.Chunk chunk) {
                stored.computeIfAbsent(runId, id -> new ArrayList<>()).add(chunk);
            }
            @Override public List<RunLogWindow.Chunk> loadChunks(String runId) {
                return List.copyOf(stored.getOrDefault(runId, List.of()));
            }
            @Override public void deleteBefore(String runId, long seqExclusive) {
                stored.getOrDefault(runId, List.of()).removeIf(chunk -> chunk.seq() < seqExclusive);
            }
            @Override public java.util.OptionalLong lastSeq(String runId) {
                return stored.getOrDefault(runId, List.of()).stream()
                    .mapToLong(RunLogWindow.Chunk::seq).max().stream().boxed().findFirst()
                    .map(java.util.OptionalLong::of).orElseGet(java.util.OptionalLong::empty);
            }
        };
        logService = new RunLogService(chunks, new MutableClock());
        handler = new RunLogWebSocketHandler(new StubTickets(), logService,
            runId -> summary(RunState.RUNNING, runId), new MutableClock());
        window = logService.windowFor(RUN);
        session = new CapturingSession();
        handler.afterConnectionEstablished(session);
    }

    private RunSummary summary(RunState state, String runId) {
        return new RunSummary(runId, state.name(), "12", JSON.createObjectNode(),
            "2026-08-29T11:00:00Z", null, null, null, null, false, 0, null);
    }

    private void subscribe(Long lastSeq) throws Exception {
        String frame = "{\"type\":\"log.subscribe\",\"lastSeq\":" + (lastSeq == null ? "null" : lastSeq) + "}";
        handler.handleMessage(session, new TextMessage(frame));
    }

    @Test
    void subscribeReplaysPersistedWindowThenLiveAppends() throws Exception {
        window.append(1, "line one\n");
        window.append(2, "line two\n");
        subscribe(null);

        JsonNode replay = JSON.readTree(session.text.get(0));
        assertThat(replay.get("type").asText()).isEqualTo("log.replay");
        assertThat(replay.get("chunks").size()).isEqualTo(2);
        JsonNode first = replay.get("chunks").get(0);
        assertThat(first.get("seq").asLong()).isEqualTo(1);
        assertThat(first.get("byteLength").asLong()).isEqualTo("line one\n".getBytes().length);
        assertThat(first.get("persistedAt").isTextual()).isTrue();
        JsonNode meta = replay.get("window");
        assertThat(meta.get("firstAvailableSeq").asLong()).isEqualTo(1);
        assertThat(meta.get("lastAvailableSeq").asLong()).isEqualTo(2);
        assertThat(meta.get("truncated").asBoolean()).isFalse();
        assertThat(meta.get("evictedBytes").asLong()).isZero();

        logService.publish(RUN, 3, "line three\n");
        JsonNode append = JSON.readTree(session.text.get(1));
        assertThat(append.get("type").asText()).isEqualTo("log.append");
        assertThat(append.get("chunk").get("seq").asLong()).isEqualTo(3);
        assertThat(append.get("window").get("lastAvailableSeq").asLong()).isEqualTo(3);
    }

    @Test
    void replayBehindTheWindowResumesAtFirstAvailableSeqWithoutDuplicateSeqs() throws Exception {
        for (long seq = 1; seq <= 90; seq++) {
            window.append(seq, "a".repeat(64 * 1024));
        }
        subscribe(1L);

        JsonNode replay = JSON.readTree(session.text.get(0));
        assertThat(replay.get("type").asText()).isEqualTo("log.replay");
        var chunks = replay.get("chunks");
        long firstSeq = chunks.get(0).get("seq").asLong();
        assertThat(firstSeq).isEqualTo(replay.get("window").get("firstAvailableSeq").asLong());
        // The single LOG_GAP marker rides on the replay frame; the strict stage-five parser
        // ignores unknown fields, and the gap range is explicit for consumers.
        assertThat(replay.has("gap")).isTrue();
        assertThat(replay.get("gap").get("kind").asText()).isEqualTo("LOG_GAP");
        assertThat(replay.get("gap").get("fromSeq").asLong()).isEqualTo(2);
        assertThat(replay.get("gap").get("toSeq").asLong()).isEqualTo(firstSeq - 1);
        assertThat(session.text.stream().filter(payload -> payload.contains("LOG_GAP")).count()).isEqualTo(1);
        for (int i = 1; i < chunks.size(); i++) {
            assertThat(chunks.get(i).get("seq").asLong()).isEqualTo(chunks.get(i - 1).get("seq").asLong() + 1);
        }
        // Live overlap already covered by replay is deduplicated by the connection cursor.
        assertThat(logService.publish(RUN, firstSeq, "dup\n")).isFalse();
        assertThat(session.text).hasSize(1);
    }

    @Test
    void terminalRunCompletesTheStreamAfterReplay() throws Exception {
        RunLogWebSocketHandler terminal = new RunLogWebSocketHandler(new StubTickets(), logService,
            runId -> summary(RunState.SUCCEEDED, runId), new MutableClock());
        CapturingSession terminalSession = new CapturingSession();
        terminal.afterConnectionEstablished(terminalSession);
        String frame = "{\"type\":\"log.subscribe\",\"lastSeq\":null}";
        terminal.handleMessage(terminalSession, new TextMessage(frame));

        assertThat(terminalSession.text).hasSize(2);
        JsonNode complete = JSON.readTree(terminalSession.text.get(1));
        assertThat(complete.get("type").asText()).isEqualTo("log.complete");
        assertThat(complete.get("lastSeq").isNull()).isTrue();
    }

    @Test
    void missingExpiredAndReusedTicketsCloseWith4410() throws Exception {
        CapturingSession noTicket = new CapturingSession();
        noTicket.setUri("/api/v1/ws/run-logs");
        handler.afterConnectionEstablished(noTicket);
        assertThat(noTicket.closed.getCode()).isEqualTo(4410);

        CapturingSession reused = new CapturingSession();
        reused.setUri("/api/v1/ws/run-logs?ticket=reused-ticket");
        handler.afterConnectionEstablished(reused);
        assertThat(reused.closed.getCode()).isEqualTo(4410);

        CapturingSession expired = new CapturingSession();
        expired.setUri("/api/v1/ws/run-logs?ticket=expired-ticket");
        handler.afterConnectionEstablished(expired);
        assertThat(expired.closed.getCode()).isEqualTo(4410);
    }

    @Test
    void protocolViolationsFailClosedWithoutTerminalOrBinaryFrames() throws Exception {
        handler.handleMessage(session, new TextMessage("{\"type\":\"log.append\",\"chunk\":{}}"));
        JsonNode error = JSON.readTree(session.text.get(0));
        assertThat(error.get("type").asText()).isEqualTo("stream.error");
        assertThat(error.get("code").asText()).isEqualTo("PROTOCOL_ERROR");

        int before = session.text.size();
        handler.handleMessage(session, new org.springframework.web.socket.BinaryMessage(new byte[]{1, 2, 3}));
        handler.handleMessage(session, new TextMessage("{\"type\":\"terminal.output\",\"data\":\"x\"}"));
        assertThat(session.text.size()).isEqualTo(before);
        assertThat(session.closed).isNull();
    }

    @Test
    void heartbeatCarriesServerTimeAndRunStateFramesMatchTheContext() throws Exception {
        subscribe(null);
        int before = session.text.size();
        handler.heartbeat();
        JsonNode heartbeat = JSON.readTree(session.text.get(before));
        assertThat(heartbeat.get("type").asText()).isEqualTo("stream.heartbeat");
        assertThat(heartbeat.get("serverTime").asText()).isEqualTo("2026-08-29T11:00:00Z");

        handler.publishRunState(RUN, summary(RunState.SUCCEEDED, RUN));
        JsonNode runState = JSON.readTree(session.text.get(before + 1));
        assertThat(runState.get("type").asText()).isEqualTo("run.state");
        assertThat(runState.get("run").get("id").asText()).isEqualTo(RUN);
        assertThat(runState.get("run").get("state").asText()).isEqualTo("SUCCEEDED");
    }

    static final class MutableClock extends java.time.Clock {
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return NOW; }
    }

    static final class StubTickets implements LogTicketAuthenticator {
        @Override public Optional<LogTicketService.TicketRecord> consume(String ticket) {
            if ("valid-ticket".equals(ticket)) {
                return Optional.of(new LogTicketService.TicketRecord("hash", "user", PROJECT, RUN,
                    NOW.plus(Duration.ofSeconds(30)), null));
            }
            return Optional.empty();
        }
    }

    static final class CapturingSession implements WebSocketSession {
        final List<String> text = new ArrayList<>();
        CloseStatus closed;
        String uri = "/api/v1/ws/run-logs?ticket=valid-ticket";
        private final Map<String, Object> attributes = new ConcurrentHashMap<>();

        void setUri(String uri) { this.uri = uri; }
        @Override public String getId() { return "session-1"; }
        @Override public URI getUri() { return URI.create(uri); }
        @Override public HttpHeaders getHandshakeHeaders() { return new HttpHeaders(); }
        @Override public Principal getPrincipal() { return null; }
        @Override public String getAcceptedProtocol() { return ""; }
        @Override public List<WebSocketExtension> getExtensions() { return List.of(); }
        @Override public java.net.InetSocketAddress getRemoteAddress() { return null; }
        @Override public java.net.InetSocketAddress getLocalAddress() { return null; }
        @Override public int getTextMessageSizeLimit() { return 512 * 1024; }
        @Override public void setTextMessageSizeLimit(int size) { }
        @Override public int getBinaryMessageSizeLimit() { return 0; }
        @Override public void setBinaryMessageSizeLimit(int size) { }
        @Override public Map<String, Object> getAttributes() { return attributes; }
        @Override public boolean isOpen() { return closed == null; }
        @Override public void sendMessage(WebSocketMessage<?> message) {
            if (message instanceof TextMessage textMessage) text.add(textMessage.getPayload());
        }
        @Override public void close() { closed = CloseStatus.NORMAL; }
        @Override public void close(CloseStatus status) { closed = status; }
    }
}
