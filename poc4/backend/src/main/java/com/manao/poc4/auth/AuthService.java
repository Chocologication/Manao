package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.config.SecurityConfig;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

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
    private static final Logger LOG = LoggerFactory.getLogger(AuthService.class);

    private final UserStore users;
    private final PasswordService passwords;
    private final JwtService jwt;
    private final AuthChallengeStore challenges;
    private final AuthProperties properties;
    private final UserSessionRevoker revoker;

    public AuthService(JdbcTemplate jdbc, UserStore users, PasswordService passwords, JwtService jwt,
                       AuthChallengeStore challenges, AuthProperties properties) {
        this(jdbc, users, passwords, jwt, challenges, properties, null);
    }

    public AuthService(JdbcTemplate jdbc, UserStore users, PasswordService passwords, JwtService jwt,
                       AuthChallengeStore challenges, AuthProperties properties, UserSessionRevoker revoker) {
        if (jdbc == null) throw new IllegalArgumentException("jdbc template required");
        if (users == null) throw new IllegalArgumentException("user store required");
        if (passwords == null) throw new IllegalArgumentException("password service required");
        if (jwt == null) throw new IllegalArgumentException("jwt service required");
        if (challenges == null) throw new IllegalArgumentException("challenge store required");
        if (properties == null) throw new IllegalArgumentException("auth properties required");
        // The JdbcTemplate collaborator is kept in the signature for wiring/tests; all account
        // writes go through UserStore and the challenge store's shared transaction template.
        this.users = users;
        this.passwords = passwords;
        this.jwt = jwt;
        this.challenges = challenges;
        this.properties = properties;
        this.revoker = revoker;
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
        String newPassword = normalizedNewPassword(request.password());
        String email = normalizedEmail(request.email());
        Instant now = challenges.clock().instant();
        RegisterOutcome outcome;
        try {
            outcome = challenges.inTransaction(status -> registerInTransaction(
                username, newPassword, email, request.emailChallengeId(), request.emailCode(), now));
        } catch (RegistrationConflictException race) {
            // A unique-key race after the pre-check rolled the consume back with the transaction.
            throw users.findByUsername(username).isPresent() ? usernameTaken() : emailTaken();
        }
        if (outcome.error() != null) throw outcome.error();
        return outcome.registered();
    }

    private RegisterOutcome registerInTransaction(String username, String newPassword, String email,
                                                  String challengeId, String code, Instant now) {
        if (users.findByUsername(username).isPresent()) return RegisterOutcome.failure(usernameTaken());
        if (users.findByEmail(email).isPresent()) return RegisterOutcome.failure(emailTaken());
        AuthChallengeStore.VerifyResult verified = challenges.verifyAndConsume(
            challengeId, AuthContracts.EmailPurpose.REGISTER_EMAIL, email, code);
        if (!verified.consumed()) return RegisterOutcome.failure(emailCodeInvalid());
        // Hash only after the one-time code was accepted: an anonymous invalid-code request must
        // not be able to amplify BCrypt cost. The short transaction grows by the hash work, which
        // is accepted for this small-scale single-backend release.
        String passwordHash = passwords.hash(newPassword);
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
    public PasswordChangeResult resetPassword(AuthContracts.PasswordResetRequest request) {
        if (request == null) throw validationError();
        String email = normalizedEmail(request.email());
        String newPassword = normalizedNewPassword(request.newPassword());
        String[] revokedUser = new String[1];
        long[] revokedVersion = new long[1];
        Boolean updated = challenges.inTransaction(status -> {
            AuthChallengeStore.VerifyResult verified = challenges.verifyAndConsume(
                request.emailChallengeId(), AuthContracts.EmailPurpose.RESET_PASSWORD, email,
                request.emailCode());
            if (!verified.consumed()) return false;
            // BCrypt runs only for a valid, version-bound code (no anonymous CPU amplification).
            String passwordHash = passwords.hash(newPassword);
            if (users.updatePassword(verified.userId(), passwordHash,
                verified.authVersionSnapshot()) != 1) {
                return false;
            }
            revokedUser[0] = verified.userId();
            revokedVersion[0] = verified.authVersionSnapshot() + 1;
            // Revoke only AFTER the password/version commit (design 8.2); a rollback or a later
            // failure must not close the old streams, and a callback failure must not undo the
            // committed password change.
            revokeOlderAfterCommit(revokedUser[0], revokedVersion[0]);
            return true;
        });
        if (!Boolean.TRUE.equals(updated)) throw emailCodeInvalid();
        return new PasswordChangeResult(revokedUser[0], revokedVersion[0]);
    }

    /**
     * Authenticated password change: currentPassword keeps the historical contract (legacy short
     * passwords still work), the NEW password follows the new rule, and the conditional UPDATE
     * includes the request's auth_version. A stale/concurrent request is refused with 401 without
     * overwriting the newer password; no replacement token is issued.
     */
    public PasswordChangeResult changePassword(AuthContracts.AccountIdentity identity,
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
        boolean updated = Boolean.TRUE.equals(challenges.transactions().execute(status -> {
            if (users.updatePassword(identity.userId(), passwordHash, identity.authVersion()) != 1) {
                return false;
            }
            revokeOlderAfterCommit(identity.userId(), identity.authVersion() + 1);
            return true;
        }));
        if (!updated) throw staleAuthentication();
        return new PasswordChangeResult(identity.userId(), identity.authVersion() + 1);
    }

    /**
     * Schedules stream/ticket revocation for after the current password transaction commits.
     * Callback failures are contained: the committed password stays changed and the response is
     * not reported as a failed change.
     */
    private void revokeOlderAfterCommit(String userId, long newAuthVersion) {
        UserSessionRevoker target = revoker;
        if (target == null) return;
        Runnable revoke = () -> {
            try {
                target.closeOlder(userId, newAuthVersion);
            } catch (RuntimeException ex) {
                LOG.warn("credential revocation callback failed");
            }
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() {
                    revoke.run();
                }
            });
        } else {
            revoke.run();
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

    /**
     * The result of a committed password transaction: the internal hook payload Task 6 uses for
     * after-commit revocation. The HTTP contract stays 204 with no replacement token.
     */
    public record PasswordChangeResult(String userId, long newAuthVersion) {
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
    /** One in-process registry shared by log/terminal sockets and AI live-output streams. */
    @Bean
    UserSessionRevoker userSessionRevoker() {
        return new UserSessionRevoker();
    }

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
                            AuthChallengeStore challenges, AuthProperties properties,
                            UserSessionRevoker revoker) {
        return new AuthService(jdbc, users, passwords, jwt, challenges, properties, revoker);
    }
}
