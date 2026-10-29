package com.manao.poc4.auth;

import com.manao.poc4.api.ApiError;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.SecurityConfig;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.context.annotation.Conditional;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Account lifecycle HTTP layer (design sections 5 and 9). Thin: every transaction/validation rule
 * lives in {@link AuthService}, {@link EmailVerificationService} and {@link CaptchaService}. The
 * anonymous whitelist is enumerated per path in SecurityConfig; challenge responses are
 * Cache-Control: no-store, and a real rate limit carries its true Retry-After wait. Login never
 * needs a captcha; the registration switch is enforced both for the email-code request and the
 * final submit.
 */
@RestController
@Conditional(SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/auth")
public final class AuthController {
    private static final String NO_STORE = "no-store";

    private final AuthService auth;
    private final CaptchaService captcha;
    private final EmailVerificationService emailCodes;
    private final AuthProperties properties;

    public AuthController(AuthService auth, CaptchaService captcha,
                          EmailVerificationService emailCodes, AuthProperties properties) {
        this.auth = auth;
        this.captcha = captcha;
        this.emailCodes = emailCodes;
        this.properties = properties;
    }

    @GetMapping("/options")
    public AuthContracts.OptionsResponse options() {
        return new AuthContracts.OptionsResponse(properties.registrationEnabled(),
            properties.mail().configured());
    }

    @PostMapping("/login")
    public AuthContracts.LoginResponse login(@Valid @RequestBody AuthContracts.LoginRequest request) {
        return auth.login(request);
    }

    /** Anonymous image captcha; the caller address comes from the servlet container. */
    @GetMapping("/captcha")
    public ResponseEntity<?> captcha(HttpServletRequest request) {
        try {
            return ResponseEntity.ok()
                .header("Cache-Control", NO_STORE)
                .body(captcha.issue(request.getRemoteAddr()));
        } catch (AuthContracts.RateLimitedException ex) {
            return rateLimited(ex);
        }
    }

    @PostMapping("/email-codes")
    public ResponseEntity<?> emailCodes(@Valid @RequestBody AuthContracts.EmailCodeRequest request) {
        if (request.purpose() == AuthContracts.EmailPurpose.REGISTER_EMAIL
            && !properties.registrationEnabled()) {
            throw new ApiException("REGISTRATION_CLOSED", 403, "Registration is closed");
        }
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("Cache-Control", NO_STORE)
                .body(emailCodes.request(request));
        } catch (AuthContracts.RateLimitedException ex) {
            return rateLimited(ex);
        }
    }

    /** 201 {user:{id,username}} only: no token and no auto-login. */
    @PostMapping("/register")
    public ResponseEntity<Map<String, Object>> register(
            @Valid @RequestBody AuthContracts.RegisterRequest request) {
        AuthContracts.RegisteredUser user = auth.register(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("user", user));
    }

    @PostMapping("/password-reset")
    public ResponseEntity<Void> passwordReset(
            @Valid @RequestBody AuthContracts.PasswordResetRequest request) {
        auth.resetPassword(request);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/password-change")
    public ResponseEntity<Void> passwordChange(
            @AuthenticationPrincipal AuthContracts.AccountIdentity identity,
            @Valid @RequestBody AuthContracts.PasswordChangeRequest request) {
        auth.changePassword(identity, request);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me")
    public AuthContracts.UserView me(@AuthenticationPrincipal AuthContracts.AccountIdentity identity) {
        return auth.me(identity);
    }

    /** Real Retry-After for a challenge rate limit; the body keeps the ApiError contract. */
    private static ResponseEntity<ApiError> rateLimited(AuthContracts.RateLimitedException ex) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
            .header("Retry-After", Long.toString(ex.retryAfterSeconds()))
            .header("Cache-Control", NO_STORE)
            .body(new ApiError("AUTH_RATE_LIMITED", null, null));
    }
}
