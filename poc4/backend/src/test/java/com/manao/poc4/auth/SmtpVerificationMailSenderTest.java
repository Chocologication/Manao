package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import jakarta.mail.Session;
import jakarta.mail.internet.MimeMessage;
import java.time.Duration;
import java.time.Instant;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * The SMTP adapter's configuration contract only. Tests build the configured JavaMailSender and
 * assert the TLS/auth/timeout properties, or inject a mocked transport; no test ever opens a
 * socket, authenticates or sends real mail.
 */
class SmtpVerificationMailSenderTest {
    private static final String PASSWORD = "runtime-only-client-authorization-code";

    @Test
    void buildsAuthenticatedImplicitTlsSenderWithHostnameChecksAndBoundedTimeouts() {
        JavaMailSenderImpl sender = SmtpVerificationMailSender.buildMailSender(configuredMail());

        assertThat(sender.getHost()).isEqualTo("smtp.example.test");
        assertThat(sender.getPort()).isEqualTo(465);
        assertThat(sender.getUsername()).isEqualTo("sender@example.test");
        assertThat(sender.getPassword()).isEqualTo(PASSWORD);
        assertThat(sender.getProtocol()).isEqualTo("smtp");
        assertThat(sender.getDefaultEncoding()).isEqualTo("UTF-8");

        Properties properties = sender.getJavaMailProperties();
        assertThat(properties.getProperty("mail.smtp.auth")).isEqualTo("true");
        assertThat(properties.getProperty("mail.smtp.ssl.enable")).isEqualTo("true");
        assertThat(properties.getProperty("mail.smtp.ssl.checkserveridentity")).isEqualTo("true");
        assertThat(properties.getProperty("mail.smtp.starttls.enable")).isEqualTo("false");
        assertThat(properties.getProperty("mail.smtp.connectiontimeout")).isEqualTo("5000");
        assertThat(properties.getProperty("mail.smtp.timeout")).isEqualTo("3000");
        assertThat(properties.getProperty("mail.smtp.writetimeout")).isEqualTo("5000");
        // Never trust-all: no trust/socket-factory override is configured.
        assertThat(properties.stringPropertyNames())
            .noneMatch(name -> name.contains("trust") || name.contains("socketFactory"));
    }

    @Test
    void mailConfigurationFailsFastForNonSslModes() {
        for (String mode : new String[] {"starttls", "plain", "none", "tls"}) {
            assertThatThrownBy(() -> new AuthProperties.Mail(true, "smtp.example.test", 465,
                "sender@example.test", "sender@example.test", mode, PASSWORD,
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)))
                .as("tls mode %s", mode)
                .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(new AuthProperties.Mail(true, "smtp.example.test", 465, "sender@example.test",
            "sender@example.test", null, PASSWORD, null, null, null).tlsMode()).isEqualTo("ssl");
    }

