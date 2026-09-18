package com.manao.poc4.audit;

/** Redacts credential-bearing substrings before any command text is persisted. */
public final class CommandRedactor {
    private static final String MASK = "***";

    private CommandRedactor() { }

    /**
     * Masks password/token flags, Authorization headers, credential environment assignments and
     * URL user credentials. The flag records whether anything sensitive was detected.
     */
    public static String redact(String command, boolean[] sensitiveDetected) {
        String value = command == null ? "" : command;
        value = maskRegex(value, "(?i)(--?password(?:=|\\s+))([^\\s]+)", "$1" + MASK, sensitiveDetected);
        value = maskRegex(value, "(?i)(--?token(?:=|\\s+))([^\\s]+)", "$1" + MASK, sensitiveDetected);
        value = maskRegex(value, "(?i)((?:authorization|proxy-authorization):\\s*)[^']*", "$1" + MASK, sensitiveDetected);
        value = maskRegex(value, "(?i)((?:[A-Z_]*(?:PASSWORD|TOKEN|SECRET|API_KEY|ACCESS_KEY)[A-Z_]*)=)([^\\s]+)",
            "$1" + MASK, sensitiveDetected);
        value = maskRegex(value, "(https?://)([^/@\\s:]+):([^/@\\s]+)@", "$1" + MASK + "@", sensitiveDetected);
        return value;
    }

    private static String maskRegex(String value, String regex, String replacement, boolean[] sensitiveDetected) {
        String masked = value.replaceAll(regex, replacement);
        if (!masked.equals(value)) {
            sensitiveDetected[0] = true;
        }
        return masked;
    }
}
