package com.manao.poc4.log;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunSummary;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * Log WebSocket: ticket-only handshake (4410 on missing/expired/reused tickets), one subscribe
 * frame with replay, then persistence-first live appends, heartbeats and run.state frames.
 * Terminal/PTY data can never travel on this socket; protocol violations fail closed.
 */
public final class RunLogWebSocketHandler extends TextWebSocketHandler {
    private static final CloseStatus TICKET_REJECTED = new CloseStatus(4410, "log ticket rejected");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final LogTicketAuthenticator tickets;
    private final RunLogService logService;
    private final Function<String, RunSummary> runSummaryById;
    private final Clock clock;
    private final Map<String, BoundSession> sessions = new ConcurrentHashMap<>();

    private static final class BoundSession {
        final WebSocketSession session;
        final String runId;
        final LogReplayCursor cursor;
        final RunLogService.LogListener listener;
        volatile boolean rejected;

        BoundSession(WebSocketSession session, String runId, RunLogService.LogListener listener) {
            this.session = session;
            this.runId = runId;
            this.cursor = LogReplayCursor.forConnection();
            this.listener = listener;
        }
    }

    public RunLogWebSocketHandler(LogTicketAuthenticator tickets, RunLogService logService,
                                  Function<String, RunSummary> runSummaryById, Clock clock) {
        this.tickets = tickets;
        this.logService = logService;
        this.runSummaryById = runSummaryById;
        this.clock = clock;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String ticket = ticketParameter(session.getUri());
        Optional<LogTicketService.TicketRecord> record = ticket == null ? Optional.empty() : tickets.consume(ticket);
        if (record.isEmpty()) {
            closeQuietly(session, TICKET_REJECTED);
            return;
        }
        String runId = record.get().runId();
        BoundSession bound = new BoundSession(session, runId,
            (chunk, meta) -> publishAppend(runId, chunk, meta));
        sessions.put(session.getId(), bound);
        logService.addListener(runId, bound.listener);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        BoundSession bound = sessions.get(session.getId());
        if (bound == null || bound.rejected) return;
        ObjectNode frame;
        try {
            frame = (ObjectNode) JSON.readTree(message.getPayload());
        } catch (Exception ex) {
            reject(bound);
            return;
        }
        if (!"log.subscribe".equals(frame.path("type").asText())) {
            reject(bound);
            return;
        }
        if (frame.path("lastSeq").isMissingNode()) {
            reject(bound);
            return;
        }
        Long lastSeq = frame.path("lastSeq").isNull() || frame.path("lastSeq").isMissingNode()
            ? null : frame.path("lastSeq").asLong();
        if (lastSeq != null && lastSeq < 0) {
            reject(bound);
            return;
        }
        subscribe(bound, lastSeq);
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, org.springframework.web.socket.BinaryMessage message) {
        // Binary payloads belong to the terminal channel only; the log socket never echoes them.
        BoundSession bound = sessions.get(session.getId());
        if (bound != null) bound.rejected = true;
    }

    private void subscribe(BoundSession bound, Long lastSeq) {
        RunLogWindow window = logService.windowFor(bound.runId);
        RunLogWindow.WindowMeta meta = window.meta();
        LogReplayCursor.ReplayPlan plan = LogReplayCursor.plan(lastSeq, meta);
        var chunks = plan.startSeq() == null ? List.<RunLogWindow.Chunk>of() : window.chunksAfter(plan.startSeq() - 1);
        var accepted = new java.util.ArrayList<RunLogWindow.Chunk>();
        for (RunLogWindow.Chunk chunk : chunks) {
            if (bound.cursor.accept(chunk.seq())) accepted.add(chunk);
        }
        ObjectNode replay = replayFrame(accepted, meta);
        if (plan.gap()) {
            // Single LOG_GAP marker: the client's strict parser ignores unknown fields, and the
            // gap range makes the discontinuity explicit alongside firstAvailableSeq.
            ObjectNode gap = replay.putObject("gap");
            gap.put("kind", "LOG_GAP");
            gap.put("fromSeq", lastSeq == null ? 1 : lastSeq + 1);
            gap.put("toSeq", meta.firstAvailableSeq() - 1);
        }
        send(bound, replay);
        RunSummary run = runSummaryById.apply(bound.runId);
        if (run != null && RunStateReducerBridge.isTerminal(run.state())) {
            send(bound, completeFrame(meta.lastAvailableSeq()));
        }
    }

