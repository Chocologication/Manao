package com.manao.poc4.auth;

import com.manao.poc4.config.SecurityConfig;
import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Properties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.springframework.mail.javamail.MimeMessageHelper;

/**
 * The only production {@link VerificationMailSender}: a synchronous JavaMail SMTP send (design
 * section 7). Exactly one message is attempted per call - no retry, queue, outbox or startup
 * connection probe. Port 465 implicit TLS is the only supported mode; SMTP authentication,
 * certificate and hostname verification are always on and there is no plaintext/STARTTLS
 * fallback and never a trust-all socket factory. The client authorization code comes from the
 * runtime-only configuration and is never logged.
 *
 * <p>When mail is disabled or incomplete the wiring returns {@link Unavailable} instead of
 * creating a sender, so the existing login/password-change flows keep starting.
 */
public final class SmtpVerificationMailSender implements VerificationMailSender {
    private static final DateTimeFormatter EXPIRY_FORMAT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private final JavaMailSender mailSender;
    private final AuthProperties.Mail mail;

    public SmtpVerificationMailSender(AuthProperties.Mail mail) {
        this(buildMailSender(mail), mail);
    }

    /** Test seam: the caller supplies the transport (a mock), so no test opens a socket. */
    SmtpVerificationMailSender(JavaMailSender mailSender, AuthProperties.Mail mail) {
        if (mailSender == null) throw new IllegalArgumentException("mail transport required");
        this.mailSender = mailSender;
        this.mail = requireConfigured(mail);
    }

    static JavaMailSenderImpl buildMailSender(AuthProperties.Mail mail) {
        requireConfigured(mail);
        JavaMailSenderImpl sender = new JavaMailSenderImpl();
        sender.setHost(mail.host());
        sender.setPort(mail.port());
        sender.setUsername(mail.username());
        sender.setPassword(mail.password());
        sender.setProtocol("smtp");
        sender.setDefaultEncoding("UTF-8");
        Properties properties = sender.getJavaMailProperties();
        properties.put("mail.smtp.auth", "true");
        // Implicit TLS on 465: no STARTTLS negotiation and no fallback to plaintext.
        properties.put("mail.smtp.ssl.enable", "true");
        properties.put("mail.smtp.ssl.checkserveridentity", "true");
        properties.put("mail.smtp.starttls.enable", "false");
        properties.put("mail.smtp.starttls.required", "false");
        // Certificate validation uses the JVM trust store; no trust-all override is set.
        properties.put("mail.smtp.connectiontimeout", String.valueOf(mail.connectTimeout().toMillis()));
        properties.put("mail.smtp.timeout", String.valueOf(mail.readTimeout().toMillis()));
        properties.put("mail.smtp.writetimeout", String.valueOf(mail.writeTimeout().toMillis()));
        return sender;
    }

    @Override
    public void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
        if (email == null || email.isBlank() || purpose == null || code == null || expiresAt == null) {
            throw new IllegalArgumentException("verification mail message required");
        }
        MimeMessage message = mailSender.createMimeMessage();
        try {
            MimeMessageHelper helper = new MimeMessageHelper(message, false, "UTF-8");
            helper.setFrom(mail.from());
            helper.setTo(email);
            helper.setSubject(subject(purpose));
            helper.setText(body(purpose, code, expiresAt), false);
        } catch (MessagingException ex) {
            throw new IllegalStateException("verification mail could not be built", ex);
        }
        mailSender.send(message);
    }

    static String subject(AuthContracts.EmailPurpose purpose) {
        return switch (purpose) {
            case REGISTER_EMAIL -> "Manao 注册邮箱验证码";
            case RESET_PASSWORD -> "Manao 找回密码验证码";
        };
    }

    static String body(AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
        String action = purpose == AuthContracts.EmailPurpose.REGISTER_EMAIL ? "注册" : "找回密码";
        return "Manao " + action + "验证码：" + code + "\n\n"
            + "有效期至 " + EXPIRY_FORMAT.format(expiresAt) + "，请尽快使用。\n"
            + "如非本人操作，请忽略本邮件；请勿向任何人泄露验证码。";
    }

    private static AuthProperties.Mail requireConfigured(AuthProperties.Mail mail) {
        if (mail == null || !mail.configured()) {
            throw new IllegalArgumentException("mail is not configured");
        }
        return mail;
    }

    /** Null-object sender used while mail is disabled or incomplete; it never touches SMTP. */
    public static final class Unavailable implements VerificationMailSender {
        @Override
        public void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt) {
            throw new IllegalStateException("mail is not configured");
        }
    }
}

/**
 * Production wiring for the mail boundary. The same backend-auth condition as
 * {@link SecurityConfig} keeps contexts without a database (for example the actuator-only test
 * context) free of this bean; whenever auth is wired and mail is disabled or incomplete, an
 * {@link SmtpVerificationMailSender.Unavailable} sender is exposed so existing login still starts.
 */
@Configuration(proxyBeanMethods = false)
@Conditional(SecurityConfig.BackendAuthCondition.class)
final class VerificationMailSenderConfiguration {
    @Bean
    VerificationMailSender verificationMailSender(AuthProperties properties) {
        return properties.mail().configured()
            ? new SmtpVerificationMailSender(properties.mail())
            : new SmtpVerificationMailSender.Unavailable();
    }
}
