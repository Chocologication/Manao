package com.manao.poc4.terminal;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.run.RunSummary;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

/**
 * Terminal WebSocket: ticket-only handshake into the run's live PTY. Binary frames carry PTY
 * input/output only; control frames follow the stage-five contract with server-owned flow
 * control. Old sessions are never reused; every teardown settles the reservation exactly once.
 */
public final class TerminalWebSocketHandler extends AbstractWebSocketHandler {
    public static final int INITIAL_CREDIT_BYTES = TerminalFlowController.INITIAL_CREDIT_BYTES;
    private static final CloseStatus TICKET_REJECTED = new CloseStatus(4410, "terminal ticket rejected");
    private static final CloseStatus FLOW_VIOLATION = new CloseStatus(4409, "terminal flow violation");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final TerminalTicketService tickets;
    private final PtyBridge bridge;
    private final Function<String, RunSummary> runSummaryById;
    private final Clock clock;
    private final Map<String, BoundSession> sessions = new ConcurrentHashMap<>();

    private static final class BoundSession {
        final WebSocketSession session;
        final String runId;
        final String sessionId;
        final TerminalFlowController flow;
        final java.util.ArrayDeque<byte[]> pendingOutput = new java.util.ArrayDeque<>();
        boolean pauseSent;
        volatile PtyBridge.PtyHandle handle;
        volatile boolean settled;

        BoundSession(WebSocketSession session, String runId, String sessionId, TerminalFlowController flow) {
            this.session = session;
            this.runId = runId;
            this.sessionId = sessionId;
            this.flow = flow;
        }
    }

