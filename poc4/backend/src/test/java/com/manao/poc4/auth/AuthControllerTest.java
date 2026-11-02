package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.manao.poc4.api.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The thin HTTP controller over {@link AuthService}/{@link CaptchaService}/
 * {@link EmailVerificationService}: delegation, anonymous config switches, no-store challenge
 * responses, the fixed registration-closed refusal and the JWT parsing contract. Behaviour
 * itself is covered by AccountLifecycleTest/AccountHttpContractTest; this class pins the layer
 * boundaries and keeps the token tests.
 */
class AuthControllerTest {
    private static final String SECRET = "a".repeat(32);
    private static final String HEADER_JSON = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    private static final AuthProperties PROPERTIES = new AuthProperties(true, SECRET,
        new AuthProperties.Mail(true, "smtp.example.test", 465, "sender@example.test",
            "sender@example.test", "ssl", "test-only-client-authorization-code",
            Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)),
        new AuthProperties.Challenge(Duration.ofMinutes(2), 5, 1000, 10,
            Duration.ofMinutes(10), 5, Duration.ofSeconds(60), 5));
    private static final JwtService JWT = new JwtService(SECRET, Duration.ofMinutes(15));

    @Test
    void loginDelegatesAndKeepsTheExistingResponseShape() {
        AuthService auth = mock(AuthService.class);
        Instant expiresAt = Instant.parse("2026-10-29T13:00:00Z");
        when(auth.login(any())).thenReturn(new AuthContracts.LoginResponse("signed-token", expiresAt,
            new AuthContracts.UserView("alice-id", "alice", null, false)));
        AuthController controller = controller(auth);

        AuthContracts.LoginResponse response =
            controller.login(new AuthContracts.LoginRequest("alice", "correct"));

        assertThat(response.accessToken()).isEqualTo("signed-token");
        assertThat(response.expiresAt()).isEqualTo(expiresAt);
        assertThat(response.user().id()).isEqualTo("alice-id");
        assertThat(response.user().username()).isEqualTo("alice");
        assertThat(response.user().email()).isNull();
        assertThat(response.user().emailVerified()).isFalse();
        verify(auth).login(new AuthContracts.LoginRequest("alice", "correct"));
    }

    @Test
    void optionsExposeOnlyTheTwoSwitches() {
        AuthController enabled = controller(mock(AuthService.class));
        assertThat(enabled.options()).isEqualTo(new AuthContracts.OptionsResponse(true, true));

        AuthProperties disabled = new AuthProperties(false, SECRET,
            new AuthProperties.Mail(false, "", 465, "", "", "ssl", "",
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)), null);
        AuthController disabledController = new AuthController(mock(AuthService.class),
            mock(CaptchaService.class), mock(EmailVerificationService.class), disabled);
        assertThat(disabledController.options()).isEqualTo(new AuthContracts.OptionsResponse(false, false));
    }

    @Test
    void captchaResponseIsNoStoreAndRateLimitsCarryRetryAfter() {
        CaptchaService captcha = mock(CaptchaService.class);
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRemoteAddr()).thenReturn("203.0.113.9");
        Instant expiresAt = Instant.parse("2026-10-29T13:00:00Z");
        when(captcha.issue("203.0.113.9")).thenReturn(
            new AuthContracts.CaptchaResponse("challenge", "cG5n", expiresAt));
        AuthController controller = new AuthController(mock(AuthService.class), captcha,
            mock(EmailVerificationService.class), PROPERTIES);

        ResponseEntity<?> ok = controller.captcha(request);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getHeaders().getCacheControl()).isEqualTo("no-store");
        assertThat(ok.getBody()).isEqualTo(new AuthContracts.CaptchaResponse("challenge", "cG5n", expiresAt));

        when(captcha.issue("203.0.113.9")).thenThrow(
            new AuthContracts.RateLimitedException(60));
        ResponseEntity<?> limited = controller.captcha(request);
        assertThat(limited.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(limited.getHeaders().getFirst("Retry-After")).isEqualTo("60");
        assertThat(limited.getBody()).isInstanceOf(com.manao.poc4.api.ApiError.class);
        assertThat(((com.manao.poc4.api.ApiError) limited.getBody()).code()).isEqualTo("AUTH_RATE_LIMITED");
    }

    @Test
    void emailCodesRejectRegistrationPurposeWhenRegistrationIsClosed() {
        EmailVerificationService emailCodes = mock(EmailVerificationService.class);
        AuthController closed = controller(mock(AuthService.class), emailCodes, PROPERTIES, false);

        assertThatThrownBy(() -> closed.emailCodes(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "a@example.test", "captcha", "AB23C")))
            .isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.code()).isEqualTo("REGISTRATION_CLOSED");
                assertThat(error.status()).isEqualTo(403);
            });
        org.mockito.Mockito.verifyNoInteractions(emailCodes);
    }

    @Test
    void emailCodeResponseIsAcceptedAndNoStore() {
        EmailVerificationService emailCodes = mock(EmailVerificationService.class);
        Instant expiresAt = Instant.parse("2026-10-29T13:00:00Z");
        when(emailCodes.request(any())).thenReturn(
            new AuthContracts.EmailCodeResponse("challenge", expiresAt, 60));
        AuthController controller = controller(mock(AuthService.class), emailCodes, PROPERTIES, true);

        ResponseEntity<?> response = controller.emailCodes(new AuthContracts.EmailCodeRequest(
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "a@example.test", "captcha", "AB23C"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(response.getHeaders().getCacheControl()).isEqualTo("no-store");
        assertThat(response.getBody()).isEqualTo(new AuthContracts.EmailCodeResponse("challenge", expiresAt, 60));
    }

    @Test
    void registerResetChangeAndMeDelegateToTheService() {
        AuthService auth = mock(AuthService.class);
        when(auth.register(any())).thenReturn(new AuthContracts.RegisteredUser("user-id", "new_user"));
        AuthController controller = controller(auth);
        var register = new AuthContracts.RegisterRequest("new_user", "new-password-123",
            "new@example.test", "challenge", "654321");

        ResponseEntity<Map<String, Object>> registered = controller.register(register);
        assertThat(registered.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(registered.getBody()).containsEntry("user",
            new AuthContracts.RegisteredUser("user-id", "new_user"));

        var reset = new AuthContracts.PasswordResetRequest("new@example.test",
            "challenge", "654321", "another-password");
        assertThat(controller.passwordReset(reset).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(auth).resetPassword(reset);

        var identity = new AuthContracts.AccountIdentity("user-id", 2);
        var change = new AuthContracts.PasswordChangeRequest("old-password", "another-password");
        assertThat(controller.passwordChange(identity, change).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(auth).changePassword(eq(identity), eq(change));

        when(auth.me(identity)).thenReturn(new AuthContracts.UserView("user-id", "new_user",
            "new@example.test", true));
        assertThat(controller.me(identity).emailVerified()).isTrue();
    }

    @Test
    void jwtRejectsExpiredMalformedAndVersionlessTokens() {
        JwtService expired = new JwtService(SECRET, Duration.ofSeconds(-1));
        assertThatThrownBy(() -> JWT.parse(expired.issue("opaque-user", 0).accessToken()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse("not.a.jwt")).isInstanceOf(IllegalArgumentException.class);
        long future = Instant.now().plusSeconds(600).getEpochSecond();
        String versionless = signedToken("{\"sub\":\"opaque-user\",\"exp\":" + future + "}");
        assertThatThrownBy(() -> JWT.parse(versionless)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void jwtParseRejectsTrailingContentDuplicateClaimsAndInvalidSubjectIds() {
        long future = Instant.now().plusSeconds(600).getEpochSecond();
        String valid = "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":0}";
        assertThat(JWT.parse(signedToken(valid)).authVersion()).isZero();
        assertThatThrownBy(() -> JWT.parse(signedToken(valid + "{}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(valid + "{\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":-1,\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":\"bad\",\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":0,\"ver\":-1}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"bad user\",\"exp\":" + future + ",\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"\",\"exp\":" + future + ",\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void jwtIssueRejectsInvalidUserIdsAndNegativeVersions() {
        assertThatThrownBy(() -> JWT.issue("user\"\\path", 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.issue("alice", -1)).isInstanceOf(IllegalArgumentException.class);
    }

    private static AuthController controller(AuthService auth) {
        return controller(auth, mock(EmailVerificationService.class), PROPERTIES, true);
    }

    private static AuthController controller(AuthService auth, EmailVerificationService emailCodes,
                                             AuthProperties properties, boolean registrationEnabled) {
        AuthProperties effective = registrationEnabled ? properties
            : new AuthProperties(false, properties.authChallengeSecret(), properties.mail(), properties.challenge());
        return new AuthController(auth, mock(CaptchaService.class), emailCodes, effective);
    }

    /** Signs an arbitrary payload with the fixture secret to build pre-version tokens. */
    private static String signedToken(String payloadJson) {
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
}
