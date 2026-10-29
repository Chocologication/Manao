package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Login keeps the existing BCrypt verification and generic 401 contract, but reads the account
 * through {@link UserStore} and signs the CURRENT auth_version, so a password change revokes old
 * tokens. The email verification / registration endpoints arrive in later tasks; no captcha is
 * required for login.
 */
@RestController
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/auth")
public final class AuthController {
    private final JwtService jwt;
    private final PasswordService passwords;
    private final UserStore users;

    public AuthController(JwtService jwt, PasswordService passwords, UserStore users) {
        this.jwt = jwt;
        this.passwords = passwords;
        this.users = users;
    }

    @PostMapping("/login")
    public Map<String, Object> login(@Valid @RequestBody LoginRequest request) {
        UserStore.UserAccount user = users.findByUsername(request.username())
            .filter(UserStore.UserAccount::enabled)
            .filter(account -> passwords.matches(request.password(), account.passwordHash()))
            .orElseThrow(AuthController::invalid);
        JwtService.IssuedToken token = jwt.issue(user.id(), user.authVersion());
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", user.id());
        view.put("username", user.username());
        view.put("email", user.email());
        view.put("emailVerified", user.emailVerifiedAt() != null);
        return Map.of("accessToken", token.accessToken(), "expiresAt", token.expiresAt().toString(),
            "user", view);
    }

    private static ApiException invalid() {
        return new ApiException("UNAUTHENTICATED", 401, "Invalid username or password");
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}
}
