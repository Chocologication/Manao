package com.manao.poc4.terminal;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.api.StrictWsFrame;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.run.RunSummary;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

/**
 * Terminal WebSocket: ticket-only handshake into the run's live PTY. Binary frames carry PTY
 * input/output only; control frames follow the stage-five contract with server-owned flow
 * control. Every teardown path settles the terminal session exactly once and closes the exec;
 * old sessions are never reused.
 */
public final class TerminalWebSocketHandler extends AbstractWebSocketHandler {
    public static final int INITIAL_CREDIT_BYTES = TerminalFlowController.INITIAL_CREDIT_BYTES;
    private static final CloseStatus TICKET_REJECTED = new CloseStatus(4410, "terminal ticket rejected");
    private static final CloseStatus FLOW_VIOLATION = new CloseStatus(4409, "terminal flow violation");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final TerminalSessionService sessions;
    private final PtyBridge bridge;
    private final Function<String, RunSummary> runSummaryById;
    private final Function<String, Optional<com.manao.poc4.kubernetes.JobCoordinator.LivePod>> livePodResolver;
    private final Clock clock;
    private final ProjectLifecycleGate gate;
    private final Function<String, String> projectState;
    private final Map<String, BoundSession> connections = new ConcurrentHashMap<>();

    private static final class BoundSession {
        final WebSocketSession session;
        final TerminalStore.SessionRecord record;
        final TerminalFlowController flow;
        final java.util.ArrayDeque<byte[]> pendingOutput = new java.util.ArrayDeque<>();
        final java.util.ArrayDeque<byte[]> pendingInput = new java.util.ArrayDeque<>();
        final AtomicLong resizeGeneration = new AtomicLong();
        volatile PtyBridge.PtyHandle handle;
        volatile boolean settled;
        volatile boolean pauseNotified;

        BoundSession(WebSocketSession session, TerminalStore.SessionRecord record, Clock clock) {
            this.session = session;
            this.record = record;
            // The flow controller must share the handler clock so the 5-second input
            // deadline is observable in tests and consistent in production.
            this.flow = new TerminalFlowController(clock);
        }

        String runId() { return record.runId(); }
    }

    public TerminalWebSocketHandler(TerminalSessionService sessions, PtyBridge bridge,
                                    Function<String, RunSummary> runSummaryById, Clock clock,
                                    Function<String, Optional<com.manao.poc4.kubernetes.JobCoordinator.LivePod>> livePodResolver) {
        this(sessions, bridge, runSummaryById, clock, livePodResolver, null, null);
    }

