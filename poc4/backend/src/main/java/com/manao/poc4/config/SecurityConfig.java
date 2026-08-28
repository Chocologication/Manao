package com.manao.poc4.config;

import com.manao.poc4.auth.JwtAuthenticationFilter;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.api.ApiError;
import java.time.Duration;
import javax.sql.DataSource;
import jakarta.servlet.http.HttpServletResponse;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@ConditionalOnBean(DataSource.class)
public class SecurityConfig {
    @Bean
    @ConditionalOnMissingBean
    JwtService jwtService(@Value("${MANAO_JWT_SECRET:}") String secret,
                          @Value("${MANAO_JWT_LIFETIME:15m}") Duration lifetime) {
        return new JwtService(secret, lifetime);
    }

    @Bean
    @ConditionalOnBean(JwtService.class)
    SecurityFilterChain apiSecurity(HttpSecurity http, JwtService jwt) throws Exception {
        return http.securityMatcher("/api/**")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a -> a.requestMatchers("/api/v1/auth/login").permitAll().anyRequest().authenticated())
            .exceptionHandling(e -> e.authenticationEntryPoint((request, response, exception) -> {
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType("application/json");
                response.getWriter().write(new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(new ApiError("UNAUTHENTICATED", "Authentication required", UUID.randomUUID().toString()).toMap()));
            }))
            .addFilterBefore(new JwtAuthenticationFilter(jwt), UsernamePasswordAuthenticationFilter.class)
            .build();
    }

}