    @Test
    void configuredRequiresTheRuntimePasswordAndDerivesTheConfiguredBudgets() {
        assertThat(configuredMail().configured()).isTrue();
        assertThat(mail(false, PASSWORD).configured()).isFalse();
        assertThat(mail(true, "").configured()).isFalse();

        var custom = new AuthProperties.Mail(true, "smtp.example.test", 0, "sender@example.test",
            "sender@example.test", "ssl", PASSWORD,
            Duration.ofSeconds(1), Duration.ofSeconds(2), Duration.ofSeconds(3));
        assertThat(custom.port()).isEqualTo(465);
        Properties properties = SmtpVerificationMailSender.buildMailSender(custom).getJavaMailProperties();
        assertThat(properties.getProperty("mail.smtp.connectiontimeout")).isEqualTo("1000");
        assertThat(properties.getProperty("mail.smtp.timeout")).isEqualTo("2000");
        assertThat(properties.getProperty("mail.smtp.writetimeout")).isEqualTo("3000");

        assertThatThrownBy(() -> new SmtpVerificationMailSender(mail(true, "")))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sendsExactlyOneMessageThroughTheInjectedTransport() throws Exception {
        JavaMailSender transport = mock(JavaMailSender.class);
        MimeMessage message = new MimeMessage(Session.getInstance(new Properties()));
        when(transport.createMimeMessage()).thenReturn(message);
        var sender = new SmtpVerificationMailSender(transport, configuredMail());
        Instant expiresAt = Instant.parse("2026-10-29T13:00:00Z");

        sender.send("recipient@example.test", AuthContracts.EmailPurpose.RESET_PASSWORD, "123456", expiresAt);

        verify(transport, times(1)).send(any(MimeMessage.class));
        message.saveChanges();
        assertThat(message.getFrom()).hasSize(1);
        assertThat(message.getFrom()[0].toString()).contains("sender@example.test");
        assertThat(message.getAllRecipients()[0].toString()).contains("recipient@example.test");
        String content = String.valueOf(message.getContent());
        assertThat(content).contains("123456");
        assertThat(content).doesNotContain(PASSWORD);
        assertThat(message.getSubject()).doesNotContain("123456");
    }

    @Test
    void transportFailurePropagatesWithoutARetry() {
        JavaMailSender transport = mock(JavaMailSender.class);
        when(transport.createMimeMessage())
            .thenReturn(new MimeMessage(Session.getInstance(new Properties())));
        doThrow(new MailSendException("smtp unavailable")).when(transport).send(any(MimeMessage.class));
        var sender = new SmtpVerificationMailSender(transport, configuredMail());

        assertThatThrownBy(() -> sender.send("recipient@example.test",
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "654321", Instant.parse("2026-10-29T13:00:00Z")))
            .isInstanceOf(MailSendException.class);
        verify(transport, times(1)).send(any(MimeMessage.class));
    }

    @Test
    void unavailableSenderNeverTouchesSmtp() {
        var unavailable = new SmtpVerificationMailSender.Unavailable();
        assertThatThrownBy(() -> unavailable.send("recipient@example.test",
            AuthContracts.EmailPurpose.REGISTER_EMAIL, "654321", Instant.parse("2026-10-29T13:00:00Z")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("not configured");
        SmtpVerificationMailSender.Unavailable same = new SmtpVerificationMailSender.Unavailable();
        assertThat(same).isNotSameAs(unavailable);

        // The production wiring picks the unavailable implementation unless every SMTP setting
        // (including the runtime-only password) is present, so existing login keeps working.
        var configuration = new VerificationMailSenderConfiguration();
        assertThat(configuration.verificationMailSender(
            new AuthProperties(false, "", mail(false, ""), null)))
            .isInstanceOf(SmtpVerificationMailSender.Unavailable.class);
        assertThat(configuration.verificationMailSender(
            new AuthProperties(false, "", configuredMail(), null)))
            .isInstanceOf(SmtpVerificationMailSender.class);
    }

    @Test
    void authPropertiesSafeEmailDefaultsStayDisabled() {
        AuthProperties defaults = new AuthProperties(false, "", null, null);
        assertThat(defaults.mail().enabled()).isFalse();
        assertThat(defaults.mail().host()).isEmpty();
        assertThat(defaults.mail().port()).isEqualTo(465);
        assertThat(defaults.mail().tlsMode()).isEqualTo("ssl");
        assertThat(defaults.mail().password()).isEmpty();
        assertThat(defaults.mail().configured()).isFalse();
        assertThat(defaults.challenge().captchaTtl()).isEqualTo(Duration.ofMinutes(2));
        assertThat(defaults.challenge().captchaAttempts()).isEqualTo(5);
        assertThat(defaults.challenge().captchaMaxActive()).isEqualTo(1000);
        assertThat(defaults.challenge().captchaPerAddressPerMinute()).isEqualTo(10);
        assertThat(defaults.challenge().emailCodeTtl()).isEqualTo(Duration.ofMinutes(10));
        assertThat(defaults.challenge().emailCodeAttempts()).isEqualTo(5);
        assertThat(defaults.challenge().emailCodeCooldown()).isEqualTo(Duration.ofSeconds(60));
        assertThat(defaults.challenge().emailCodeHourlyLimit()).isEqualTo(5);
    }

    @Test
    void componentScanDiscoversTheMailConfigurationAndPublishesExactlyOneSender() {
        // Production wiring: a plain component scan of the auth package must find the
        // package-private configuration next to the adapter and publish a single sender bean.
        try (var context = new AnnotationConfigApplicationContext()) {
            context.registerBean(AuthProperties.class, () -> new AuthProperties(false, "", null, null));
            context.registerBean(JwtService.class,
                () -> new JwtService("0123456789abcdef0123456789abcdef", Duration.ofMinutes(15)));
            context.registerBean(UserStore.class, () -> mock(UserStore.class));
            context.scan("com.manao.poc4.auth");
            context.refresh();

            assertThat(context.getBeansOfType(VerificationMailSender.class)).hasSize(1);
            assertThat(context.getBean(VerificationMailSender.class))
                .isInstanceOf(SmtpVerificationMailSender.Unavailable.class);
        }
    }

    // --- fixtures -------------------------------------------------------------------------

    private static AuthProperties.Mail configuredMail() {
        return mail(true, PASSWORD);
    }

    private static AuthProperties.Mail mail(boolean enabled, String password) {
        return new AuthProperties.Mail(enabled, "smtp.example.test", 465, "sender@example.test",
            "sender@example.test", "ssl", password,
            Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5));
    }
}
