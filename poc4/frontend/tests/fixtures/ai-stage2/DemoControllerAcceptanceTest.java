package com.example.app;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class DemoControllerAcceptanceTest {
    @Test void keepsTheGuestContract() {
        assertEquals("Hello guest", new DemoController().demo("guest").get("message"));
    }
}
