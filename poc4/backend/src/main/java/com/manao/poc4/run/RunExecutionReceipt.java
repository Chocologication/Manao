package com.manao.poc4.run;

import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The run receipt written by the in-container supervisor (shared control directory while the
 * container lives, container-local termination message after it exits). The format is a fixed
 * allowlist with canonical key order; parsing is strict because this file is the evidence a Run's
 * readiness, lifetime and exit are settled from — never user stdout.
 *
 * <p>Production validation is fixed: whenever a receipt carries a lifetime, the span from
 * {@code firstReadyAt} to {@code expiresAt} must be exactly {@link #SERVICE_LIFETIME}; short
 * test lifetimes never relax this rule, so the backend can never adopt a foreign time base.</p>
 */
public record RunExecutionReceipt(String projectId, String runId, String podUid,
                                  String state, Instant firstReadyAt,
                                  Instant expiresAt, String reason) {

    public static final String PROTOCOL = "1";
    public static final String STATE_CLAIMED = "CLAIMED";
    public static final String STATE_READY = "READY";
    public static final String STATE_EXITED = "EXITED";
    public static final String STATE_TIMED_OUT = "TIMED_OUT";
    public static final String STATE_STARTUP_TIMED_OUT = "STARTUP_TIMED_OUT";
    public static final String STATE_DENIED = "DENIED";
    public static final Set<String> STATES = Set.of(STATE_CLAIMED, STATE_READY, STATE_EXITED,
        STATE_TIMED_OUT, STATE_STARTUP_TIMED_OUT, STATE_DENIED);
    public static final Duration SERVICE_LIFETIME = Duration.ofSeconds(7200);

    private static final String[] KEY_ORDER =
        {"protocol", "projectId", "runId", "podUid", "state", "firstReadyAt", "expiresAt", "reason"};
    private static final Set<String> ALLOWED_KEYS = Set.of(KEY_ORDER);
    private static final Set<String> REQUIRED_KEYS = Set.of("protocol", "projectId", "runId", "podUid", "state", "reason");

    public static RunExecutionReceipt parse(String text) {
        if (text == null) {
            throw new IllegalArgumentException("receipt is missing");
        }
        Map<String, String> fields = new LinkedHashMap<>();
        for (String rawLine : text.split("\n", -1)) {
            String line = rawLine.trim();
            if (line.isEmpty()) {
                continue; // only the trailing newline of the canonical format reaches here
            }
            int separator = line.indexOf('=');
            if (separator <= 0 || line.indexOf('=', separator + 1) >= 0
                || fields.put(line.substring(0, separator), line.substring(separator + 1)) != null) {
                throw new IllegalArgumentException("receipt line is not a unique key=value pair");
            }
        }
        if (!PROTOCOL.equals(fields.get("protocol"))) {
            throw new IllegalArgumentException("receipt protocol mismatch");
        }
        if (!ALLOWED_KEYS.containsAll(fields.keySet()) || !fields.keySet().containsAll(REQUIRED_KEYS)) {
            throw new IllegalArgumentException("receipt is missing required fields");
        }
        for (String key : fields.keySet()) {
            if (!ALLOWED_KEYS.contains(key)) {
                throw new IllegalArgumentException("receipt field is outside the allowlist: " + key);
            }
        }
        // Canonical order is enforced: the supervisor writes one fixed layout and any reshuffle
        // means the file did not come from the trusted writer.
        int expected = 0;
        for (String key : fields.keySet()) {
            while (expected < KEY_ORDER.length && !KEY_ORDER[expected].equals(key)) {
                expected++;
            }
            if (expected == KEY_ORDER.length) {
                throw new IllegalArgumentException("receipt fields are out of canonical order");
            }
        }
        String state = fields.get("state");
        if (!STATES.contains(state)) {
            throw new IllegalArgumentException("receipt state is unknown: " + state);
        }
        for (String identity : new String[] {"projectId", "runId", "podUid"}) {
            if (fields.get(identity) == null || fields.get(identity).isBlank()) {
                throw new IllegalArgumentException("receipt identity field is blank: " + identity);
            }
        }
        Instant firstReadyAt = instant(fields, "firstReadyAt");
        Instant expiresAt = instant(fields, "expiresAt");
        if (firstReadyAt == null && expiresAt != null || firstReadyAt != null && expiresAt == null) {
            throw new IllegalArgumentException("receipt lifetime is incomplete");
        }
        if (firstReadyAt != null) {
            Duration lifetime = Duration.between(firstReadyAt, expiresAt);
            if (!lifetime.equals(SERVICE_LIFETIME)) {
                throw new IllegalArgumentException("receipt lifetime is not the fixed service lifetime");
            }
        }
        if (STATE_CLAIMED.equals(state) && firstReadyAt != null) {
            throw new IllegalArgumentException("a claimed receipt cannot carry a lifetime");
        }
        if (STATE_STARTUP_TIMED_OUT.equals(state) && firstReadyAt != null) {
            throw new IllegalArgumentException("a startup-timeout receipt never reached readiness");
        }
        if ((STATE_READY.equals(state) || STATE_TIMED_OUT.equals(state)) && firstReadyAt == null) {
            throw new IllegalArgumentException(state + " receipt must carry the fixed lifetime");
        }
        return new RunExecutionReceipt(fields.get("projectId"), fields.get("runId"), fields.get("podUid"),
            state, firstReadyAt, expiresAt, fields.get("reason"));
    }

    private static Instant instant(Map<String, String> fields, String key) {
        String value = fields.get(key);
        if (value == null) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException ex) {
            throw new IllegalArgumentException("receipt timestamp is not an ISO instant: " + key);
        }
    }

    /** True when the receipt proves the application reached readiness at a fixed lifetime. */
    public boolean indicatesReady() {
        return STATE_READY.equals(state) || STATE_TIMED_OUT.equals(state)
            || (STATE_EXITED.equals(state) && firstReadyAt != null);
    }
}
