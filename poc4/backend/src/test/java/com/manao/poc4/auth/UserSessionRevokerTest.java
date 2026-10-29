package com.manao.poc4.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * The in-process connection registry (design 8.2): short lock, per-user version watermark,
 * callbacks outside the lock and one by one, idempotent registration/revocation, and a late
 * registration after closeOlder is closed immediately (it can never become "ready").
 */
class UserSessionRevokerTest {
    @Test
    void closesOnlyOlderVersionsAndKeepsTheNewVersionOpen() {
        UserSessionRevoker revoker = new UserSessionRevoker();
        AtomicInteger closeOld = new AtomicInteger();
        AtomicInteger closeNew = new AtomicInteger();
        revoker.register("u", 0, closeOld::incrementAndGet);
        revoker.register("u", 1, closeNew::incrementAndGet);

        revoker.closeOlder("u", 1);

        assertThat(closeOld).hasValue(1);
        assertThat(closeNew).hasValue(0);
        // Repeated revocation is idempotent and never closes the newer connection.
        revoker.closeOlder("u", 1);
        assertThat(closeOld).hasValue(1);
        assertThat(closeNew).hasValue(0);
        // A later version closes the previous one now.
        revoker.closeOlder("u", 2);
        assertThat(closeNew).hasValue(1);
    }

    @Test
    void registrationCloseIsIdempotentAndPreventsTheCallback() {
        UserSessionRevoker revoker = new UserSessionRevoker();
        AtomicInteger closed = new AtomicInteger();
        UserSessionRevoker.Registration registration = revoker.register("u", 3, closed::incrementAndGet);

        registration.close();
        registration.close();
        revoker.closeOlder("u", 4);

        assertThat(closed).hasValue(0);
    }

    @Test
    void aRegistrationAfterCloseOlderIsClosedImmediately() {
        UserSessionRevoker revoker = new UserSessionRevoker();
        revoker.closeOlder("u", 5);

        AtomicInteger closed = new AtomicInteger();
        UserSessionRevoker.Registration late = revoker.register("u", 4, closed::incrementAndGet);
        assertThat(closed).hasValue(1);
        // Still safe to unregister; the callback is never repeated.
        late.close();
        assertThat(closed).hasValue(1);
        // A connection at the watermark is current and stays open.
        AtomicInteger current = new AtomicInteger();
        revoker.register("u", 5, current::incrementAndGet);
        revoker.closeOlder("u", 5);
        assertThat(current).hasValue(0);
    }

    @Test
    void callbacksRunOutsideTheLockOneByOneAndFailuresAreIsolated() {
        UserSessionRevoker revoker = new UserSessionRevoker();
        List<String> order = new CopyOnWriteArrayList<>();
        revoker.register("u", 1, () -> order.add("first"));
        revoker.register("u", 1, () -> {
            throw new IllegalStateException("broken connection");
        });
        revoker.register("u", 1, () -> order.add("last"));
        // A callback that itself registers a new connection must not deadlock on the registry lock.
        revoker.register("u", 1, () -> revoker.register("other", 0, () -> order.add("other")));

        assertThatCode(() -> revoker.closeOlder("u", 2)).doesNotThrowAnyException();
        assertThat(order).containsExactly("first", "last");
    }

    @Test
    void concurrentRegistrationAndRevocationSerializesOnTheWatermark() throws Exception {
        UserSessionRevoker revoker = new UserSessionRevoker();
        CountDownLatch registered = new CountDownLatch(1);
        CountDownLatch revoked = new CountDownLatch(1);
        AtomicInteger closed = new AtomicInteger();
        Thread registration = new Thread(() -> {
            UserSessionRevoker.Registration handle = revoker.register("u", 0, closed::incrementAndGet);
            registered.countDown();
            try {
                assertThat(revoked.await(5, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException ex) {
                throw new IllegalStateException(ex);
            }
            handle.close();
        });
        registration.start();
        assertThat(registered.await(5, TimeUnit.SECONDS)).isTrue();
        revoker.closeOlder("u", 1);
        revoked.countDown();
        registration.join(5000);
        assertThat(closed).hasValue(1);
    }
}
