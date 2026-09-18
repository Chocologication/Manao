package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import java.util.Map;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/auth")
public final class AuthController {
    private final JwtService jwt;
    private final PasswordService passwords;
    private final JdbcTemplate jdbc;

    public AuthController(JwtService jwt, PasswordService passwords, JdbcTemplate jdbc) {
        this.jwt = jwt; this.passwords = passwords; this.jdbc = jdbc;
    }

    @PostMapping("/login")
    public Map<String, Object> login(@Valid @RequestBody LoginRequest request) {
        try {
            Map<String, Object> row = jdbc.queryForMap("SELECT id, username, password_hash, enabled FROM app_user WHERE username = ?", request.username());
            if (!Boolean.TRUE.equals(row.get("enabled")) || !passwords.matches(request.password(), String.valueOf(row.get("password_hash")))) throw invalid();
            JwtService.IssuedToken token = jwt.issue(String.valueOf(row.get("id")));
            return Map.of("accessToken", token.accessToken(), "expiresAt", token.expiresAt().toString(),
                "user", Map.of("id", String.valueOf(row.get("id")), "username", String.valueOf(row.get("username"))));
        } catch (EmptyResultDataAccessException ex) { throw invalid(); }
    }

    private static ApiException invalid() { return new ApiException("UNAUTHENTICATED", 401, "Invalid username or password"); }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}
}