    public TerminalWebSocketHandler(TerminalSessionService sessions, PtyBridge bridge,
                                    Function<String, RunSummary> runSummaryById, Clock clock,
                                    Function<String, Optional<com.manao.poc4.kubernetes.JobCoordinator.LivePod>> livePodResolver,
                                    ProjectLifecycleGate gate, Function<String, String> projectState) {
        this.sessions = sessions;
        this.bridge = bridge;
        this.runSummaryById = runSummaryById;
        this.clock = clock;
        this.livePodResolver = livePodResolver;
        this.gate = gate;
        this.projectState = projectState;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String ticket = ticketParameter(session.getUri());
        Optional<TerminalStore.SessionRecord> consumed = ticket == null ? Optional.empty() : sessions.consume(ticket);
        if (consumed.isEmpty()) {
            closeQuietly(session, TICKET_REJECTED);
            return;
        }
        TerminalStore.SessionRecord record = consumed.get();
        try (ProjectLifecycleGate.Lease ignored = acquireHandshake(record.projectId())) {
            if (projectState != null && "DELETING".equals(projectState.apply(record.projectId()))) {
                closeQuietly(session, TICKET_REJECTED);
                return;
            }
            BoundSession bound = new BoundSession(session, record, clock);
            connections.put(session.getId(), bound);
            RunSummary run = runSummaryById.apply(record.runId());
            if (run == null || !"RUNNING".equals(run.state())) {
                settleAndClose(bound, "RUN_LEFT_RUNNING", "INTERRUPTED", null, TICKET_REJECTED);
                return;
            }
            Optional<com.manao.poc4.kubernetes.JobCoordinator.LivePod> live = livePodResolver.apply(record.runId());
            if (live.isEmpty()) {
                // No identity-verified live application Pod: fail closed, never exec against a guessed name.
                settleAndClose(bound, "RUN_LEFT_RUNNING", "INTERRUPTED", null, TICKET_REJECTED);
                return;
            }
            com.manao.poc4.kubernetes.JobCoordinator.LivePod pod = live.get();
            try {
                bound.handle = bridge.open(pod.podName(), pod.containerName(), Math.max(record.cols(), 1),
                    Math.max(record.rows(), 1), new PtyListenerAdapter(bound));
                sessions.updateLiveRefs(record.sessionId(), pod.podName(), pod.containerName());
            } catch (RuntimeException ex) {
                settleAndClose(bound, "BACKEND_ERROR", "FAILED", null, TICKET_REJECTED);
                return;
            }
            ObjectNode ready = JSON.createObjectNode();
            ready.put("type", "terminal.ready");
            ready.put("sessionId", record.sessionId());
            sendText(bound, ready);
        } catch (ApiException ex) {
            closeQuietly(session, TICKET_REJECTED);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        BoundSession bound = connections.get(session.getId());
        if (bound == null || bound.handle == null) return;
        byte[] bytes = new byte[message.getPayloadLength()];
        message.getPayload().get(bytes);
        if (bytes.length > TerminalFlowController.MAX_INPUT_FRAME_BYTES) {
            // Protocol violation: input frames are hard-limited to 16 KiB.
            settleAndClose(bound, "BACKEND_ERROR", "FAILED", null, TICKET_REJECTED);
            return;
        }
        synchronized (bound.pendingInput) {
            if (bound.flow.canQueueInput(bytes.length)) {
                bound.flow.queueInput(bytes.length);
                bound.pendingInput.addLast(bytes);
            }
        }
        drainInput(bound);
        updatePauseState(bound);
        if (bound.flow.queueOverflowDeadlineExceeded()) {
            // 64 KiB queue full for the whole 5-second grace period: fail closed.
            settleAndClose(bound, "BACKEND_ERROR", "FAILED", null, TICKET_REJECTED);
        }
    }

    /** Writes queued input through to the PTY; backpressured bytes stay queued. */
    private void drainInput(BoundSession bound) {
        if (bound.handle == null || bound.settled) return;
        boolean shouldResume = false;
        synchronized (bound.pendingInput) {
            while (!bound.pendingInput.isEmpty()) {
                byte[] next = bound.pendingInput.peekFirst();
                if (!bound.handle.write(next)) break;
                bound.pendingInput.pollFirst();
                bound.flow.consumeInput(next.length);
            }
            if (bound.pendingInput.isEmpty() && bound.pauseNotified) {
                bound.pauseNotified = false;
                shouldResume = true;
            }
        }
        if (shouldResume) sendControl(bound, "terminal.input.resume");
    }

    private void updatePauseState(BoundSession bound) {
        if (bound.flow.shouldPauseReading() && !bound.pauseNotified) {
            bound.pauseNotified = true;
            sendControl(bound, "terminal.input.pause");
        }
    }

    /** Backend shutdown: settle every live session exactly once and never reattach old PTYs.
     *  The exit frame reason must stay inside the stage-five TerminalExitReason contract. */
    public void closeRun(String runId) {
        for (BoundSession bound : java.util.List.copyOf(connections.values())) {
            if (runId.equals(bound.runId())) {
                settleAndClose(bound, "CONNECTION_LOST", "INTERRUPTED", null, CloseStatus.GOING_AWAY);
                connections.remove(bound.session.getId(), bound);
            }
        }
    }

    public void teardownAllSessions() {
        for (BoundSession bound : List.copyOf(connections.values())) {
            settleAndClose(bound, "CONNECTION_LOST", "INTERRUPTED", null, null);
        }
    }

    /** Maintenance sweep: fail closed when the input queue stayed full beyond the grace period. */
    public void enforceInputDeadlines() {
        for (BoundSession bound : connections.values()) {
            if (bound.handle == null || bound.settled) continue;
            if (bound.flow.queueOverflowDeadlineExceeded()) {
                settleAndClose(bound, "BACKEND_ERROR", "FAILED", null, TICKET_REJECTED);
            }
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        BoundSession bound = connections.get(session.getId());
        if (bound == null) return;
        ObjectNode frame;
        try {
            frame = StrictWsFrame.object(JSON, message.getPayload());
            if (!frame.has("type") || !frame.get("type").isTextual()) {
                throw new IllegalArgumentException("type must be a string");
            }
            String type = frame.get("type").asText();
            switch (type) {
                case "terminal.resize" -> {
                    StrictWsFrame.requireExactFields(frame, "type", "cols", "rows");
                    int cols = StrictWsFrame.requireInt(frame, "cols");
                    int rows = StrictWsFrame.requireInt(frame, "rows");
                    try {
                        boolean accepted = bound.flow.acceptResize(bound.resizeGeneration.incrementAndGet(), cols, rows);
                        if (accepted && bound.handle != null) {
                            bound.handle.resize(cols, rows);
                        }
                    } catch (IllegalArgumentException ignored) {
                        // Out-of-range resize requests are dropped; the current dimensions stay effective.
                    }
                }
                case "terminal.close" -> {
                    StrictWsFrame.requireExactFields(frame, "type");
                    settleAndClose(bound, "CLIENT_CLOSED", "CLOSED", null, CloseStatus.NORMAL);
                }
                case "terminal.output.ack" -> {
                    StrictWsFrame.requireExactFields(frame, "type", "bytes");
                    handleAck(bound, StrictWsFrame.requireInt(frame, "bytes"));
                }
                case "terminal.output.credit" -> {
                    StrictWsFrame.requireExactFields(frame, "type", "bytes");
                    int bytes = StrictWsFrame.requireInt(frame, "bytes");
                    if (!bound.flow.grantCredit(bytes)) {
                        settleAndClose(bound, "CLIENT_CLOSED", "CLOSED", null, FLOW_VIOLATION);
                    }
                }
                case "terminal.pong" -> {
                    StrictWsFrame.requireExactFields(frame, "type", "nonce");
                    StrictWsFrame.requireText(frame, "nonce");
                }
                default -> {
                    sendProtocolError(bound);
                    settleAndClose(bound, "CLIENT_CLOSED", "CLOSED", null, FLOW_VIOLATION);
                }
            }
        } catch (IllegalArgumentException ex) {
            settleAndClose(bound, "CLIENT_CLOSED", "CLOSED", null, FLOW_VIOLATION);
        }
    }

    private void handleAck(BoundSession bound, int bytes) {
        var result = bound.flow.ack(bytes);
        if (result == TerminalFlowController.AckResult.VIOLATION) {
            settleAndClose(bound, "CLIENT_CLOSED", "CLOSED", null, FLOW_VIOLATION);
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

    /** PTY exit: settle once (CLOSED with the shell's exit code) and inform the client. */
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
        settle(bound, "CLOSED", "SHELL_EXITED", exitCode);
        closeQuietly(bound.session, CloseStatus.NORMAL);
    }

    private void settleAndClose(BoundSession bound, String reason, String sessionState, Integer exitCode,
                                CloseStatus status) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "terminal.exit");
        frame.putNull("exitCode");
        frame.put("reason", reason);
        sendText(bound, frame);
        settle(bound, sessionState, reason, exitCode);
        closeQuietly(bound.session, status);
    }

    /** Idempotent session settlement; the store only moves LIVE rows once. */
    private void settle(BoundSession bound, String state, String closeReason, Integer exitCode) {
        if (bound.settled) return;
        bound.settled = true;
        if (bound.handle != null) {
            bound.handle.close();
            bound.handle = null;
        }
        sessions.settle(bound.record.sessionId(), state, closeReason, exitCode);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        BoundSession bound = connections.remove(session.getId());
        if (bound != null && !bound.settled) {
            // Connection lost without a client close frame: interrupt and settle exactly once.
            settleAndClose(bound, "CONNECTION_LOST", "INTERRUPTED", null, null);
        }
    }

    private class PtyListenerAdapter implements PtyBridge.PtyListener {
        private final BoundSession bound;

        PtyListenerAdapter(BoundSession bound) { this.bound = bound; }

        @Override public void onOutput(byte[] bytes) { deliverOutput(bound, bytes); }

        @Override public void onExit(Integer exitCode) { handleExit(bound, exitCode); }

        @Override public void onWritable() {
            drainInput(bound);
            updatePauseState(bound);
        }
    }

    private void sendProtocolError(BoundSession bound) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "terminal.error");
        frame.put("code", "PROTOCOL_ERROR");
        frame.put("retryable", false);
        sendText(bound, frame);
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
        if (status == null) return;
        try {
            session.close(status);
        } catch (IOException ignored) { }
    }

    private ProjectLifecycleGate.Lease acquireHandshake(String projectId) {
        if (gate == null) {
            return () -> { };
        }
        return gate.tryAcquire(projectId).orElseThrow(
            () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"));
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
