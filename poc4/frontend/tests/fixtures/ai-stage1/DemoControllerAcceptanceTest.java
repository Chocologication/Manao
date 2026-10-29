package com.example.app;
import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;
class DemoControllerAcceptanceTest {
    @Test void returnsRequestedMessage() {
        assertEquals("Hello from Pi", new DemoController().demo().message());
    }
}
