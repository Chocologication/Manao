package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;

/**
 * Every HTTP request is authenticated from the JWT claims AND the current app_user row:
 * the token only proves which account and version were signed, the database decides whether
 * that account is still enabled and still at that version. Missing/invalid version claims and
 * any database failure refuse the request instead of falling back to the token alone.
 */
class JwtAuthenticationFilterTest {
    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final String HEADER_JSON = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    private static final WebApplicationContextRunner RUNNER = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DispatcherServletAutoConfiguration.class,
            WebMvcAutoConfiguration.class, SecurityAutoConfiguration.class))
        .withUserConfiguration(SecurityConfig.class, ProjectsProbe.class)
        .withPropertyValues("MANAO_JWT_SECRET=" + SECRET);

    private final JwtService jwt = new JwtService(SECRET, Duration.ofMinutes(15));

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void theFilterAuthenticatesOnlyWhenTheStoreSaysTheAccountIsCurrent() throws Exception {
        UserStore store = mock(UserStore.class);
        when(store.isCurrent(any())).thenReturn(true);
        String token = jwt.issue("user-a", 4).accessToken();

        assertThat(runFilter(new JwtAuthenticationFilter(jwt, store), token)).isTrue();

        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        assertThat(authentication).isNotNull();
        assertThat(authentication.getPrincipal()).isInstanceOfSatisfying(AuthContracts.AccountIdentity.class, identity -> {
            assertThat(identity.userId()).isEqualTo("user-a");
            assertThat(identity.getName()).isEqualTo("user-a");
            assertThat(identity.authVersion()).isEqualTo(4);
        });
        assertThat(authentication.getAuthorities()).isEmpty();
        verify(store).isCurrent(new AuthContracts.AccountIdentity("user-a", 4));
    }

    @Test
    void staleDisabledDeletedAndDatabaseFailedAccountsAreNeverAuthenticated() throws Exception {
        UserStore stale = mock(UserStore.class);
        when(stale.isCurrent(any())).thenReturn(false);
        assertThat(runFilter(new JwtAuthenticationFilter(jwt, stale), jwt.issue("user-a", 0).accessToken())).isFalse();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();

        UserStore databaseDown = mock(UserStore.class);
        when(databaseDown.isCurrent(any())).thenThrow(new DataAccessResourceFailureException("database down"));
        assertThat(runFilter(new JwtAuthenticationFilter(jwt, databaseDown),
            jwt.issue("user-a", 0).accessToken())).isFalse();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();

        UserStore untouched = mock(UserStore.class);
        assertThat(runFilter(new JwtAuthenticationFilter(jwt, untouched), null)).isFalse();
        verifyNoInteractions(untouched);
    }

    @Test
    void tokensWithoutAStrictNonNegativeIntegerVerAreRejected() throws Exception {
        UserStore store = mock(UserStore.class);
        JwtAuthenticationFilter filter = new JwtAuthenticationFilter(jwt, store);
        long future = Instant.now().plusSeconds(600).getEpochSecond();
        List<String> malformed = List.of(
            "{\"sub\":\"user-a\",\"exp\":" + future + "}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ",\"ver\":-1}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ",\"ver\":1.5}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ",\"ver\":\"0\"}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ",\"ver\":true}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ",\"ver\":99999999999999999999999999}",
            "{\"sub\":\"user-a\",\"exp\":" + future + ".5,\"ver\":0}",
            "{\"sub\":\"user-a\",\"ver\":0}");
        for (String payload : malformed) {
            String token = signedToken(payload);
            assertThatThrownBy(() -> jwt.parse(token))
                .as("payload %s", payload)
                .isInstanceOf(IllegalArgumentException.class);
            assertThat(runFilter(filter, token)).as("payload %s", payload).isFalse();
        }
        verifyNoInteractions(store);
    }

    @Test
    void httpFixtureRejectsAStaleTokenWith401OnProjects() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'unused', ?)",
                "user-a", "alice", Timestamp.from(Instant.now()));

            RUNNER.withBean(JdbcTemplate.class, () -> jdbc).run(context -> {
                // The safe baseline is wired in production contexts too: registration closed,
                // mail disabled, no secret committed, and the design's challenge bounds.
                AuthProperties properties = context.getBean(AuthProperties.class);
                assertThat(properties.registrationEnabled()).isFalse();
                assertThat(properties.authChallengeSecret()).isEmpty();
                assertThat(properties.mail().enabled()).isFalse();
                assertThat(properties.mail().password()).isEmpty();
                assertThat(properties.mail().port()).isEqualTo(465);
                assertThat(properties.mail().tlsMode()).isEqualTo("ssl");
                assertThat(properties.challenge().emailCodeTtl()).isEqualTo(Duration.ofMinutes(10));
                assertThat(properties.challenge().emailCodeCooldown()).isEqualTo(Duration.ofSeconds(60));
                MockMvc mvc = MockMvcBuilders.webAppContextSetup((WebApplicationContext) context)
                    .addFilters(context.getBean(FilterChainProxy.class))
                    .build();
                JwtService issuer = context.getBean(JwtService.class);
                String oldToken = issuer.issue("user-a", 0).accessToken();

                assertThat(status(mvc, oldToken)).isEqualTo(200);
                assertThat(mvc.perform(get("/api/v1/projects")).andReturn().getResponse().getStatus())
                    .isEqualTo(401);
                assertThat(mvc.perform(get("/api/v1/projects").header("Authorization", "Bearer " + oldToken))
                    .andReturn().getResponse().getContentAsString()).contains("projects-ok:user-a");

                // A password change bumps auth_version: the pre-change token stops authenticating.
                jdbc.update("UPDATE app_user SET auth_version=1 WHERE id=?", "user-a");
                var stale = mvc.perform(get("/api/v1/projects").header("Authorization", "Bearer " + oldToken))
                    .andReturn();
                assertThat(stale.getResponse().getStatus()).isEqualTo(401);
                assertThat(stale.getResponse().getContentAsString()).contains("UNAUTHENTICATED");
                assertThat(status(mvc, issuer.issue("user-a", 1).accessToken())).isEqualTo(200);

                // Disabled accounts are refused even at the matching version.
                jdbc.update("UPDATE app_user SET enabled=FALSE WHERE id=?", "user-a");
                assertThat(status(mvc, issuer.issue("user-a", 1).accessToken())).isEqualTo(401);
            });
        }
    }

    private static int status(MockMvc mvc, String token) throws Exception {
        return mvc.perform(get("/api/v1/projects").header("Authorization", "Bearer " + token))
            .andReturn().getResponse().getStatus();
    }

    /** Runs the filter directly and reports whether the request reached the rest of the chain. */
    private static boolean runFilter(JwtAuthenticationFilter filter, String bearerValue) throws Exception {
        SecurityContextHolder.clearContext();
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/projects");
        if (bearerValue != null) request.addHeader("Authorization", "Bearer " + bearerValue);
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request, new MockHttpServletResponse(),
            (servletRequest, servletResponse) -> reached.set(true));
        assertThat(reached).isTrue();
        return SecurityContextHolder.getContext().getAuthentication() != null;
    }

    /** Signs an arbitrary payload with the fixture secret so claim-validation edge cases can be exercised. */
    static String signedToken(String payloadJson) {
        try {
            String signing = b64(HEADER_JSON) + "." + b64(payloadJson);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return signing + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signing.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String b64(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    @RestController
    static class ProjectsProbe {
        @GetMapping("/api/v1/projects")
        String projects(Authentication authentication) {
            return "projects-ok:" + authentication.getName();
        }
    }
}
