package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.config.StrictHttpJsonConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * The account lifecycle HTTP contract with the real SecurityConfig filter chain, the real strict
 * Jackson mapper, disposable MySQL and a capturing mail sender (no real SMTP): per-path anonymous
 * whitelist, status/error codes, Cache-Control/Retry-After headers, registration switch, uniform
 * recovery, strict JSON and the revoke-old-token behavior after a password change.
 */
class AccountHttpContractTest {
    private static final String JWT_SECRET = "0123456789abcdef0123456789abcdef";
    private static final String CHALLENGE_SECRET = "test-only-challenge-secret-0123456789";
    private static final String CAPTCHA_ANSWER = "AB23C";
    private static final String MAIL_PASSWORD = "test-only-client-authorization-code";
    private static final PasswordService PASSWORDS = new PasswordService();

    private static final WebApplicationContextRunner RUNNER = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DispatcherServletAutoConfiguration.class,
            WebMvcAutoConfiguration.class, SecurityAutoConfiguration.class,
            JacksonAutoConfiguration.class, HttpMessageConvertersAutoConfiguration.class))
        .withUserConfiguration(StrictHttpJsonConfig.class, SecurityConfig.class, PasswordService.class,
            AuthServiceConfiguration.class, AuthController.class, GlobalExceptionHandler.class)
        .withPropertyValues(
            "MANAO_JWT_SECRET=" + JWT_SECRET,
            "manao.poc4.auth.auth-challenge-secret=" + CHALLENGE_SECRET,
            "manao.poc4.auth.registration-enabled=true",
            "manao.poc4.auth.mail.enabled=true",
            "manao.poc4.auth.mail.host=smtp.example.test",
            "manao.poc4.auth.mail.username=sender@example.test",
            "manao.poc4.auth.mail.from=sender@example.test",
            "manao.poc4.auth.mail.password=" + MAIL_PASSWORD);

    @Test
    void optionsCaptchaAndAnonymousWhitelistExposeOnlyTheDesignedSurface() throws Exception {
        run(new CapturingMail(), new String[0], (mvc, jdbc, mail) -> {
            mvc.perform(get("/api/v1/auth/options"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.registrationEnabled").value(true))
                .andExpect(jsonPath("$.emailAvailable").value(true))
                .andExpect(jsonPath("$.host").doesNotExist())
                .andExpect(jsonPath("$.password").doesNotExist());
            mvc.perform(get("/api/v1/auth/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
            mvc.perform(post("/api/v1/auth/password-change").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"currentPassword\":\"a\",\"newPassword\":\"b\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));

            MvcResult captcha = mvc.perform(get("/api/v1/auth/captcha"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.challengeId").isNotEmpty())
                .andExpect(jsonPath("$.expiresAt").isNotEmpty())
                .andReturn();
            String image = JsonPath.read(captcha.getResponse().getContentAsString(), "$.imageBase64");
            String png = Base64.getEncoder().encodeToString(
                javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(Base64.getDecoder().decode(image)))
                    == null ? new byte[0] : new byte[] {1});
            assertThat(png).isNotEmpty();
            // The response never carries the answer itself.
            assertThat(captcha.getResponse().getContentAsString()).doesNotContain(CAPTCHA_ANSWER);
        });
    }

    @Test
    void registrationFlowCreatesAVerifiedAccountWithoutTokenAndLoginMeWork() throws Exception {
        run(new CapturingMail(), new String[0], (mvc, jdbc, mail) -> {
            String email = "new@example.test";
            String challenge = requestRegisterCode(mvc, jdbc, email);
            assertThat(mail.codes).hasSize(1);

            MvcResult registered = mvc.perform(post("/api/v1/auth/register")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"New_User\",\"password\":\"new-password-123\",\"email\":\"" + email
                        + "\",\"emailChallengeId\":\"" + challenge + "\",\"emailCode\":\"" + mail.codes.get(0) + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.user.id").isNotEmpty())
                .andExpect(jsonPath("$.user.username").value("new_user"))
                .andExpect(jsonPath("$.accessToken").doesNotExist())
                .andReturn();
            assertThat(registered.getResponse().getContentAsString()).doesNotContain("accessToken");

            MvcResult login = mvc.perform(post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"new_user\",\"password\":\"new-password-123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accessToken").isNotEmpty())
                .andExpect(jsonPath("$.user.username").value("new_user"))
                .andExpect(jsonPath("$.user.email").value(email))
                .andExpect(jsonPath("$.user.emailVerified").value(true))
                .andReturn();
            String token = JsonPath.read(login.getResponse().getContentAsString(), "$.accessToken");
            mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value("new_user"))
                .andExpect(jsonPath("$.email").value(email))
                .andExpect(jsonPath("$.emailVerified").value(true));

            // Wrong current password is a 422 domain error, not a global 401 that would log out.
            mvc.perform(post("/api/v1/auth/password-change").header("Authorization", "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"currentPassword\":\"wrong\",\"newPassword\":\"another-password\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CURRENT_PASSWORD_INVALID"));
            mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());

            mvc.perform(post("/api/v1/auth/password-change").header("Authorization", "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"currentPassword\":\"new-password-123\",\"newPassword\":\"another-password\"}"))
                .andExpect(status().isNoContent());
            // The old token's version is stale now; Task 6 owns stream revocation.
            mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"new_user\",\"password\":\"another-password\"}"))
                .andExpect(status().isOk());
        });
    }

    @Test
    void registrationClosedAtSendAndSubmitWhileResetStaysUniform() throws Exception {
        run(new CapturingMail(), new String[] {"manao.poc4.auth.registration-enabled=false"}, (mvc, jdbc, mail) -> {
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"closed@example.test\","
                        + "\"captchaId\":\"x\",\"captchaAnswer\":\"AB23C\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("REGISTRATION_CLOSED"));
            mvc.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"closed_user\",\"password\":\"new-password-123\","
                        + "\"email\":\"closed@example.test\",\"emailChallengeId\":\"x\",\"emailCode\":\"654321\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("REGISTRATION_CLOSED"));

            // Recovery still runs and keeps the uniform accepted response for an unknown address.
            String captcha = insertCaptcha(jdbc, CAPTCHA_ANSWER);
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"RESET_PASSWORD\",\"email\":\"whoever@example.test\","
                        + "\"captchaId\":\"" + captcha + "\",\"captchaAnswer\":\"AB23C\"}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.challengeId").isNotEmpty())
                .andExpect(jsonPath("$.retryAfterSeconds").value(60));
            assertThat(mail.codes).isEmpty();
            assertThat(mail.attempts).isZero();
        });
    }

    @Test
    void mailNotConfiguredIs503ForEveryAddressBeforeAnyLookup() throws Exception {
        run(new CapturingMail(), new String[] {"manao.poc4.auth.mail.enabled=false"}, (mvc, jdbc, mail) -> {
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"RESET_PASSWORD\",\"email\":\"nobody@example.test\","
                        + "\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER) + "\",\"captchaAnswer\":\"AB23C\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("MAIL_NOT_CONFIGURED"));
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"nobody@example.test\","
                        + "\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER) + "\",\"captchaAnswer\":\"AB23C\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("MAIL_NOT_CONFIGURED"));
        });
    }

    @Test
    void challengeErrorsUseFixedCodesAndRealRetryAfterWaits() throws Exception {
        run(new CapturingMail(), new String[0], (mvc, jdbc, mail) -> {
            // Wrong captcha answer: fixed 422.
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"errors@example.test\","
                        + "\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER) + "\",\"captchaAnswer\":\"ZZZZZ\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CAPTCHA_INVALID"));

            // Successful send then the real 60 s cooldown: 429 with Retry-After.
            requestRegisterCode(mvc, jdbc, "cooldown@example.test");
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"cooldown@example.test\","
                        + "\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER) + "\",\"captchaAnswer\":\"AB23C\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Retry-After", "60"))
                .andExpect(jsonPath("$.code").value("AUTH_RATE_LIMITED"));

            // Register SMTP failure surfaces 503 MAIL_SEND_FAILED (reset stays uniform).
            mail.failure = new RuntimeException("smtp unavailable at fake.test");
            MvcResult failed = mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"fail@example.test\","
                        + "\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER) + "\",\"captchaAnswer\":\"AB23C\"}"))
                .andReturn();
            assertThat(failed.getResponse().getStatus())
                .as("register mail failure response: " + failed.getResponse().getContentAsString())
                .isEqualTo(503);
            assertThat(failed.getResponse().getContentAsString()).contains("MAIL_SEND_FAILED");

            // The per-address captcha limiter also reports a real Retry-After.
            for (int i = 0; i < 10; i++) {
                mvc.perform(get("/api/v1/auth/captcha")).andExpect(status().isOk());
            }
            mvc.perform(get("/api/v1/auth/captcha"))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Retry-After", "60"))
                .andExpect(jsonPath("$.code").value("AUTH_RATE_LIMITED"));

            // Unknown JSON fields are rejected on the new endpoints.
            mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"purpose\":\"REGISTER_EMAIL\",\"email\":\"a@example.test\","
                        + "\"captchaId\":\"x\",\"captchaAnswer\":\"AB23C\",\"extra\":\"leak\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        });
    }

    @Test
    void passwordResetIsUniformAndRevokesTheOldToken() throws Exception {
        run(new CapturingMail(), new String[0], (mvc, jdbc, mail) -> {
            insertUser(jdbc, "reset-id", "reset_user", "reset@example.test", "old-password", 0);
            MvcResult oldLogin = mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"reset_user\",\"password\":\"old-password\"}"))
                .andExpect(status().isOk()).andReturn();
            String oldToken = JsonPath.read(oldLogin.getResponse().getContentAsString(), "$.accessToken");

            String challenge = requestResetCode(mvc, jdbc, "reset@example.test");
            String code = mail.codes.get(mail.codes.size() - 1);

            // Wrong code and unknown address produce the same fixed error.
            mvc.perform(post("/api/v1/auth/password-reset").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"email\":\"reset@example.test\",\"emailChallengeId\":\"" + challenge
                        + "\",\"emailCode\":\"000000\",\"newPassword\":\"brand-new-password\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"));
            mvc.perform(post("/api/v1/auth/password-reset").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"email\":\"nobody@example.test\",\"emailChallengeId\":\"missing\","
                        + "\"emailCode\":\"000000\",\"newPassword\":\"brand-new-password\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("EMAIL_CODE_INVALID"));

            mvc.perform(post("/api/v1/auth/password-reset").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"email\":\"reset@example.test\",\"emailChallengeId\":\"" + challenge
                        + "\",\"emailCode\":\"" + code + "\",\"newPassword\":\"brand-new-password\"}"))
                .andExpect(status().isNoContent());
            mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + oldToken))
                .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"reset_user\",\"password\":\"old-password\"}"))
                .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"reset_user\",\"password\":\"brand-new-password\"}"))
                .andExpect(status().isOk());
        });
    }

    // --- helpers --------------------------------------------------------------------------

    private static String requestRegisterCode(MockMvc mvc, JdbcTemplate jdbc, String email) throws Exception {
        return requestCode(mvc, jdbc, "REGISTER_EMAIL", email);
    }

    private static String requestResetCode(MockMvc mvc, JdbcTemplate jdbc, String email) throws Exception {
        return requestCode(mvc, jdbc, "RESET_PASSWORD", email);
    }

    private static String requestCode(MockMvc mvc, JdbcTemplate jdbc, String purpose, String email)
        throws Exception {
        MvcResult result = mvc.perform(post("/api/v1/auth/email-codes").contentType(MediaType.APPLICATION_JSON)
                .content("{\"purpose\":\"" + purpose + "\",\"email\":\"" + email
                    + "\",\"captchaId\":\"" + insertCaptcha(jdbc, CAPTCHA_ANSWER)
                    + "\",\"captchaAnswer\":\"AB23C\"}"))
            .andReturn();
        String body = result.getResponse().getContentAsString();
        assertThat(result.getResponse().getStatus())
            .as("email-codes (%s, %s) response: %s retryAfter=%s", purpose, email, body,
                result.getResponse().getHeader("Retry-After"))
            .isEqualTo(202);
        assertThat(result.getResponse().getHeader("Cache-Control")).isEqualTo("no-store");
        return JsonPath.read(body, "$.challengeId");
    }

    @FunctionalInterface
    private interface ContextAction {
        void run(MockMvc mvc, JdbcTemplate jdbc, CapturingMail mail) throws Exception;
    }

    private static void run(CapturingMail mail, String[] extraProperties, ContextAction action) {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            var runner = RUNNER.withBean(JdbcTemplate.class, () -> jdbc)
                .withBean(VerificationMailSender.class, () -> mail);
            if (extraProperties.length > 0) {
                runner = runner.withPropertyValues(extraProperties);
            }
            runner.run(context -> {
                MockMvc mvc = MockMvcBuilders.webAppContextSetup((WebApplicationContext) context)
                    .addFilters(context.getBean(FilterChainProxy.class))
                    .build();
                action.run(mvc, jdbc, mail);
            });
        }
    }

    private static String insertCaptcha(JdbcTemplate jdbc, String answer) {
        String id = UUID.randomUUID().toString().replace("-", "");
        Timestamp now = Timestamp.from(Instant.now());
        jdbc.update("""
            INSERT INTO auth_challenge(id, purpose, email, user_id, auth_version_snapshot, answer_mac, state,
                expires_at, attempts, next_send_at, window_started_at, window_send_count, created_at, updated_at)
            VALUES (?, 'CAPTCHA', NULL, NULL, NULL, ?, 'ACTIVE', ?, 0, NULL, NULL, 0, ?, ?)
            """, id, mac(id, "CAPTCHA", null, answer),
            Timestamp.from(Instant.now().plusSeconds(120)), now, now);
        return id;
    }

    private static void insertUser(JdbcTemplate jdbc, String id, String username, String email,
                                   String rawPassword, long authVersion) {
        Timestamp now = Timestamp.from(Instant.now());
        jdbc.update("""
            INSERT INTO app_user(id, username, password_hash, enabled, email, email_verified_at,
                auth_version, created_at)
            VALUES (?, ?, ?, TRUE, ?, ?, ?, ?)
            """, id, username, PASSWORDS.hash(rawPassword), email, now, authVersion, now);
    }

    private static String mac(String id, String purpose, String email, String answer) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(CHALLENGE_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String material = id + "|" + purpose + "|" + (email == null ? "" : email) + "|" + answer;
            return java.util.HexFormat.of().formatHex(mac.doFinal(material.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    /** Capturing sender: no SMTP is ever contacted, and a failure can be simulated. */
    private static final class CapturingMail implements VerificationMailSender {
        private final List<String> codes = new ArrayList<>();
        private int attempts;
        private RuntimeException failure;

        @Override
        public void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
            attempts++;
            if (failure != null) throw failure;
            codes.add(code);
        }
    }
}
