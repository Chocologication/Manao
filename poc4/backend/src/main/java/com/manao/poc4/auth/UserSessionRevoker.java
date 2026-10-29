package com.manao.poc4.auth;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * In-process registry of established log/terminal/SSE connections, each tagged with the
 * auth_version of the request that opened it (design section 8.2). Registration and revocation
 * share one short lock and a per-user version watermark; close callbacks are invoked OUTSIDE the
 * lock, one by one, and a failure in one connection never prevents the others.
 *
 * <p>closeOlder(userId, newVersion) closes only connections whose version is strictly lower than
 * newVersion. A registration that arrives after the watermark was raised is closed immediately
 * (the handshake may have raced the password commit), so a late listener/handle can never become
 * usable again. The whole design assumes a single backend process; a restart drops all registry
 * entries and closes all connections through the existing shutdown handling.
 */
public final class UserSessionRevoker {
    /** Opaque registration handle; close() unregisters idempotently. */
    public interface Registration extends AutoCloseable {
        @Override
        void close();
    }

    private static final Registration CLOSED = () -> { };

    private final Object lock = new Object();
    private final Map<Long, Entry> entries = new HashMap<>();
    private final Map<String, Long> watermarks = new HashMap<>();
    private long nextId;

    /**
     * Registers a connection bound to {@code authVersion}. If the user's watermark is already
     * higher, the callback runs immediately (outside the lock) and a closed registration is
     * returned: the caller must not open any resource for it.
     */
    public Registration register(String userId, long authVersion, Runnable closeCallback) {
        if (userId == null || userId.isBlank()) throw new IllegalArgumentException("user id required");
        if (closeCallback == null) throw new IllegalArgumentException("close callback required");
        if (authVersion < 0) throw new IllegalArgumentException("auth version must be non-negative");
        Entry entry;
        boolean revokedImmediately;
        synchronized (lock) {
            Long watermark = watermarks.get(userId);
            revokedImmediately = watermark != null && watermark > authVersion;
            if (revokedImmediately) {
                entry = null;
            } else {
                entry = new Entry(++nextId, userId, authVersion, closeCallback);
                entries.put(entry.id, entry);
            }
        }
        if (revokedImmediately) {
            runSafely(closeCallback);
            return CLOSED;
        }
        Entry registered = entry;
        return () -> unregister(registered);
    }

    /**
     * Closes every registered connection of the user below {@code newVersion} and raises the
     * watermark. Already-closed entries are removed exactly once; the callbacks run after the
     * lock is released.
     */
    public void closeOlder(String userId, long newVersion) {
        if (userId == null || userId.isBlank() || newVersion < 0) return;
        List<Runnable> callbacks = new ArrayList<>();
        synchronized (lock) {
            long watermark = watermarks.getOrDefault(userId, -1L);
            if (newVersion > watermark) watermarks.put(userId, newVersion);
            var iterator = entries.values().iterator();
            while (iterator.hasNext()) {
                Entry entry = iterator.next();
                if (entry.userId.equals(userId) && entry.authVersion < newVersion) {
                    iterator.remove();
                    if (entry.claimed.compareAndSet(false, true)) callbacks.add(entry.callback);
                }
            }
        }
        for (Runnable callback : callbacks) runSafely(callback);
    }

    /** Number of registered (not yet closed) connections; observability/tests only. */
    public int registered() {
        synchronized (lock) {
            return entries.size();
        }
    }

    private void unregister(Entry entry) {
        if (entry == null) return;
        synchronized (lock) {
            if (!entry.claimed.compareAndSet(false, true)) return;
            entries.remove(entry.id);
        }
    }

    private static void runSafely(Runnable callback) {
        try {
            callback.run();
        } catch (RuntimeException ex) {
            // One broken connection must not prevent the remaining revocations or turn a
            // committed password change into a failed response.
        }
    }

    private static final class Entry {
        final long id;
        final String userId;
        final long authVersion;
        final Runnable callback;
        final java.util.concurrent.atomic.AtomicBoolean claimed = new java.util.concurrent.atomic.AtomicBoolean();

        Entry(long id, String userId, long authVersion, Runnable callback) {
            this.id = id;
            this.userId = userId;
            this.authVersion = authVersion;
            this.callback = callback;
        }
    }
}
