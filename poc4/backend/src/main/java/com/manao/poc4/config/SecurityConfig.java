package com.manao.poc4.config;

import com.manao.poc4.auth.JwtAuthenticationFilter;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.api.ApiError;
import java.security.MessageDigest;
import java.time.Duration;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.boot.convert.DurationStyle;
import javax.sql.DataSource;
import jakarta.servlet.http.HttpServletResponse;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class SecurityConfig {
    @Bean
    JwtService jwtService(@Value("${MANAO_JWT_SECRET:}") String secret,
                          @Value("${MANAO_JWT_LIFETIME:15m}") String lifetime) {
        return new JwtService(secret, DurationStyle.detectAndParse(lifetime));
    }

    @Bean
    SecurityFilterChain apiSecurity(HttpSecurity http, JwtService jwt) throws Exception {
        return http.securityMatcher("/api/**")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a -> a.requestMatchers(request ->
                    (request.getDispatcherType() == jakarta.servlet.DispatcherType.ASYNC
                        || request.getDispatcherType() == jakarta.servlet.DispatcherType.ERROR)
                    && request.getRequestURI().matches("/api/v1/projects/[^/]+/agent-tasks/[^/]+/live-output")).permitAll()
                .requestMatchers("/api/v1/auth/login", "/api/v1/ws/run-logs", "/api/v1/ws/terminals").permitAll().anyRequest().authenticated())
            .exceptionHandling(e -> e.authenticationEntryPoint((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_UNAUTHORIZED, new ApiError("UNAUTHENTICATED", "Authentication required", null));
            }).accessDeniedHandler((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_FORBIDDEN, new ApiError("FORBIDDEN", "Access denied", null));
            }))
            .addFilterBefore(new JwtAuthenticationFilter(jwt), UsernamePasswordAuthenticationFilter.class)
            .build();
    }

    /**
     * The separate internal chain for the Pi worker routes (/internal/**): it accepts
     * only the fixed worker token, so a browser JWT can never reach a worker route,
     * and with no configured token the whole chain denies everything (fail closed —
     * the routes do not exist for anyone). The chain shares nothing with the browser
     * JWT chain beyond the error writer.
     */
    @Bean
    SecurityFilterChain internalSecurity(HttpSecurity http,
                                         @Value("${MANAO_AI_INTERNAL_TOKEN:}") String token) throws Exception {
        HttpSecurity secured = http.securityMatcher("/internal/**")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .exceptionHandling(e -> e.authenticationEntryPoint((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_UNAUTHORIZED, new ApiError("UNAUTHENTICATED", "Authentication required", null));
            }).accessDeniedHandler((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_FORBIDDEN, new ApiError("FORBIDDEN", "Access denied", null));
            }));
        if (token == null || token.isBlank()) {
            return secured.authorizeHttpRequests(a -> a.anyRequest().denyAll()).build();
        }
        return secured
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .addFilterBefore(new com.manao.poc4.ai.InternalBodyLimitFilter(), UsernamePasswordAuthenticationFilter.class)
            .addFilterBefore(new InternalTokenFilter(token), UsernamePasswordAuthenticationFilter.class)
            .build();
    }

    /** The worker's fixed-token filter: one header, constant-time compared. */
    static final class InternalTokenFilter extends org.springframework.web.filter.OncePerRequestFilter {
        private final byte[] digest;

        InternalTokenFilter(String token) {
            this.digest = sha256(token);
        }

        @Override protected void doFilterInternal(jakarta.servlet.http.HttpServletRequest request,
                                                  jakarta.servlet.http.HttpServletResponse response,
                                                  jakarta.servlet.FilterChain chain)
            throws jakarta.servlet.ServletException, java.io.IOException {
            String header = request.getHeader("X-Manao-Worker-Token");
            boolean matches = false;
            if (header != null && !header.isEmpty()) {
                byte[] candidate = sha256(header);
                matches = MessageDigest.isEqual(candidate, digest);
            }
            if (matches) {
                SecurityContextHolder.getContext().setAuthentication(
                    org.springframework.security.authentication.UsernamePasswordAuthenticationToken
                        .authenticated("pi-worker", null, java.util.List.of()));
            } else {
                SecurityContextHolder.clearContext();
            }
            chain.doFilter(request, response);
        }

        private static byte[] sha256(String value) {
            try {
                return MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (java.security.NoSuchAlgorithmException ex) {
                throw new IllegalStateException("SHA-256 is unavailable", ex);
            }
        }
    }

    private static void writeError(HttpServletResponse response, int status, ApiError error) throws java.io.IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(error.toMap()));
    }

    public static final class BackendAuthCondition implements org.springframework.context.annotation.Condition {
        @Override public boolean matches(org.springframework.context.annotation.ConditionContext context,
                                         org.springframework.core.type.AnnotatedTypeMetadata metadata) {
            String excluded = context.getEnvironment().getProperty("spring.autoconfigure.exclude", "");
            return !excluded.contains("DataSourceAutoConfiguration");
        }
    }

}
