package com.manao.poc4.auth;

import java.time.Instant;

/**
 * Thin outbound mail boundary (design section 7): production code calls SMTP synchronously,
 * tests capture the message instead. There is no queue, outbox, retry or provider abstraction,
 * and the plaintext code only exists in the message and the caller's short-lived memory.
 */
public interface VerificationMailSender {
    void send(String email, AuthContracts.EmailPurpose purpose, String code, Instant expiresAt);
}
