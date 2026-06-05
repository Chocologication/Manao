package com.manao.poc2.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc2.run.RunEventJson;
import com.manao.poc2.run.RunEventSink;
import com.manao.poc2.run.StreamingCodeRunner;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

class RunWebSocketHandlerTest {

    private final StreamingCodeRunner codeRunner = org.mockito.Mockito.mock(StreamingCodeRunner.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RunWebSocketHandler handler = new RunWebSocketHandler(
        objectMapper,
        new RunEventJson(objectMapper),
        codeRunner,
        Runnable::run
    );

    @Test
    @DisplayName("blank code sends error event")
    void handleTextMessage_whenCodeBlank_sendsError() throws Exception {
        WebSocketSession session = openSession();

        handler.handleTextMessage(session, new TextMessage("{\"code\":\"   \"}"));

        assertThat(sentPayload(session)).contains("\"type\":\"error\"");
        assertThat(sentPayload(session)).contains("code must not be blank");
        verifyNoInteractions(codeRunner);
    }

    @Test
    @DisplayName("malformed JSON sends error event")
    void handleTextMessage_whenMalformedJson_sendsError() throws Exception {
        WebSocketSession session = openSession();

        handler.handleTextMessage(session, new TextMessage("{"));

        assertThat(sentPayload(session)).contains("\"type\":\"error\"");
        assertThat(sentPayload(session)).contains("invalid request");
        verifyNoInteractions(codeRunner);
    }

    @Test
    @DisplayName("valid code delegates to streaming runner")
    void handleTextMessage_whenValid_delegatesToRunner() throws Exception {
        WebSocketSession session = openSession();

        handler.handleTextMessage(session, new TextMessage("{\"code\":\"public class Main {}\"}"));

        ArgumentCaptor<RunEventSink> sinkCaptor = ArgumentCaptor.forClass(RunEventSink.class);
        verify(codeRunner).stream(eq("public class Main {}"), sinkCaptor.capture());
        assertThat(sinkCaptor.getValue()).isNotNull();
    }

    private WebSocketSession openSession() {
        WebSocketSession session = org.mockito.Mockito.mock(WebSocketSession.class);
        org.mockito.Mockito.when(session.isOpen()).thenReturn(true);
        return session;
    }

    private String sentPayload(WebSocketSession session) throws Exception {
        ArgumentCaptor<TextMessage> messageCaptor = ArgumentCaptor.forClass(TextMessage.class);
        verify(session).sendMessage(messageCaptor.capture());
        return messageCaptor.getValue().getPayload();
    }
}
