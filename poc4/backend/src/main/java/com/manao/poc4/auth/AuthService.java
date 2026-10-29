package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.SecurityConfig;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Account lifecycle transactions for registration, login, password reset and password change
 * (design sections 5, 6 and 8). The HTTP controller stays thin; all validation transactions and
 * fixed error mapping live here.
 *
 * <p>Registration consumes the REGISTER_EMAIL challenge and inserts the account in ONE
 * transaction, so no user row exists before success and a username conflict leaves the still-valid
 * email code consumable (the pre-checks run before the consume; a unique-key race rolls the whole
 * transaction back). Password reset consumes the RESET_PASSWORD challenge (bound to the issuing
 * user id + auth_version) and applies the password update with the same conditional version check
 * in that transaction. Password change requires the current password (legacy accounts included)
 * and updates only while the request's auth_version is still current, never overwriting a newer
 * password. Stream revocation stays in Task 6; here old tokens stop authorizing because the
 * existing per-request auth_version check fails.
 */
public final class AuthService {
    private final JdbcTemplate jdbc;
    private final UserStore users;
    private final PasswordService passwords;
    private final JwtService jwt;
    private final AuthChallengeStore challenges;
    private final AuthProperties properties;

    public AuthService(JdbcTemplate jdbc, UserStore users, PasswordService passwords, JwtService jwt,
                       AuthChallengeStore challenges, AuthProperties properties) {
        if (jdbc == null) throw new IllegalArgumentException("jdbc template required");
        if (users == null) throw new IllegalArgumentException("user store required");
        if (passwords == null) throw new IllegalArgumentException("password service required");
        if (jwt == null) throw new IllegalArgumentException("jwt service required");
        if (challenges == null) throw new IllegalArgumentException("challenge store required");
        if (properties == null) throw new IllegalArgumentException("auth properties required");
        this.jdbc = jdbc;
        this.users = users;
        this.passwords = passwords;
        this.jwt = jwt;
        this.challenges = challenges;
        this.properties = properties;
    }

    /** Existing login contract: generic 401, no captcha, signs the CURRENT auth_version. */
    public AuthContracts.LoginResponse login(AuthContracts.LoginRequest request) {
        if (request == null) throw unauthenticated();
        UserStore.UserAccount account = users.findByUsername(request.username())
            .filter(UserStore.UserAccount::enabled)
            .filter(candidate -> passwords.matches(request.password(), candidate.passwordHash()))
            .orElseThrow(AuthService::unauthenticated);
        JwtService.IssuedToken token = jwt.issue(account.id(), account.authVersion());
        return new AuthContracts.LoginResponse(token.accessToken(), token.expiresAt(), view(account));
    }

    /**
     * Creates the account only after consuming the confirmed email code in the same transaction.
     * Username/email conflicts are detected before the consume so the rename-and-resubmit flow
     * keeps the valid code; no token is returned and no account is auto-logged-in.
     */
    public AuthContracts.RegisteredUser register(AuthContracts.RegisterRequest request) {
        if (!properties.registrationEnabled()) throw registrationClosed();
        if (request == null) throw validationError();
        String username = normalizedUsername(request.username());
        String passwordHash = passwords.hash(normalizedNewPassword(request.password()));
        String email = normalizedEmail(request.email());
        Instant now = challenges.clock().instant();
        RegisterOutcome outcome;
        try {
            outcome = challenges.inTransaction(status -> registerInTransaction(
                username, passwordHash, email, request.emailChallengeId(), request.emailCode(), now));
        } catch (RegistrationConflictException race) {
            // A unique-key race after the pre-check rolled the consume back with the transaction.
            throw users.findByUsername(username).isPresent() ? usernameTaken() : emailTaken();
        }
        if (outcome.error() != null) throw outcome.error();
        return outcome.registered();
    }

    private RegisterOutcome registerInTransaction(String username, String passwordHash, String email,
                                                  String challengeId, String code, Instant now) {
        if (users.findByUsername(username).isPresent()) return RegisterOutcome.failure(usernameTaken());
        if (users.findByEmail(email).isPresent()) return RegisterOutcome.failure(emailTaken());
        AuthChallengeStore.VerifyResult verified = challenges.verifyAndConsume(
            challengeId, AuthContracts.EmailPurpose.REGISTER_EMAIL, email, code);
        if (!verified.consumed()) return RegisterOutcome.failure(emailCodeInvalid());
        String userId = UUID.randomUUID().toString();
        try {
            users.insertRegisteredAccount(userId, username, passwordHash, email, now);
        } catch (DuplicateKeyException ex) {
            throw new RegistrationConflictException();
        }
        return RegisterOutcome.success(new AuthContracts.RegisteredUser(userId, username));
    }

    /**
     * Uniform password recovery: unknown email, unverified/disabled account, wrong/expired code and
     * a concurrent password version change all produce the same EMAIL_CODE_INVALID error. Only the
     * version-bound code of a bound, verified, enabled account can update the password, and the
     * consume + conditional update commit together.
     */
    public void resetPassword(AuthContracts.PasswordResetRequest request) {
        if (request == null) throw validationError();
        String email = normalizedEmail(request.email());
        String passwordHash = passwords.hash(normalizedNewPassword(request.newPassword()));
        Boolean updated = challenges.inTransaction(status -> {
            AuthChallengeStore.VerifyResult verified = challenges.verifyAndConsume(
                request.emailChallengeId(), AuthContracts.EmailPurpose.RESET_PASSWORD, email,
                request.emailCode());
            if (!verified.consumed()) return false;
            return users.updatePassword(verified.userId(), passwordHash,
                verified.authVersionSnapshot()) == 1;
        });
        if (!Boolean.TRUE.equals(updated)) throw emailCodeInvalid();
    }

