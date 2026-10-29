package com.manao.poc4.auth;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.config.StrictHttpJsonConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.Timestamp;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * The real HTTP JSON path: the production ObjectMapper (Jackson auto-configuration plus
 * {@link StrictHttpJsonConfig}), the real {@link SecurityConfig} filter chain and the real
 * {@link GlobalExceptionHandler}. An extra login field must be rejected with the design's fixed
 * 422 VALIDATION_ERROR / ApiError shape, while a valid login keeps working. This replaces the old
 * hand-built {@code new ObjectMapper()} assertion that did not exercise the deployed mapper.
 */
class AuthJsonContractTest {
    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final PasswordService PASSWORDS = new PasswordService();

    private static final WebApplicationContextRunner RUNNER = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DispatcherServletAutoConfiguration.class,
            WebMvcAutoConfiguration.class, SecurityAutoConfiguration.class,
            JacksonAutoConfiguration.class, HttpMessageConvertersAutoConfiguration.class))
        .withUserConfiguration(StrictHttpJsonConfig.class, SecurityConfig.class, PasswordService.class,
            AuthServiceConfiguration.class, AuthController.class, GlobalExceptionHandler.class)
        .withPropertyValues("MANAO_JWT_SECRET=" + SECRET);

    @Test
    void rejectsUnknownLoginFieldsThroughTheRealObjectMapperAndStillLogsIn() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
                "alice", "alice", PASSWORDS.hash("correct"), Timestamp.from(Instant.now()));
            RUNNER.withBean(JdbcTemplate.class, () -> jdbc)
                .withBean(VerificationMailSender.class, SmtpVerificationMailSender.Unavailable::new)
                .run(context -> {
                MockMvc mvc = MockMvcBuilders.webAppContextSetup((WebApplicationContext) context)
                    .addFilters(context.getBean(FilterChainProxy.class))
                    .build();

                mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"alice\",\"password\":\"correct\",\"token\":\"leak\"}"))
                    .andExpect(status().isUnprocessableEntity())
                    .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"))
                    .andExpect(jsonPath("$.message").value("Request validation failed"))
                    .andExpect(jsonPath("$.traceId").isNotEmpty());

                mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"alice\",\"password\":\"correct\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.accessToken").isNotEmpty())
                    .andExpect(jsonPath("$.user.username").value("alice"));
            });
        }
    }
}