    /** Publishes one persisted chunk to subscribed sessions of the run; duplicates are dropped. */
    public void publishAppend(String runId, RunLogWindow.Chunk chunk, RunLogWindow.WindowMeta meta) {
        for (BoundSession bound : sessions.values()) {
            if (!bound.runId.equals(runId) || bound.rejected) continue;
            if (!bound.cursor.accept(chunk.seq())) continue;
            send(bound, appendFrame(chunk, meta));
        }
    }

    /** Pushes a run.state frame so the browser can reload a settled run. */
    public void publishRunState(String runId, RunSummary summary) {
        for (BoundSession bound : sessions.values()) {
            if (!bound.runId.equals(runId) || bound.rejected) continue;
            ObjectNode frame = JSON.createObjectNode();
            frame.put("type", "run.state");
            frame.set("run", JSON.valueToTree(summary));
            send(bound, frame);
        }
    }

    /** Periodic keep-alive for all subscribed sessions. */
    public void heartbeat() {
        for (BoundSession bound : sessions.values()) {
            if (bound.rejected) continue;
            ObjectNode frame = JSON.createObjectNode();
            frame.put("type", "stream.heartbeat");
            frame.put("serverTime", clock.instant().toString());
            send(bound, frame);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        BoundSession bound = sessions.remove(session.getId());
        if (bound != null) logService.removeListener(bound.runId, bound.listener);
    }

    private void reject(BoundSession bound) {
        bound.rejected = true;
        sendError(bound, "PROTOCOL_ERROR");
    }

    private void sendError(BoundSession bound, String code) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "stream.error");
        frame.put("code", code);
        frame.put("retryable", false);
        send(bound, frame);
    }

    private ObjectNode replayFrame(java.util.List<RunLogWindow.Chunk> chunks, RunLogWindow.WindowMeta meta) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "log.replay");
        ArrayNode array = frame.putArray("chunks");
        for (RunLogWindow.Chunk chunk : chunks) {
            array.add(chunkNode(chunk));
        }
        frame.set("window", metaNode(meta));
        return frame;
    }

    private ObjectNode appendFrame(RunLogWindow.Chunk chunk, RunLogWindow.WindowMeta meta) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "log.append");
        frame.set("chunk", chunkNode(chunk));
        frame.set("window", metaNode(meta));
        return frame;
    }

    private ObjectNode completeFrame(Long lastSeq) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "log.complete");
        if (lastSeq == null) {
            frame.putNull("lastSeq");
        } else {
            frame.put("lastSeq", lastSeq);
        }
        return frame;
    }

    private ObjectNode chunkNode(RunLogWindow.Chunk chunk) {
        ObjectNode node = JSON.createObjectNode();
        node.put("seq", chunk.seq());
        node.put("text", chunk.text());
        node.put("byteLength", chunk.byteLength());
        node.put("persistedAt", chunk.persistedAt().toString());
        return node;
    }

    private ObjectNode metaNode(RunLogWindow.WindowMeta meta) {
        ObjectNode node = JSON.createObjectNode();
        if (meta.firstAvailableSeq() == null) {
            node.putNull("firstAvailableSeq");
            node.putNull("lastAvailableSeq");
        } else {
            node.put("firstAvailableSeq", meta.firstAvailableSeq());
            node.put("lastAvailableSeq", meta.lastAvailableSeq());
        }
        node.put("retainedBytes", meta.retainedBytes());
        node.put("truncated", meta.truncated());
        node.put("evictedBytes", meta.evictedBytes());
        return node;
    }

    private void send(BoundSession bound, ObjectNode frame) {
        try {
            if (bound.session.isOpen()) {
                bound.session.sendMessage(new TextMessage(JSON.writeValueAsBytes(frame)));
            }
        } catch (IOException ignored) {
            // Broken transports are handled by afterConnectionClosed.
        }
    }

    private static void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            session.close(status);
        } catch (IOException ignored) { }
    }

    private static String ticketParameter(URI uri) {
        if (uri == null || uri.getQuery() == null) return null;
        for (String pair : uri.getQuery().split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2 && parts[0].equals("ticket")) {
                return java.net.URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    /** Bridges run states without a hard dependency on the run package's reducer. */
    private static final class RunStateReducerBridge {
        static boolean isTerminal(String state) {
            return RunState.SUCCEEDED.name().equals(state) || RunState.FAILED.name().equals(state)
                || RunState.CANCELLED.name().equals(state) || RunState.TIMED_OUT.name().equals(state);
        }
    }
}
