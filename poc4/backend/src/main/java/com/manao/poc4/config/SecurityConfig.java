package com.manao.poc4.config;

import com.manao.poc4.auth.JwtAuthenticationFilter;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.api.ApiError;
import java.time.Duration;
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
    @ConditionalOnBean(JwtService.class)
    SecurityFilterChain apiSecurity(HttpSecurity http, JwtService jwt) throws Exception {
        return http.securityMatcher("/api/**")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a -> a.requestMatchers("/api/v1/auth/login").permitAll().anyRequest().authenticated())
            .exceptionHandling(e -> e.authenticationEntryPoint((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_UNAUTHORIZED, new ApiError("UNAUTHENTICATED", "Authentication required", null));
            }).accessDeniedHandler((request, response, exception) -> {
                writeError(response, HttpServletResponse.SC_FORBIDDEN, new ApiError("FORBIDDEN", "Access denied", null));
            }))
            .addFilterBefore(new JwtAuthenticationFilter(jwt), UsernamePasswordAuthenticationFilter.class)
            .build();
    }

    private static void writeError(HttpServletResponse response, int status, ApiError error) throws java.io.IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(error.toMap()));
    }

    static final class BackendAuthCondition implements org.springframework.context.annotation.Condition {
        @Override public boolean matches(org.springframework.context.annotation.ConditionContext context,
                                         org.springframework.core.type.AnnotatedTypeMetadata metadata) {
            String excluded = context.getEnvironment().getProperty("spring.autoconfigure.exclude", "");
            return !excluded.contains("DataSourceAutoConfiguration");
        }
    }

}
