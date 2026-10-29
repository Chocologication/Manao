package com.manao.poc4.auth;

import com.manao.poc4.api.ApiException;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.geom.Line2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.function.Supplier;
import javax.imageio.ImageIO;

/**
 * Image captcha issue/verify (design section 5.3).
 *
 * <p>The answer is five characters from an unambiguous alphabet, generated from an injected
 * source, stored only as the HMAC the challenge store computes, and rendered into a PNG with the
 * JDK 2D API. Glyphs are drawn as vector blocks instead of system text, so rendering needs no
 * fontconfig/fonts and works in a minimal headless JRE; the answer never appears in metadata, the
 * response, a URL or a log line. Captcha generation is rate limited per client address in memory
 * (single backend, restart resets the counters) and the number of currently active challenges is
 * capped globally by the store. The caller passes the address from the servlet request; this
 * service does not parse X-Forwarded-For itself - a deployment behind a trusted proxy must
 * configure the container's forward-header handling so getRemoteAddr() is trustworthy.
 */
public final class CaptchaService {
    static final String ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private static final int ANSWER_LENGTH = 5;
    private static final int IMAGE_WIDTH = 132;
    private static final int IMAGE_HEIGHT = 44;
    private static final Duration RATE_WINDOW = Duration.ofMinutes(1);
    private static final int RATE_MAP_LIMIT = 10_000;
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final AuthChallengeStore store;
    private final Clock clock;
    private final Supplier<String> answers;
    private final AddressRateLimiter rateLimiter;
    private final Random random = new SecureRandom();

    public CaptchaService(AuthChallengeStore store, AuthProperties properties) {
        this(store, properties, store.clock(), CaptchaService::randomAnswer);
    }

    public CaptchaService(AuthChallengeStore store, AuthProperties properties, Clock clock,
                          Supplier<String> answers) {
        if (store == null) throw new IllegalArgumentException("challenge store required");
        if (properties == null) throw new IllegalArgumentException("auth properties required");
        if (clock == null) throw new IllegalArgumentException("clock required");
        if (answers == null) throw new IllegalArgumentException("answer source required");
        this.store = store;
        this.clock = clock;
        this.answers = answers;
        this.rateLimiter = new AddressRateLimiter(properties.challenge().captchaPerAddressPerMinute(),
            RATE_WINDOW, RATE_MAP_LIMIT);
    }

    /**
     * Issues a new captcha. {@code remoteAddress} is the client address as seen by the servlet
     * container (after any configured trusted-proxy handling); it is only used as an in-memory
     * rate-limit key.
     */
    public AuthContracts.CaptchaResponse issue(String remoteAddress) {
        String address = remoteAddress == null || remoteAddress.isBlank() ? "unknown" : remoteAddress.trim();
        if (!rateLimiter.tryAcquire(address, clock.instant())) {
            throw new ApiException("AUTH_RATE_LIMITED", 429, "Too many captcha requests");
        }
        String answer = generatedAnswer(answers.get());
        AuthChallengeStore.CaptchaResult created = store.createCaptcha(answer);
        if (created.outcome() != AuthChallengeStore.CaptchaOutcome.ISSUED) {
            throw new ApiException("AUTH_RATE_LIMITED", 429, "Too many active captcha challenges");
        }
        byte[] png = renderPng(answer, random);
        return new AuthContracts.CaptchaResponse(created.challengeId(),
            Base64.getEncoder().encodeToString(png), created.expiresAt());
    }

    /**
     * Verifies and consumes one captcha. Answers are compared case-insensitively; malformed input
     * and unknown ids are simply refused. A wrong answer counts as an attempt in the store.
     */
    public boolean verifyAndConsume(String challengeId, String answer) {
        if (challengeId == null || challengeId.isBlank() || answer == null) return false;
        String canonical = answer.trim().toUpperCase(Locale.ROOT);
        if (!validAnswer(canonical)) return false;
        return store.verifyAndConsumeCaptcha(challengeId, canonical).consumed();
    }

    private static String generatedAnswer(String raw) {
        if (raw == null) {
            throw new IllegalStateException("captcha answer source returned no answer");
        }
        String canonical = raw.trim().toUpperCase(Locale.ROOT);
        if (!validAnswer(canonical)) {
            throw new IllegalStateException("captcha answer source returned an invalid answer");
        }
        return canonical;
    }

