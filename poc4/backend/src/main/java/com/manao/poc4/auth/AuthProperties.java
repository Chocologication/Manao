package com.manao.poc4.auth;

import java.time.Duration;
import java.util.Locale;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Account lifecycle configuration (design sections 5 and 7). Security sensitive switches default
 * to off/empty: registration stays closed, mail stays disabled and the challenge HMAC secret must
 * be injected. The deployment maps the MANAO_* environment variables onto this prefix; this class
 * only defines the safe baseline, never a credential.
 */
@ConfigurationProperties(prefix = "manao.poc4.auth", ignoreUnknownFields = false)
public record AuthProperties(boolean registrationEnabled, String authChallengeSecret, Mail mail,
                             Challenge challenge) {
    public AuthProperties {
        authChallengeSecret = authChallengeSecret == null ? "" : authChallengeSecret.trim();
        mail = mail == null ? Mail.safeDefaults() : mail;
        challenge = challenge == null ? Challenge.safeDefaults() : challenge;
    }

    /**
     * SMTP sending parameters. The password is the client authorization code and is always
     * injected at runtime; it is empty here. Implicit TLS on port 465 is the only supported mode
     * (no STARTTLS and no plaintext fallback).
     */
    public record Mail(boolean enabled, String host, int port, String username, String from,
                       String tlsMode, String password,
                       Duration connectTimeout, Duration readTimeout, Duration writeTimeout) {
        public Mail {
            host = host == null ? "" : host.trim();
            port = port < 1 || port > 65535 ? 465 : port;
            username = username == null ? "" : username.trim();
            from = from == null ? "" : from.trim();
            tlsMode = tlsMode == null || tlsMode.isBlank() ? "ssl" : tlsMode.trim().toLowerCase(Locale.ROOT);
            if (!tlsMode.equals("ssl")) {
                throw new IllegalArgumentException("mail tls mode must be ssl (implicit TLS on 465)");
            }
            password = password == null ? "" : password;
            connectTimeout = positive(connectTimeout, Duration.ofSeconds(5));
            readTimeout = positive(readTimeout, Duration.ofSeconds(3));
            writeTimeout = positive(writeTimeout, Duration.ofSeconds(5));
        }

        static Mail safeDefaults() {
            return new Mail(false, "", 465, "", "", "ssl", "",
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5));
        }
    }

    /** Challenge lifetimes and retry bounds from design section 5.3. */
    public record Challenge(Duration captchaTtl, int captchaAttempts, Duration emailCodeTtl,
                            int emailCodeAttempts, Duration emailCodeCooldown,
                            int emailCodeHourlyLimit) {
        public Challenge {
            captchaTtl = positive(captchaTtl, Duration.ofMinutes(2));
            captchaAttempts = atLeastOne(captchaAttempts, 5);
            emailCodeTtl = positive(emailCodeTtl, Duration.ofMinutes(10));
            emailCodeAttempts = atLeastOne(emailCodeAttempts, 5);
            emailCodeCooldown = positive(emailCodeCooldown, Duration.ofSeconds(60));
            emailCodeHourlyLimit = atLeastOne(emailCodeHourlyLimit, 5);
        }

        static Challenge safeDefaults() {
            return new Challenge(Duration.ofMinutes(2), 5, Duration.ofMinutes(10), 5,
                Duration.ofSeconds(60), 5);
        }
    }

    private static Duration positive(Duration value, Duration fallback) {
        if (value == null) return fallback;
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException("auth durations must be positive");
        }
        return value;
    }

    private static int atLeastOne(int value, int fallback) {
        if (value < 1) return fallback;
        return value;
    }
}
