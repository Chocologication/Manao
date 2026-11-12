package com.manao.poc4.ai.studio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityFilterAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.ServletWebServerFactoryAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.web.servlet.context.AnnotationConfigServletWebServerApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

class StudioSseHttpTest {
    @Configuration(proxyBeanMethods = false)
    @ImportAutoConfiguration({ServletWebServerFactoryAutoConfiguration.class, DispatcherServletAutoConfiguration.class,
        WebMvcAutoConfiguration.class, JacksonAutoConfiguration.class, HttpMessageConvertersAutoConfiguration.class,
        SecurityAutoConfiguration.class, SecurityFilterAutoConfiguration.class})
    @Import({SecurityConfig.class, GlobalExceptionHandler.class, StudioController.class})
    static class WebConfig { }

    @Test
    void completedStreamsKeepHeadersAndAuthorizeBeforeAsyncDispatch() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            for (String owner : new String[] {"owner", "other"}) {
                jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,'unused',?)",
                    owner, owner, java.sql.Timestamp.from(java.time.Instant.now()));
            }
            var snapshot = new ObjectMapper().createObjectNode().put("id", "turn")
                .put("version", 1).put("state", "COMPLETED").put("reply", "已保存的回复");
            var service = mock(StudioService.class);
            when(service.get(anyString(), anyString(), anyString())).thenAnswer(call -> {
                if (!"owner".equals(call.getArgument(0))) throw new ApiException("ENTRY_NOT_FOUND", 404, "Not found");
                return snapshot;
            });
            var application = new SpringApplication(WebConfig.class);
            application.setWebApplicationType(WebApplicationType.SERVLET);
            application.setDefaultProperties(Map.of("server.port", "0", "server.address", "127.0.0.1",
                "spring.main.banner-mode", "off", "manao.poc4.ai.enabled", "true",
                "MANAO_JWT_SECRET", "0123456789abcdef0123456789abcdef"));
            application.addInitializers(context -> {
                var web = (AnnotationConfigServletWebServerApplicationContext) context;
                web.registerBean(org.springframework.jdbc.core.JdbcTemplate.class, () -> jdbc);
                web.registerBean(StudioService.class, () -> service);
                web.registerBean(StudioStore.class, () -> mock(StudioStore.class));
                web.registerBean(StudioModelStore.class, () -> mock(StudioModelStore.class));
                web.registerBean(StudioAttachments.class, () -> mock(StudioAttachments.class));
                web.registerBean(StudioApply.class, () -> mock(StudioApply.class));
            });
            try (var app = (AnnotationConfigServletWebServerApplicationContext) application.run(
                    "--server.port=0", "--spring.profiles.active=studio-sse-test", "--manao.poc4.ai.enabled=true")) {
                var uri = URI.create("http://127.0.0.1:" + app.getWebServer().getPort()
                    + "/api/v1/projects/project/assistant/turns/turn/events");
                var client = HttpClient.newHttpClient();
                var jwt = app.getBean(JwtService.class);
                var anonymous = client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofString());
                assertThat(anonymous.statusCode()).isEqualTo(401);
                var other = client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5))
                    .header("Authorization", "Bearer " + jwt.issue("other", 0).accessToken()).build(), HttpResponse.BodyHandlers.ofString());
                assertThat(other.statusCode()).isEqualTo(404);
                for (int attempt = 0; attempt < 3; attempt++) {
                    var response = client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5))
                        .header("Authorization", "Bearer " + jwt.issue("owner", 0).accessToken()).build(), HttpResponse.BodyHandlers.ofString());
                    assertThat(response.statusCode()).isEqualTo(200);
                    assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("text/event-stream");
                    assertThat(response.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store");
                    assertThat(response.headers().firstValue("X-Accel-Buffering").orElse("")).isEqualTo("no");
                    assertThat(response.body()).contains("event:snapshot", "已保存的回复").doesNotContain("UNAUTHENTICATED", "Access Denied");
                }
            }
        }
    }
}