    private static boolean validAnswer(String value) {
        if (value.length() != ANSWER_LENGTH) return false;
        for (int i = 0; i < value.length(); i++) {
            if (ALPHABET.indexOf(value.charAt(i)) < 0) return false;
        }
        return true;
    }

    private static String randomAnswer() {
        StringBuilder answer = new StringBuilder(ANSWER_LENGTH);
        for (int i = 0; i < ANSWER_LENGTH; i++) {
            answer.append(ALPHABET.charAt(SECURE_RANDOM.nextInt(ALPHABET.length())));
        }
        return answer.toString();
    }

    // --- PNG rendering --------------------------------------------------------------------

    private static byte[] renderPng(String answer, Random random) {
        BufferedImage image = new BufferedImage(IMAGE_WIDTH, IMAGE_HEIGHT, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            graphics.setColor(new Color(247, 247, 242));
            graphics.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
            // Light background speckle.
            for (int i = 0; i < 140; i++) {
                graphics.setColor(new Color(198 + random.nextInt(57), 198 + random.nextInt(57),
                    190 + random.nextInt(65)));
                graphics.fillRect(random.nextInt(IMAGE_WIDTH), random.nextInt(IMAGE_HEIGHT),
                    1 + random.nextInt(2), 1 + random.nextInt(2));
            }
            // Interference lines behind the glyphs.
            for (int i = 0; i < 3; i++) {
                graphics.setStroke(new BasicStroke(1.2f));
                graphics.setColor(new Color(90 + random.nextInt(110), 90 + random.nextInt(110),
                    110 + random.nextInt(110), 150));
                graphics.draw(new Line2D.Double(random.nextInt(IMAGE_WIDTH / 3), random.nextInt(IMAGE_HEIGHT),
                    IMAGE_WIDTH / 2 + random.nextInt(IMAGE_WIDTH / 2), random.nextInt(IMAGE_HEIGHT)));
            }
            int scale = 3;
            int cell = 23;
            int top = (IMAGE_HEIGHT - 7 * scale) / 2;
            for (int index = 0; index < answer.length(); index++) {
                String[] glyph = GLYPHS.get(answer.charAt(index));
                if (glyph == null) {
                    throw new IllegalStateException("no glyph for captcha character");
                }
                int x = 8 + index * cell + random.nextInt(3);
                int y = top + random.nextInt(5) - 2;
                double centerX = x + 2.5 * scale;
                double centerY = y + 3.5 * scale;
                AffineTransform previous = graphics.getTransform();
                graphics.rotate((random.nextDouble() - 0.5) * 0.5, centerX, centerY);
                graphics.setColor(new Color(20 + random.nextInt(70), 20 + random.nextInt(70),
                    60 + random.nextInt(120)));
                for (int row = 0; row < 7; row++) {
                    for (int column = 0; column < 5; column++) {
                        if (glyph[row].charAt(column) == '1') {
                            graphics.fillRect(x + column * scale, y + row * scale, scale, scale);
                        }
                    }
                }
                graphics.setTransform(previous);
            }
            // Foreground speckle on top of the glyphs.
            for (int i = 0; i < 30; i++) {
                graphics.setColor(new Color(random.nextInt(170), random.nextInt(170),
                    random.nextInt(170), 120));
                graphics.fillOval(random.nextInt(IMAGE_WIDTH), random.nextInt(IMAGE_HEIGHT),
                    1 + random.nextInt(3), 1 + random.nextInt(3));
            }
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            ImageIO.write(image, "png", output);
        } catch (IOException ex) {
            throw new IllegalStateException("captcha image could not be generated", ex);
        }
        return output.toByteArray();
    }

    private static final Map<Character, String[]> GLYPHS = glyphs();

