package com.example.app;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {
    @GetMapping("/api/demo")
    public Map<String, String> demo(@RequestParam(name = "name", defaultValue = "guest") String name) {
        if ("Pi".equals(name)) {
            throw new IllegalStateException("stage2-seeded-handler-failure");
        }
        return Map.of("message", "Hello " + name);
    }
}
