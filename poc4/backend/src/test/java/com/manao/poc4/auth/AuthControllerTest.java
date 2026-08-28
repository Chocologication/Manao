package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;

class AuthControllerTest {
    @Test
    void validLoginReturnsOnlyAccessTokenExpiryAndUser() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForMap(any(String.class), eq("alice"))).thenReturn(Map.of(
            "id", "alice-id", "username", "alice", "password_hash", new PasswordService().hash("correct"), "enabled", true));
        AuthController controller = new AuthController(new JwtService("a".repeat(32), Duration.ofMinutes(15)),
            new PasswordService(), jdbc);

        Map<String, Object> response = controller.login(new AuthController.LoginRequest("alice", "correct"));

        assertThat(response).containsOnlyKeys("accessToken", "expiresAt", "user");
        assertThat(response.get("user")).isEqualTo(Map.of("id", "alice-id", "username", "alice"));
        assertThat(response.get("accessToken")).isInstanceOf(String.class);
    }

    @Test
    void wrongPasswordUsesGenericUnauthenticatedError() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForMap(any(String.class), eq("alice"))).thenReturn(Map.of(
            "id", "alice-id", "username", "alice", "password_hash", new PasswordService().hash("correct"), "enabled", true));
        AuthController controller = new AuthController(new JwtService("a".repeat(32), Duration.ofMinutes(15)),
            new PasswordService(), jdbc);

        assertThatThrownBy(() -> controller.login(new AuthController.LoginRequest("alice", "wrong")))
            .hasMessage("Invalid username or password");
    }

    @Test
    void jwtRejectsExpiredAndMalformedTokens() {
        JwtService expired = new JwtService("a".repeat(32), Duration.ofSeconds(-1));
        String token = expired.issue("opaque-user").accessToken();
        JwtService verifier = new JwtService("a".repeat(32), Duration.ofMinutes(15));
        assertThatThrownBy(() -> verifier.parse(token)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> verifier.parse("not.a.jwt")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void loginRequestRejectsUnknownFields() {
        assertThatThrownBy(() -> new ObjectMapper().readValue("{\"username\":\"alice\",\"password\":\"x\",\"token\":\"leak\"}", AuthController.LoginRequest.class))
            .isInstanceOf(Exception.class);
    }
}
