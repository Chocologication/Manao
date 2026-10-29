package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.auth.JwtService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The internal worker routes are a separate security chain: they answer only the fixed worker
 * token, a browser JWT never passes, and with no configured token the whole chain is closed.
 * The public /api chain keeps its owner-JWT behavior alongside the new chain.
 */
class AgentInternalSecurityTest {
    private static final String JWT_SECRET = "0123456789abcdef0123456789abcdef";

    private static final WebApplicationContextRunner RUNNER = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(
            DispatcherServletAutoConfiguration.class, WebMvcAutoConfiguration.class,
            SecurityAutoConfiguration.class))
        .withUserConfiguration(SecurityConfig.class, AgentInternalSecurityTest.Probes.class);

    @RestController
    static class Probes {
        @GetMapping("/internal/ai/probe")
        String internal() {
            return "internal-ok";
        }

        @org.springframework.web.bind.annotation.PostMapping("/internal/ai/tasks/{taskId}/context")
        String context(@org.springframework.web.bind.annotation.RequestBody String body) {
            return "context-ok:" + body.length();
        }

        /** The terminal receipt route stays inside the same worker-token chain. */
        @org.springframework.web.bind.annotation.PostMapping("/internal/ai/tasks/{taskId}/terminal")
        String terminal(@org.springframework.web.bind.annotation.RequestBody String body) {
            return "terminal-ok:" + body.length();
        }

        /** The terminal reconciliation read stays inside the same worker-token chain. */
        @org.springframework.web.bind.annotation.GetMapping("/internal/ai/tasks/{taskId}/terminal")
        String terminalAck() {
            return "terminal-ack-ok";
        }

        @org.springframework.web.bind.annotation.PostMapping("/internal/ai/probe")
        String postInternal(@org.springframework.web.bind.annotation.RequestBody String body) {
            return "internal-ok:" + body.length();
        }

        @GetMapping("/api/v1/probe")
        String api(org.springframework.security.core.Authentication authentication) {
            return "api-ok:" + authentication.getName();
        }
    }

    private static MockMvc mockMvc(org.springframework.context.ConfigurableApplicationContext context) {
        return MockMvcBuilders.webAppContextSetup(
                (org.springframework.web.context.WebApplicationContext) context)
            .addFilters(context.getBean(FilterChainProxy.class))
            .build();
    }

    private static String jwt(JwtService service, String subject) {
        return service.issue(subject).accessToken();
    }

    @Test void contextRouteStillRequiresWorkerTokenWhileAllowingItsLargerBound() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                String body = "x".repeat(600 * 1024);
                var allowed = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/internal/ai/tasks/task/context").header("X-Manao-Worker-Token", "internal-token").content(body)).andReturn();
                assertThat(allowed.getResponse().getStatus()).isEqualTo(200);
                var denied = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/internal/ai/tasks/task/context").header("Authorization", "Bearer " + jwt(context.getBean(JwtService.class), "browser-user")).content(body)).andReturn();
                assertThat(denied.getResponse().getStatus()).isEqualTo(401);
            });
    }

    @Test void theTerminalRoutesStayInsideTheWorkerTokenChain() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                var posted = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/internal/ai/tasks/task/terminal")
                    .header("X-Manao-Worker-Token", "internal-token")
                    .content("{\"protocolVersion\":1}")).andReturn();
                assertThat(posted.getResponse().getStatus()).isEqualTo(200);
                var read = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .get("/internal/ai/tasks/task/terminal")
                    .header("X-Manao-Worker-Token", "internal-token")).andReturn();
                assertThat(read.getResponse().getStatus()).isEqualTo(200);
                // A browser JWT is never a worker token, on the receipt or its read.
                String browser = jwt(context.getBean(JwtService.class), "browser-user");
                var jwtPost = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/internal/ai/tasks/task/terminal")
                    .header("Authorization", "Bearer " + browser)
                    .content("{}")).andReturn();
                assertThat(jwtPost.getResponse().getStatus()).isEqualTo(401);
                var jwtGet = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .get("/internal/ai/tasks/task/terminal")
                    .header("Authorization", "Bearer " + browser)).andReturn();
                assertThat(jwtGet.getResponse().getStatus()).isEqualTo(401);
            });
    }

    @Test
    void theWorkerTokenOpensTheInternalRoutes() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                assertThat(context).hasSingleBean(SecurityConfig.class);
                MockMvc mvc = mockMvc(context);
                MvcResult result = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", "internal-token"))
                    .andReturn();
                assertThat(result.getResponse().getStatus()).isEqualTo(200);
                assertThat(result.getResponse().getContentAsString()).contains("internal-ok");
            });
    }

    @Test
    void aBrowserJwtNeverOpensTheInternalRoutes() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                JwtService jwt = context.getBean(JwtService.class);
                MockMvc mvc = mockMvc(context);
                MvcResult result = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get("/internal/ai/probe")
                            .header("Authorization", "Bearer " + jwt(jwt, "browser-user")))
                    .andReturn();
                assertThat(result.getResponse().getStatus()).isEqualTo(401);
                // A browser JWT in the worker-token header is still just a wrong token.
                result = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", jwt(jwt, "browser-user")))
                    .andReturn();
                assertThat(result.getResponse().getStatus()).isEqualTo(401);
            });
    }

    @Test
    void aWrongOrMissingWorkerTokenIsRefused() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                MvcResult missing = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/internal/ai/probe"))
                    .andReturn();
                assertThat(missing.getResponse().getStatus()).isEqualTo(401);
                MvcResult wrong = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", "wrong-token"))
                    .andReturn();
                assertThat(wrong.getResponse().getStatus()).isEqualTo(401);
            });
    }

    @Test
    void withoutAConfiguredTokenTheInternalChainIsClosed() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                for (String token : new String[] {"internal-token", "anything"}) {
                    MvcResult result = mvc.perform(
                            org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .get("/internal/ai/probe")
                                .header("X-Manao-Worker-Token", token))
                        .andReturn();
                    int status = result.getResponse().getStatus();
                    assertThat(status).as("token=" + token).isIn(401, 403, 404);
                }
            });
    }

    @Test
    void anOversizedInternalBodyIsRefusedWithTheFixedSafeError() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                byte[] oversized = new byte[600 * 1024];
                MvcResult result = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .post("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", "internal-token")
                            .content(oversized))
                    .andReturn();
                assertThat(result.getResponse().getStatus()).isEqualTo(413);
                assertThat(result.getResponse().getContentAsString()).contains("AI_REQUEST_TOO_LARGE");
                // A body within the bound still passes the chain.
                MvcResult small = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .post("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", "internal-token")
                            .content("hello"))
                    .andReturn();
                assertThat(small.getResponse().getStatus()).isEqualTo(200);
            });
    }

    @Test
    void aStreamedBodyWithoutContentLengthIsCountedAndRefusedBeforeHandlers()
        throws jakarta.servlet.ServletException, java.io.IOException {
        // A lying/missing declaration changes nothing: the filter pre-reads the real
        // bytes and refuses before any handler runs.
        InternalBodyLimitFilter filter = new InternalBodyLimitFilter();
        org.springframework.mock.web.MockHttpServletRequest request =
            new org.springframework.mock.web.MockHttpServletRequest("POST", "/internal/ai/probe");
        request.setContent(new byte[600 * 1024]);
        org.springframework.mock.web.MockHttpServletResponse response =
            new org.springframework.mock.web.MockHttpServletResponse();
        java.util.concurrent.atomic.AtomicBoolean chainReached = new java.util.concurrent.atomic.AtomicBoolean(false);
        filter.doFilter(request, response,
            (servletRequest, servletResponse) -> chainReached.set(true));
        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(response.getContentAsString()).contains("AI_REQUEST_TOO_LARGE");
        assertThat(chainReached).isFalse();
        // A body within the bound reaches the chain with its exact bytes.
        org.springframework.mock.web.MockHttpServletRequest small =
            new org.springframework.mock.web.MockHttpServletRequest("POST", "/internal/ai/probe");
        small.setContent("hello".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        org.springframework.mock.web.MockHttpServletResponse smallResponse =
            new org.springframework.mock.web.MockHttpServletResponse();
        java.util.concurrent.atomic.AtomicReference<byte[]> seen = new java.util.concurrent.atomic.AtomicReference<>();
        filter.doFilter(small, smallResponse, (servletRequest, servletResponse) -> {
            chainReached.set(true);
            seen.set(((jakarta.servlet.http.HttpServletRequest) servletRequest).getInputStream().readAllBytes());
        });
        assertThat(chainReached).isTrue();
        assertThat(new String(seen.get(), java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("hello");
    }

    @Test
    void aValidJsonFollowedByPaddingIsRefusedAsOversized() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                MockMvc mvc = mockMvc(context);
                // Valid JSON up front, hundreds of KiB of legal whitespace after it:
                // the real byte count, not the JSON validity, decides.
                String padded = "{\"probe\":\"x\"}" + " ".repeat(600 * 1024);
                MvcResult result = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .post("/internal/ai/probe")
                            .header("X-Manao-Worker-Token", "internal-token")
                            .content(padded))
                    .andReturn();
                assertThat(result.getResponse().getStatus()).isEqualTo(413);
                assertThat(result.getResponse().getContentAsString()).contains("AI_REQUEST_TOO_LARGE");
            });
    }

    @Test
    void thePublicApiChainKeepsItsOwnerJwtBehavior() {
        RUNNER.withPropertyValues("MANAO_JWT_SECRET=" + JWT_SECRET, "MANAO_AI_INTERNAL_TOKEN=internal-token")
            .run(context -> {
                JwtService jwt = context.getBean(JwtService.class);
                MockMvc mvc = mockMvc(context);
                MvcResult anonymous = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/probe"))
                    .andReturn();
                assertThat(anonymous.getResponse().getStatus()).isEqualTo(401);
                MvcResult owner = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get("/api/v1/probe")
                            .header("Authorization", "Bearer " + jwt(jwt, "browser-user")))
                    .andReturn();
                assertThat(owner.getResponse().getStatus()).isEqualTo(200);
                assertThat(owner.getResponse().getContentAsString()).contains("api-ok:browser-user");
            });
    }
}
