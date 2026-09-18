package com.manao.poc4.persistence;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;

public final class DatabaseClock {
    private final Clock clock;

    public DatabaseClock() {
        this(Clock.systemUTC());
    }

    public DatabaseClock(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    public Instant now() {
        return clock.instant();
    }
}