    private static Map<Character, String[]> glyphs() {
        Map<Character, String[]> table = new LinkedHashMap<>();
        glyph(table, 'A', "01110", "10001", "10001", "11111", "10001", "10001", "10001");
        glyph(table, 'B', "11110", "10001", "10001", "11110", "10001", "10001", "11110");
        glyph(table, 'C', "01110", "10001", "10000", "10000", "10000", "10001", "01110");
        glyph(table, 'D', "11110", "10001", "10001", "10001", "10001", "10001", "11110");
        glyph(table, 'E', "11111", "10000", "10000", "11110", "10000", "10000", "11111");
        glyph(table, 'F', "11111", "10000", "10000", "11110", "10000", "10000", "10000");
        glyph(table, 'G', "01110", "10001", "10000", "10111", "10001", "10001", "01110");
        glyph(table, 'H', "10001", "10001", "10001", "11111", "10001", "10001", "10001");
        glyph(table, 'J', "00111", "00010", "00010", "00010", "00010", "10010", "01100");
        glyph(table, 'K', "10001", "10010", "10100", "11000", "10100", "10010", "10001");
        glyph(table, 'M', "10001", "11011", "10101", "10101", "10001", "10001", "10001");
        glyph(table, 'N', "10001", "11001", "10101", "10101", "10011", "10001", "10001");
        glyph(table, 'P', "11110", "10001", "10001", "11110", "10000", "10000", "10000");
        glyph(table, 'Q', "01110", "10001", "10001", "10001", "10101", "10010", "01101");
        glyph(table, 'R', "11110", "10001", "10001", "11110", "10100", "10010", "10001");
        glyph(table, 'S', "01111", "10000", "10000", "01110", "00001", "00001", "11110");
        glyph(table, 'T', "11111", "00100", "00100", "00100", "00100", "00100", "00100");
        glyph(table, 'U', "10001", "10001", "10001", "10001", "10001", "10001", "01110");
        glyph(table, 'V', "10001", "10001", "10001", "10001", "10001", "01010", "00100");
        glyph(table, 'W', "10001", "10001", "10001", "10101", "10101", "10101", "01010");
        glyph(table, 'X', "10001", "10001", "01010", "00100", "01010", "10001", "10001");
        glyph(table, 'Y', "10001", "10001", "01010", "00100", "00100", "00100", "00100");
        glyph(table, 'Z', "11111", "00001", "00010", "00100", "01000", "10000", "11111");
        glyph(table, '2', "01110", "10001", "00001", "00010", "00100", "01000", "11111");
        glyph(table, '3', "11111", "00010", "00100", "00010", "00001", "10001", "01110");
        glyph(table, '4', "00010", "00110", "01010", "10010", "11111", "00010", "00010");
        glyph(table, '5', "11111", "10000", "11110", "00001", "00001", "10001", "01110");
        glyph(table, '6', "00110", "01000", "10000", "11110", "10001", "10001", "01110");
        glyph(table, '7', "11111", "00001", "00010", "00100", "01000", "01000", "01000");
        glyph(table, '8', "01110", "10001", "10001", "01110", "10001", "10001", "01110");
        glyph(table, '9', "01110", "10001", "10001", "01111", "00001", "00010", "01100");
        return table;
    }

    private static void glyph(Map<Character, String[]> table, char character, String... rows) {
        table.put(character, rows);
    }

    /** Fixed-window in-memory limiter: one backend, bounded map, restart resets the counters. */
    private static final class AddressRateLimiter {
        private final int limit;
        private final Duration duration;
        private final int mapLimit;
        private final Map<String, Window> windows = new HashMap<>();

        private AddressRateLimiter(int limit, Duration duration, int mapLimit) {
            this.limit = limit;
            this.duration = duration;
            this.mapLimit = mapLimit;
        }

        synchronized boolean tryAcquire(String address, Instant now) {
            Window current = windows.get(address);
            if (current == null || !now.isBefore(current.startedAt().plus(duration))) {
                if (windows.size() >= mapLimit) {
                    windows.entrySet().removeIf(
                        entry -> !now.isBefore(entry.getValue().startedAt().plus(duration)));
                    if (windows.size() >= mapLimit) windows.clear();
                }
                windows.put(address, new Window(now, 1));
                return true;
            }
            if (current.count() >= limit) return false;
            windows.put(address, new Window(current.startedAt(), current.count() + 1));
            return true;
        }

        private record Window(Instant startedAt, int count) {
        }
    }
}
