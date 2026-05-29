package com.manao.poc1;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "manao.poc1")
public record Poc1Properties(
    String namespace,
    String image,
    Duration timeout,
    boolean cleanup
) {

    public Poc1Properties {
        if (namespace == null || namespace.isBlank()) {
            namespace = "default";
        }
        if (image == null || image.isBlank()) {
            image = "eclipse-temurin:17-jdk";
        }
        if (timeout == null) {
            timeout = Duration.ofSeconds(30);
        }
    }
}
