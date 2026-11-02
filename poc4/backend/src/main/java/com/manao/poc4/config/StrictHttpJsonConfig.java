package com.manao.poc4.config;

import com.fasterxml.jackson.databind.DeserializationFeature;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The HTTP JSON contract (design section 9: request bodies reject unknown fields).
 *
 * <p>Spring Boot disables {@code DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES} by default, so
 * a per-record {@code @JsonIgnoreProperties(ignoreUnknown = false)} is not enough: the real Spring
 * MVC message converter keeps accepting extra fields. This customizer enables the feature on the
 * application ObjectMapper, which is also what the existing strict request records across
 * Project/Workspace/Terminal/Run/Agent controllers already assume. A violation arrives at
 * {@code GlobalExceptionHandler} as a message-not-readable failure and keeps the fixed
 * {@code 422 VALIDATION_ERROR} ApiError contract. No other mapper setting or security behavior is
 * changed; standalone ObjectMappers used for persisted JSON are untouched.
 */
@Configuration(proxyBeanMethods = false)
public final class StrictHttpJsonConfig {
    @Bean
    Jackson2ObjectMapperBuilderCustomizer strictHttpJson() {
        return builder -> builder.featuresToEnable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }
}
