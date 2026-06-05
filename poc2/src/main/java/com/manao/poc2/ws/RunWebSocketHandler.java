package com.manao.poc2.ws;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc2.run.RunEvent;
import com.manao.poc2.run.RunEventJson;
import com.manao.poc2.run.RunRequest;
import com.manao.poc2.run.StreamingCodeRunner;
import java.io.IOException;
import java.util.concurrent.Executor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class RunWebSocketHandler extends TextWebSocketHandler {

    private final ObjectMapper objectMapper;
    private final RunEventJson eventJson;
    private final StreamingCodeRunner codeRunner;
    private final Executor executor;

    public RunWebSocketHandler(
        ObjectMapper objectMapper,
        RunEventJson eventJson,
        StreamingCodeRunner codeRunner,
        Executor runTaskExecutor
    ) {
        this.objectMapper = objectMapper;
        this.eventJson = eventJson;
        this.codeRunner = codeRunner;
        this.executor = runTaskExecutor;
    }

    @Override
    public void handleTextMessage(WebSocketSession session, TextMessage message) {
        RunRequest request;
        try {
            request = objectMapper.readValue(message.getPayload(), RunRequest.class);
        } catch (JsonProcessingException e) {
            send(session, RunEvent.error(null, "invalid request"));
            return;
        }

        if (request.code() == null || request.code().isBlank()) {
            send(session, RunEvent.error(null, "code must not be blank"));
            return;
        }

        executor.execute(() -> codeRunner.stream(request.code(), event -> send(session, event)));
    }

    private void send(WebSocketSession session, RunEvent event) {
        try {
            if (session.isOpen()) {
                session.sendMessage(new TextMessage(eventJson.toJson(event)));
            }
        } catch (IOException e) {
            throw new IllegalStateException("Failed to send WebSocket message", e);
        }
    }
}
