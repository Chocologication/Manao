package com.example.app;

import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {

    public record Demo(String message, Instant timestamp) {}

    @GetMapping("/api/demo")
    public Demo demo() {
        return new Demo("Hello from Manao", Instant.now());
    }
}
