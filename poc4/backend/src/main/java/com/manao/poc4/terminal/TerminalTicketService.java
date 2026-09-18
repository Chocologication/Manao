package com.manao.poc4.terminal;

import java.security.MessageDigest;
import java.util.Optional;

/** Terminal ticket hashing shared by reservation and handshake paths; raw tickets are never stored. */
public interface TerminalTicketService {
    Optional<TerminalStore.SessionRecord> consume(String ticket);

    static String sha256Hex(String value) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
