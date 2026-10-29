package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Iterator;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Image captcha generation and verification. The persisted answer is only an HMAC; the plaintext
 * answer is visible to this fixture because the answer source is injected. Images are decoded in
 * the test JVM (headless mode is forced by the surefire argLine), and the response/metadata must
 * never carry the answer.
 */
class CaptchaServiceTest {
    private static final String SECRET = "test-only-challenge-secret-0123456789";
    private static final String ANSWER = "AB23C";
    private static final Instant NOW = Instant.parse("2026-05-06T07:08:09Z");

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private MutableClock clock;
    private AuthChallengeStore store;
    private CaptchaService captcha;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        clock = new MutableClock(NOW);
        store = new AuthChallengeStore(jdbc, properties(50, 10), clock);
        captcha = new CaptchaService(store, properties(50, 10), clock, () -> ANSWER);
    }

    @AfterEach
    void tearDown() {
        if (db != null) db.close();
    }

    @Test
    void issuesHeadlessDecodablePngWithoutLeakingTheAnswer() throws Exception {
        AuthContracts.CaptchaResponse response = captcha.issue("198.51.100.7");

        assertThat(response.challengeId()).matches("[0-9a-f]{32}");
        assertThat(response.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(2)));
        assertThat(response.imageBase64()).isNotBlank();

        byte[] png = Base64.getDecoder().decode(response.imageBase64());
        assertThat(png).startsWith((byte) 0x89, (byte) 'P', (byte) 'N', (byte) 'G');
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        assertThat(image).isNotNull();
        assertThat(image.getWidth()).isBetween(100, 200);
        assertThat(image.getHeight()).isBetween(30, 70);
        // Real glyphs were rendered: enough dark pixels instead of a blank canvas.
        int dark = 0;
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                int rgb = image.getRGB(x, y);
                int luminance = ((rgb >> 16) & 0xff) + ((rgb >> 8) & 0xff) + (rgb & 0xff);
                if (luminance < 360) dark++;
            }
        }
        assertThat(dark).isGreaterThan(200);

        // No textual metadata chunk and no plaintext answer anywhere in the PNG bytes.
        String raw = new String(png, StandardCharsets.ISO_8859_1);
        assertThat(raw).doesNotContain("tEXt", "iTXt", "zTXt", ANSWER);
        // The response exposes only the opaque id, the image and the expiry.
        assertThat(response.challengeId()).isNotEqualTo(ANSWER);
        assertThat(response.imageBase64()).isNotEqualTo(ANSWER);
        assertThat(response.expiresAt().toString()).doesNotContain(ANSWER);
        try (ImageInputStream stream = ImageIO.createImageInputStream(new ByteArrayInputStream(png))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(stream);
            assertThat(readers.hasNext()).isTrue();
            ImageReader reader = readers.next();
            try {
                reader.setInput(stream);
                assertThat(reader.read(0).getWidth()).isEqualTo(image.getWidth());
            } finally {
                reader.dispose();
            }
        }
    }

    @Test
    void verificationIsCaseInsensitiveOneTimeAndPersistsFailedAttempts() {
        String id = captcha.issue("198.51.100.7").challengeId();

        assertThat(captcha.verifyAndConsume(id, "ZZZZZ")).isFalse();
        assertThat(attempts(id)).isEqualTo(1);
        assertThat(captcha.verifyAndConsume(id, "ab23c")).isTrue();
        assertThat(captcha.verifyAndConsume(id, ANSWER)).isFalse();
        assertThat(jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?", String.class, id))
            .isEqualTo("CONSUMED");
    }

    @Test
    void expiredAndExhaustedCaptchasAreRefused() {
        String expiring = captcha.issue("198.51.100.7").challengeId();
        clock.advance(Duration.ofMinutes(2).plusSeconds(1));
        assertThat(captcha.verifyAndConsume(expiring, ANSWER)).isFalse();

        String exhausted = captcha.issue("198.51.100.8").challengeId();
        for (int i = 1; i <= 5; i++) {
            assertThat(captcha.verifyAndConsume(exhausted, "ZZZZZ")).isFalse();
            assertThat(attempts(exhausted)).isEqualTo(i);
        }
        assertThat(captcha.verifyAndConsume(exhausted, ANSWER)).isFalse();
        assertThat(jdbc.queryForObject("SELECT state FROM auth_challenge WHERE id=?", String.class, exhausted))
            .isEqualTo("FAILED");
    }

    @Test
    void limitsCaptchaGenerationPerRemoteAddress() {
        for (int i = 0; i < 10; i++) {
            assertThat(captcha.issue("198.51.100.7").challengeId()).matches("[0-9a-f]{32}");
        }
        AuthContracts.RateLimitedException limited = catchThrowableOfType(
            () -> captcha.issue("198.51.100.7"), AuthContracts.RateLimitedException.class);
        assertThat(limited.retryAfterSeconds()).isPositive().isLessThanOrEqualTo(60);

        // A different client keeps its own budget.
        assertThat(captcha.issue("198.51.100.8").challengeId()).matches("[0-9a-f]{32}");

        clock.advance(Duration.ofSeconds(61));
        assertThat(captcha.issue("198.51.100.7").challengeId()).matches("[0-9a-f]{32}");
    }

    @Test
    void limitsTheNumberOfActiveCaptchas() {
        var cappedStore = new AuthChallengeStore(jdbc, properties(2, 100), clock);
        var capped = new CaptchaService(cappedStore, properties(2, 100), clock, () -> ANSWER);
        assertThat(capped.issue("198.51.100.7").challengeId()).matches("[0-9a-f]{32}");
        assertThat(capped.issue("198.51.100.7").challengeId()).matches("[0-9a-f]{32}");
        AuthContracts.RateLimitedException limited = catchThrowableOfType(
            () -> capped.issue("198.51.100.7"), AuthContracts.RateLimitedException.class);
        // Capacity waits for an existing challenge to expire; the advisory wait covers the TTL.
        assertThat(limited.retryAfterSeconds()).isPositive()
            .isLessThanOrEqualTo(Duration.ofMinutes(2).toSeconds());

        // The opportunistic expiry cleanup frees capacity again, with no scheduler involved.
        clock.advance(Duration.ofMinutes(2).plusSeconds(1));
        assertThat(capped.issue("198.51.100.7").challengeId()).matches("[0-9a-f]{32}");
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM auth_challenge WHERE purpose='CAPTCHA' AND state='ACTIVE'", Integer.class))
            .isEqualTo(1);
    }

    @Test
    void saturatedAddressBudgetKeepsExistingLimitsInsteadOfClearingThem() {
        // A tiny address-budget table: exhausted addresses must keep their window even when the
        // table is full; new addresses are refused until an entry expires instead of the limiter
        // clearing every live budget.
        var smallBudget = new CaptchaService(store, properties(1000, 10), clock, () -> ANSWER, 3);
        for (int i = 0; i < 10; i++) {
            smallBudget.issue("203.0.113.10");
        }
        assertThat(catchThrowableOfType(() -> smallBudget.issue("203.0.113.10"),
            AuthContracts.RateLimitedException.class)).isNotNull();
        smallBudget.issue("203.0.113.11");
        smallBudget.issue("203.0.113.12");

        // The map is saturated; a brand new address is refused (bounded memory, fail closed)
        // rather than dropping the existing windows.
        assertThat(catchThrowableOfType(() -> smallBudget.issue("203.0.113.13"),
            AuthContracts.RateLimitedException.class)).isNotNull();
        // The original exhausted address is still rate limited.
        assertThat(catchThrowableOfType(() -> smallBudget.issue("203.0.113.10"),
            AuthContracts.RateLimitedException.class)).isNotNull();

        // Once the windows expire, entries are recycled and the address is allowed again.
        clock.advance(Duration.ofSeconds(61));
        assertThat(smallBudget.issue("203.0.113.10").challengeId()).matches("[0-9a-f]{32}");
    }

    @Test
    void rejectsMalformedVerificationInputAndInvalidGeneratedAnswers() {
        assertThat(captcha.verifyAndConsume("missing", ANSWER)).isFalse();
        assertThat(captcha.verifyAndConsume(null, ANSWER)).isFalse();
        assertThat(captcha.verifyAndConsume(captcha.issue("198.51.100.7").challengeId(), null)).isFalse();
        assertThat(captcha.verifyAndConsume(captcha.issue("198.51.100.7").challengeId(), "TOO-LONG")).isFalse();
        assertThat(captcha.verifyAndConsume(captcha.issue("198.51.100.7").challengeId(), "IIIII")).isFalse();

        var brokenGenerator = new CaptchaService(store, properties(50, 100), clock, () -> "OO0O0");
        org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> brokenGenerator.issue("198.51.100.9")).isInstanceOf(IllegalStateException.class);
    }

    // --- fixtures -------------------------------------------------------------------------

    private static AuthProperties properties(int maxActive, int perMinute) {
        return new AuthProperties(false, SECRET,
            new AuthProperties.Mail(false, "", 465, "", "", "ssl", "",
                Duration.ofSeconds(5), Duration.ofSeconds(3), Duration.ofSeconds(5)),
            new AuthProperties.Challenge(Duration.ofMinutes(2), 5, maxActive, perMinute,
                Duration.ofMinutes(10), 5, Duration.ofSeconds(60), 5));
    }

    private int attempts(String id) {
        return jdbc.queryForObject("SELECT attempts FROM auth_challenge WHERE id=?", Integer.class, id);
    }

    /** Mutable UTC clock so TTL, attempt and rate-limit windows are deterministic. */
    private static final class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override public Instant instant() {
            return now;
        }
    }
}
