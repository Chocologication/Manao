package com.manao.poc4.completion;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.project.ProjectService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class CodeCompletionSecurityTest {
    @Test void realSecurityChainRejectsAnonymousAndForeignOwnersBeforeModelAccess() {
        var projects = mock(ProjectService.class);
        var client = mock(DeepSeekFimClient.class);
        var jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForList(anyString(), any(Object[].class)))
            .thenReturn(List.of(Map.of("enabled", true, "auth_version", 0L)));
        when(projects.get("other", "project")).thenReturn(Optional.empty());
        when(projects.get("owner", "missing")).thenReturn(Optional.empty());
        when(projects.get("owner", "project")).thenReturn(Optional.of(
            new ProjectService.Project("project", "owner", "test", "READY", Instant.EPOCH, null)));
        when(client.complete("a", "")).thenReturn(" + b");
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DispatcherServletAutoConfiguration.class,
                WebMvcAutoConfiguration.class, SecurityAutoConfiguration.class))
            .withUserConfiguration(SecurityConfig.class, CodeCompletionController.class, GlobalExceptionHandler.class)
            .withPropertyValues("MANAO_JWT_SECRET=0123456789abcdef0123456789abcdef")
            .withBean(JdbcTemplate.class, () -> jdbc)
            .withBean(ProjectService.class, () -> projects)
            .withBean(DeepSeekFimClient.class, () -> client)
            .run(context -> {
                var mvc = MockMvcBuilders.webAppContextSetup(context)
                    .addFilters(context.getBean(FilterChainProxy.class)).build();
                var issuer = context.getBean(JwtService.class);
                var request = post("/api/v1/projects/project/code-completions")
                    .contentType("application/json").content("{\"prefix\":\"a\",\"suffix\":\"\"}");
                assertThat(mvc.perform(request).andReturn().getResponse().getStatus()).isEqualTo(401);
                verifyNoInteractions(projects, client);
                assertThat(mvc.perform(request.header("Authorization", "Bearer " + issuer.issue("other", 0).accessToken()))
                    .andReturn().getResponse().getStatus()).isEqualTo(404);
                assertThat(mvc.perform(post("/api/v1/projects/missing/code-completions")
                    .header("Authorization", "Bearer " + issuer.issue("owner", 0).accessToken())
                    .contentType("application/json").content("{\"prefix\":\"a\",\"suffix\":\"\"}"))
                    .andReturn().getResponse().getStatus()).isEqualTo(404);
                verifyNoInteractions(client);
                request = post("/api/v1/projects/project/code-completions")
                    .header("Authorization", "Bearer " + issuer.issue("owner", 0).accessToken())
                    .contentType("application/json").content("{\"prefix\":\"a\",\"suffix\":\"\"}");
                assertThat(mvc.perform(request).andReturn().getResponse().getContentAsString()).contains(" + b");
                verify(client).complete("a", "");
            });
    }
}