    /**
     * Authenticated password change: currentPassword keeps the historical contract (legacy short
     * passwords still work), the NEW password follows the new rule, and the conditional UPDATE
     * includes the request's auth_version. A stale/concurrent request is refused with 401 without
     * overwriting the newer password; no replacement token is issued.
     */
    public void changePassword(AuthContracts.AccountIdentity identity,
                               AuthContracts.PasswordChangeRequest request) {
        if (identity == null || request == null) throw validationError();
        String newPassword = normalizedNewPassword(request.newPassword());
        UserStore.UserAccount account = users.findById(identity.userId())
            .filter(UserStore.UserAccount::enabled)
            .orElseThrow(AuthService::staleAuthentication);
        if (!passwords.matches(request.currentPassword(), account.passwordHash())) {
            throw currentPasswordInvalid();
        }
        String passwordHash = passwords.hash(newPassword);
        if (users.updatePassword(identity.userId(), passwordHash, identity.authVersion()) != 1) {
            throw staleAuthentication();
        }
    }

    /** GET /me for the authenticated identity; the filter already verified the account version. */
    public AuthContracts.UserView me(AuthContracts.AccountIdentity identity) {
        if (identity == null) throw staleAuthentication();
        UserStore.UserAccount account = users.findById(identity.userId())
            .filter(UserStore.UserAccount::enabled)
            .orElseThrow(AuthService::staleAuthentication);
        return view(account);
    }

    private static AuthContracts.UserView view(UserStore.UserAccount account) {
        return new AuthContracts.UserView(account.id(), account.username(), account.email(),
            account.emailVerifiedAt() != null);
    }

    // --- validation / error mapping -------------------------------------------------------

    private static String normalizedUsername(String raw) {
        try {
            return AuthContracts.normalizeUsername(raw);
        } catch (IllegalArgumentException ex) {
            throw validationError();
        }
    }

    private static String normalizedEmail(String raw) {
        try {
            return AuthContracts.normalizeEmail(raw);
        } catch (IllegalArgumentException ex) {
            throw validationError();
        }
    }

    private static String normalizedNewPassword(String raw) {
        try {
            return AuthContracts.validateNewPassword(raw);
        } catch (IllegalArgumentException ex) {
            throw validationError();
        }
    }

    private static ApiException validationError() {
        return new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    private static ApiException unauthenticated() {
        return new ApiException("UNAUTHENTICATED", 401, "Invalid username or password");
    }

    private static ApiException staleAuthentication() {
        return new ApiException("UNAUTHENTICATED", 401, "Authentication required");
    }

    private static ApiException usernameTaken() {
        return new ApiException("USERNAME_TAKEN", 409, "Username is already taken");
    }

    private static ApiException emailTaken() {
        return new ApiException("EMAIL_TAKEN", 409, "Email is already registered");
    }

    private static ApiException emailCodeInvalid() {
        return new ApiException("EMAIL_CODE_INVALID", 422, "Email verification code is invalid or expired");
    }

    private static ApiException currentPasswordInvalid() {
        return new ApiException("CURRENT_PASSWORD_INVALID", 422, "Current password is invalid");
    }

    private static ApiException registrationClosed() {
        return new ApiException("REGISTRATION_CLOSED", 403, "Registration is closed");
    }

    private record RegisterOutcome(AuthContracts.RegisteredUser registered, ApiException error) {
        static RegisterOutcome success(AuthContracts.RegisteredUser registered) {
            return new RegisterOutcome(registered, null);
        }

        static RegisterOutcome failure(ApiException error) {
            return new RegisterOutcome(null, error);
        }
    }

    /** Unique-key race after the pre-check: rolled back with the transaction. */
    private static final class RegistrationConflictException extends RuntimeException {
        private RegistrationConflictException() {
            super("account unique key conflict", null, false, false);
        }
    }

}

/**
 * Production wiring for the account services, component-scanned next to the auth code (the same
 * pattern as the Task 4 mail wiring). Context-runner tests that only include
 * {@link SecurityConfig} are unaffected; tests that include this configuration provide the
 * JdbcTemplate, PasswordService and VerificationMailSender collaborators explicitly.
 */
@Configuration(proxyBeanMethods = false)
@Conditional(SecurityConfig.BackendAuthCondition.class)
final class AuthServiceConfiguration {
    @Bean
    AuthChallengeStore authChallengeStore(JdbcTemplate jdbc, AuthProperties properties) {
        return new AuthChallengeStore(jdbc, properties);
    }

    @Bean
    CaptchaService captchaService(AuthChallengeStore store, AuthProperties properties) {
        return new CaptchaService(store, properties);
    }

    @Bean
    EmailVerificationService emailVerificationService(AuthChallengeStore store, CaptchaService captcha,
                                                      UserStore users, VerificationMailSender mail,
                                                      AuthProperties properties) {
        return new EmailVerificationService(store, captcha, users, mail, properties);
    }

    @Bean
    AuthService authService(JdbcTemplate jdbc, UserStore users, PasswordService passwords, JwtService jwt,
                            AuthChallengeStore challenges, AuthProperties properties) {
        return new AuthService(jdbc, users, passwords, jwt, challenges, properties);
    }
}