    public TerminalWebSocketHandler(TerminalTicketService tickets, PtyBridge bridge,
                                    Function<String, RunSummary> runSummaryById, Clock clock,
                                    int cols, int rows) {
        this.tickets = tickets;
        this.bridge = bridge;
        this.runSummaryById = runSummaryById;
        this.clock = clock;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String ticket = ticketParameter(session.getUri());
        Optional<TerminalStore.SessionRecord> consumed = ticket == null ? Optional.empty() : tickets.consume(ticket);
        if (consumed.isEmpty()) {
            closeQuietly(session, TICKET_REJECTED);
            return;
        }
        TerminalStore.SessionRecord record = consumed.get();
        BoundSession bound = new BoundSession(session, record.runId(), record.sessionId(),
            new TerminalFlowController(clock));
        sessions.put(session.getId(), bound);
        RunSummary run = runSummaryById.apply(record.runId());
        if (run == null || !"RUNNING".equals(run.state())) {
            settleAndClose(bound, "RUN_LEFT_RUNNING", null, TICKET_REJECTED);
            return;
        }
        try {
            bound.handle = bridge.open(record.runId(), 80, 24, new PtyListenerAdapter(bound));
        } catch (RuntimeException ex) {
            settleAndClose(bound, "BACKEND_ERROR", null, TICKET_REJECTED);
            return;
        }
        ObjectNode ready = JSON.createObjectNode();
        ready.put("type", "terminal.ready");
        ready.put("sessionId", record.sessionId());
        sendText(bound, ready);
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        BoundSession bound = sessions.get(session.getId());
        if (bound == null || bound.handle == null) return;
        byte[] bytes = new byte[message.getPayloadLength()];
        message.getPayload().get(bytes);
        if (bytes.length > TerminalFlowController.MAX_INPUT_FRAME_BYTES) {
            settleAndClose(bound, "CLIENT_CLOSED", null, TICKET_REJECTED);
            return;
        }
        if (bound.flow.canQueueInput(bytes.length)) {
            bound.flow.queueInput(bytes.length);
            drainInput(bound);
        }
        if (bound.flow.shouldPauseReading() && !bound.pauseSent) {
            bound.pauseSent = true;
            sendControl(bound, "terminal.input.pause");
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        BoundSession bound = sessions.get(session.getId());
        if (bound == null) return;
        ObjectNode frame;
        try {
            frame = (ObjectNode) JSON.readTree(message.getPayload());
        } catch (Exception ex) {
            settleAndClose(bound, "CLIENT_CLOSED", null, FLOW_VIOLATION);
            return;
        }
        String type = frame.path("type").asText();
        switch (type) {
            case "terminal.resize" -> {
                try {
                    boolean accepted = bound.flow.acceptResize(resizeGeneration(), frame.path("cols").asInt(),
                        frame.path("rows").asInt());
                    if (accepted && bound.handle != null) {
                        bound.handle.resize(frame.path("cols").asInt(), frame.path("rows").asInt());
                    }
                } catch (IllegalArgumentException ignored) {
                    // Out-of-range resize requests are dropped; the current dimensions stay effective.
                }
            }
            case "terminal.close" -> settleAndClose(bound, "CLIENT_CLOSED", null, CloseStatus.NORMAL);
            case "terminal.output.ack" -> handleAck(bound, frame.path("bytes").asInt());
            case "terminal.output.credit" -> bound.flow.grantCredit(frame.path("bytes").asInt());
            case "terminal.pong" -> { /* liveness marker; no state change */ }
            default -> {
                sendControl(bound, "terminal.error");
                settleAndClose(bound, "CLIENT_CLOSED", null, FLOW_VIOLATION);
            }
        }
    }

    private long resizeGeneration() {
        return clock.instant().toEpochMilli();
    }

    private void handleAck(BoundSession bound, int bytes) {
        var result = bound.flow.ack(bytes);
        if (result == TerminalFlowController.AckResult.VIOLATION) {
            settleAndClose(bound, "CLIENT_CLOSED", null, FLOW_VIOLATION);
            return;
        }
        flushPendingOutput(bound);
    }

    /** Called by the PTY listener: chunks output into <= 32 KiB frames under the credit window. */
    void deliverOutput(BoundSession bound, byte[] bytes) {
        int offset = 0;
        while (offset < bytes.length) {
            int length = Math.min(TerminalFlowController.MAX_OUTPUT_FRAME_BYTES, bytes.length - offset);
            byte[] frame = Arrays.copyOfRange(bytes, offset, offset + length);
            offset += length;
            if (bound.flow.canSend(length)) {
                bound.flow.sent(length);
                sendBinary(bound, frame);
            } else {
                synchronized (bound.pendingOutput) {
                    bound.pendingOutput.add(frame);
                }
            }
        }
    }

    private void flushPendingOutput(BoundSession bound) {
        while (true) {
            byte[] frame;
            synchronized (bound.pendingOutput) {
                frame = bound.pendingOutput.peek();
                if (frame == null || !bound.flow.canSend(frame.length)) return;
                bound.pendingOutput.poll();
            }
            bound.flow.sent(frame.length);
            sendBinary(bound, frame);
        }
    }

    private void drainInput(BoundSession bound) {
        // Input is written through synchronously; the queue only holds backpressured bytes.
        bound.flow.consumeInput(0);
    }

    /** PTY exit: settle once and inform the client with the shell's exit code. */
    void handleExit(BoundSession bound, Integer exitCode) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "terminal.exit");
        if (exitCode == null) {
            frame.putNull("exitCode");
        } else {
            frame.put("exitCode", exitCode);
        }
        frame.put("reason", "SHELL_EXITED");
        sendText(bound, frame);
        closeQuietly(bound.session, CloseStatus.NORMAL);
    }

    private void settleAndClose(BoundSession bound, String reason, Integer exitCode, CloseStatus status) {
        if (bound.settled) return;
        bound.settled = true;
        if (bound.handle != null) bound.handle.close();
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "terminal.exit");
        frame.putNull("exitCode");
        frame.put("reason", reason);
        sendText(bound, frame);
        closeQuietly(bound.session, status);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        BoundSession bound = sessions.remove(session.getId());
        if (bound != null && !bound.settled) {
            bound.settled = true;
            if (bound.handle != null) bound.handle.close();
        }
    }

    private class PtyListenerAdapter implements PtyBridge.PtyListener {
        private final BoundSession bound;

        PtyListenerAdapter(BoundSession bound) { this.bound = bound; }

        @Override public void onOutput(byte[] bytes) { deliverOutput(bound, bytes); }

        @Override public void onExit(Integer exitCode) { handleExit(bound, exitCode); }
    }

    private void sendControl(BoundSession bound, String type) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", type);
        sendText(bound, frame);
    }

    private void sendText(BoundSession bound, ObjectNode frame) {
        try {
            if (bound.session.isOpen()) {
                bound.session.sendMessage(new TextMessage(JSON.writeValueAsBytes(frame)));
            }
        } catch (IOException ignored) { }
    }

    private void sendBinary(BoundSession bound, byte[] bytes) {
        try {
            if (bound.session.isOpen()) {
                bound.session.sendMessage(new BinaryMessage(bytes));
            }
        } catch (IOException ignored) { }
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
}
