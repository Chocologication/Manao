package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

/**
 * Login reuses the existing BCrypt verification but reads the account through
 * {@link UserStore}, signs the CURRENT auth_version, and exposes only the nullable email
 * display fields on top of the existing response shape.
 */
class AuthControllerTest {
    private static final String SECRET = "a".repeat(32);
    private static final String HEADER_JSON = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    private static final PasswordService PASSWORDS = new PasswordService();
    private static final String CORRECT_HASH = PASSWORDS.hash("correct");
    private static final JwtService JWT = new JwtService(SECRET, Duration.ofMinutes(15));

    @Test
    void legacyAccountLoginReturnsACurrentVersionTokenAndNullEmailDisplay() {
        UserStore users = mock(UserStore.class);
        when(users.findByUsername("alice")).thenReturn(Optional.of(
            new UserStore.UserAccount("alice-id", "alice", CORRECT_HASH, true, null, null, 5)));
        AuthController controller = new AuthController(JWT, PASSWORDS, users);

        Map<String, Object> response = controller.login(new AuthController.LoginRequest("alice", "correct"));

        assertThat(response).containsOnlyKeys("accessToken", "expiresAt", "user");
        Map<String, Object> user = userOf(response);
        assertThat(user).containsOnlyKeys("id", "username", "email", "emailVerified");
        assertThat(user.get("id")).isEqualTo("alice-id");
        assertThat(user.get("username")).isEqualTo("alice");
        assertThat(user.get("email")).isNull();
        assertThat(user.get("emailVerified")).isEqualTo(false);
        assertThat(user.values()).doesNotContain(CORRECT_HASH);
        // Login signs the version read from the database, not a hard-coded zero.
        JwtService.Claims claims = JWT.parse((String) response.get("accessToken"));
        assertThat(claims.subject()).isEqualTo("alice-id");
        assertThat(claims.authVersion()).isEqualTo(5);
    }

    @Test
    void verifiedEmailIsDisplayedOnTheLoginUser() {
        Instant verifiedAt = Instant.parse("2026-04-05T06:07:08Z");
        UserStore users = mock(UserStore.class);
        when(users.findByUsername("bob")).thenReturn(Optional.of(new UserStore.UserAccount(
            "bob-id", "bob", CORRECT_HASH, true, "bob@example.com", verifiedAt, 0)));
        AuthController controller = new AuthController(JWT, PASSWORDS, users);

        Map<String, Object> user = userOf(controller.login(new AuthController.LoginRequest("bob", "correct")));

        assertThat(user.get("email")).isEqualTo("bob@example.com");
        assertThat(user.get("emailVerified")).isEqualTo(true);
    }

    @Test
    void wrongPasswordUnknownUserAndDisabledAccountShareTheGenericUnauthenticatedError() {
        UserStore users = mock(UserStore.class);
        when(users.findByUsername("alice")).thenReturn(Optional.of(
            new UserStore.UserAccount("alice-id", "alice", CORRECT_HASH, true, null, null, 0)));
        when(users.findByUsername("disabled")).thenReturn(Optional.of(
            new UserStore.UserAccount("disabled-id", "disabled", CORRECT_HASH, false, null, null, 0)));
        when(users.findByUsername("unknown")).thenReturn(Optional.empty());
        AuthController controller = new AuthController(JWT, PASSWORDS, users);

        for (AuthController.LoginRequest request : new AuthController.LoginRequest[] {
            new AuthController.LoginRequest("alice", "wrong"),
            new AuthController.LoginRequest("unknown", "correct"),
            new AuthController.LoginRequest("disabled", "correct")}) {
            assertThatThrownBy(() -> controller.login(request)).isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.code()).isEqualTo("UNAUTHENTICATED");
                assertThat(error.status()).isEqualTo(401);
                assertThat(error.getMessage()).isEqualTo("Invalid username or password");
            });
        }
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
        // Sanity: the signed valid single object is accepted.
        assertThat(JWT.parse(signedToken(valid)).authVersion()).isZero();

        // Content after the JSON object must not be ignored.
        assertThatThrownBy(() -> JWT.parse(signedToken(valid + "{}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(valid + "{\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        // A duplicate claim is an error, even when one of the values would be valid.
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":-1,\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":\"bad\",\"ver\":0}")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> JWT.parse(signedToken(
            "{\"sub\":\"opaque-user\",\"exp\":" + future + ",\"ver\":0,\"ver\":-1}")))
            .isInstanceOf(IllegalArgumentException.class);
        // The parsed subject follows the same ID contract as issue().
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> userOf(Map<String, Object> response) {
        return (Map<String, Object>) response.get("user");
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
