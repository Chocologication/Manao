package com.manao.poc2;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "manao.poc2")
public record Poc2Properties(
    String namespace,
    String image,
    Duration timeout,
    boolean cleanup
) {
}
