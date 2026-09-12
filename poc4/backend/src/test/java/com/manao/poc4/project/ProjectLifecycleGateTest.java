package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class ProjectLifecycleGateTest {
    @Test
    void rejectsAnotherThreadButAllowsAnotherProject() throws Exception {
        var gate = new ProjectLifecycleGate();
        try (var held = gate.tryAcquire("p1").orElseThrow()) {
            var executor = Executors.newSingleThreadExecutor();
            try {
                assertThat(executor.submit(() -> gate.tryAcquire("p1").isEmpty())
                    .get(2, TimeUnit.SECONDS)).isTrue();
                assertThat(executor.submit(() -> {
                    try (var other = gate.tryAcquire("p2").orElseThrow()) {
                        return true;
                    }
                }).get(2, TimeUnit.SECONDS)).isTrue();
            } finally {
                executor.shutdownNow();
            }
        }
        try (var again = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(again).isNotNull();
        }
    }

    @Test
    void sameThreadMayReenterAndCloseIsIdempotent() {
        var gate = new ProjectLifecycleGate();
        Optional<ProjectLifecycleGate.Lease> outer = gate.tryAcquire("p1");
        assertThat(outer).isPresent();
        try (var ignored = outer.orElseThrow()) {
            try (var nested = gate.tryAcquire("p1").orElseThrow()) {
                assertThat(nested).isNotNull();
                nested.close();
            }
            outer.orElseThrow().close();
        }
        try (var after = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(after).isNotNull();
        }
    }

    @Test
    void failedAcquireDoesNotBlockLaterOwner() throws Exception {
        var gate = new ProjectLifecycleGate();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (var held = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(executor.submit(() -> gate.tryAcquire("p1").isEmpty())
                .get(2, TimeUnit.SECONDS)).isTrue();
        } finally {
            executor.shutdownNow();
        }
        try (var after = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(after).isNotNull();
        }
    }

    @Test
    void exceptionInsideLeaseStillReleases() {
        var gate = new ProjectLifecycleGate();
        assertThatThrownBy(() -> {
            try (var ignored = gate.tryAcquire("p1").orElseThrow()) {
                throw new IllegalStateException("boom");
            }
        }).isInstanceOf(IllegalStateException.class);
        try (var after = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(after).isNotNull();
        }
    }

    @Test
    void releaseThenReacquireDoesNotLeaveTwoLiveExclusiveLeases() throws Exception {
        var gate = new ProjectLifecycleGate();
        gate.tryAcquire("p1").orElseThrow().close();
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch tried = new CountDownLatch(2);
        AtomicInteger acquired = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Runnable contender = () -> {
                ready.countDown();
                await(start);
                Optional<ProjectLifecycleGate.Lease> lease = gate.tryAcquire("p1");
                if (lease.isPresent()) {
                    acquired.incrementAndGet();
                    tried.countDown();
                    await(tried);
                    lease.get().close();
                } else {
                    tried.countDown();
                }
            };
            Future<?> first = executor.submit(contender);
            Future<?> second = executor.submit(contender);
            await(ready);
            start.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
            assertThat(acquired.get()).isEqualTo(1);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void overlappingFailedAcquiresDoNotRetireALiveCell() throws Exception {
        var gate = new ProjectLifecycleGate();
        CyclicBarrier entered = new CyclicBarrier(3);
        AtomicReference<Exception> failure = new AtomicReference<>();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try (var held = gate.tryAcquire("p1").orElseThrow()) {
            Runnable contender = () -> {
                try {
                    entered.await(2, TimeUnit.SECONDS);
                    assertThat(gate.tryAcquire("p1")).isEmpty();
                } catch (Exception ex) {
                    failure.compareAndSet(null, ex);
                }
            };
            Future<?> first = executor.submit(contender);
            Future<?> second = executor.submit(contender);
            entered.await(2, TimeUnit.SECONDS);
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
            assertThat(failure.get()).isNull();
            assertThat(executor.submit(() -> gate.tryAcquire("p1").isEmpty())
                .get(2, TimeUnit.SECONDS)).isTrue();
            try (var nested = gate.tryAcquire("p1").orElseThrow()) {
                assertThat(nested).isNotNull();
            }
        } finally {
            executor.shutdownNow();
        }
        try (var after = gate.tryAcquire("p1").orElseThrow()) {
            assertThat(after).isNotNull();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) {
                throw new AssertionError("latch timed out");
            }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted", ex);
        }
    }
}
