import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '../../contracts/auth';
import { createAuthSession } from './authSession';

const liveResponse: LoginResponse = {
  accessToken: 'mem-token',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
};

const timedResponse: LoginResponse = {
  accessToken: 'mem-token',
  expiresAt: '2026-08-21T00:15:00.000Z',
  user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
};

describe('authSession', () => {
  it('starts anonymous with reason initial', () => {
    const session = createAuthSession();

    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'initial' });
    expect(session.getAccessToken()).toBeNull();
  });

  it('authenticate stores the login response in memory', () => {
    const session = createAuthSession();
    const listener = vi.fn();
    session.subscribe(listener);

    session.authenticate(liveResponse);

    expect(session.getSnapshot()).toEqual({
      status: 'authenticated',
      accessToken: 'mem-token',
      expiresAt: liveResponse.expiresAt,
      user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
    });
    expect(session.getAccessToken()).toBe('mem-token');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear logout returns to anonymous without retaining the token', () => {
    const session = createAuthSession();
    session.authenticate(liveResponse);

    session.clear('logout');

    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(session.getAccessToken()).toBeNull();
  });

  it('duplicate clear is idempotent', () => {
    const session = createAuthSession();
    session.authenticate(liveResponse);
    const listener = vi.fn();
    session.subscribe(listener);

    session.clear('logout');
    session.clear('logout');
    session.clear('unauthorized');

    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not write the token to localStorage, sessionStorage, URL, or logs', () => {
    const session = createAuthSession();
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem');
    const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const consoleSpies = consoleMethods.map((method) => vi.spyOn(console, method));

    session.authenticate(liveResponse);
    session.clear('logout');

    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain('mem-token');
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        expect(JSON.stringify(args)).not.toContain('mem-token');
      }
    }
  });
});

describe('authSession absolute expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('becomes anonymous with reason expired at the absolute expiresAt', () => {
    const session = createAuthSession();
    session.authenticate(timedResponse);

    vi.advanceTimersByTime(15 * 60 * 1000 - 1);
    expect(session.getSnapshot().status).toBe('authenticated');
    expect(session.getAccessToken()).toBe('mem-token');

    vi.advanceTimersByTime(1);
    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'expired' });
    expect(session.getAccessToken()).toBeNull();
  });

  it('does not expire after logout when the original timer elapses', () => {
    const session = createAuthSession();
    session.authenticate(timedResponse);
    session.clear('logout');

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
  });
});
describe('authSession unified termination onBeforeClear', () => {
  it('calls onBeforeClear with the previous snapshot and expired reason before anonymous state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
    try {
      const beforeClear = vi.fn();
      const session = createAuthSession({ onBeforeClear: beforeClear });
      session.authenticate(timedResponse);
      const previous = session.getSnapshot();
      vi.setSystemTime(new Date(timedResponse.expiresAt));
      vi.runOnlyPendingTimers();
      expect(beforeClear).toHaveBeenCalledWith(previous, 'expired');
      expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the callback with the previous user and reason before the anonymous listener fires', () => {
    const order: string[] = [];
    let snapshotDuringCallback: unknown;
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });
    beforeClear.mockImplementation(() => {
      snapshotDuringCallback = session.getSnapshot();
      order.push('callback');
    });
    session.subscribe(() => {
      order.push(`listener:${session.getSnapshot().status}`);
    });
    session.authenticate(liveResponse);
    const previous = session.getSnapshot();
    order.length = 0;

    session.clear('logout');

    expect(beforeClear).toHaveBeenCalledWith(previous, 'logout');
    expect(snapshotDuringCallback).toEqual(previous);
    expect(order).toEqual(['callback', 'listener:anonymous']);
    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(session.getAccessToken()).toBeNull();
  });

  it('runs the callback for the unauthorized 401 reason', () => {
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });
    session.authenticate(liveResponse);
    const previous = session.getSnapshot();

    session.clear('unauthorized');

    expect(beforeClear).toHaveBeenCalledWith(previous, 'unauthorized');
    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
  });

  it('does not run the callback before the first login or for duplicate clears', () => {
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });

    session.clear('logout');
    expect(beforeClear).not.toHaveBeenCalled();

    session.authenticate(liveResponse);
    expect(beforeClear).not.toHaveBeenCalled();

    session.clear('logout');
    session.clear('logout');
    session.clear('unauthorized');

    expect(beforeClear).toHaveBeenCalledTimes(1);
    expect(beforeClear).toHaveBeenCalledWith(expect.objectContaining({ status: 'authenticated' }), 'logout');
    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
  });

  it('still clears authentication when the cleanup callback throws', () => {
    const session = createAuthSession({
      onBeforeClear: () => {
        throw new Error('cleanup failed');
      },
    });
    session.authenticate(liveResponse);

    expect(() => session.clear('unauthorized')).not.toThrow();

    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(session.getAccessToken()).toBeNull();
  });

  it('guards reentrant clear from inside the cleanup callback', () => {
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });
    beforeClear.mockImplementation(() => {
      session.clear('unauthorized');
    });
    session.authenticate(liveResponse);
    const listener = vi.fn();
    session.subscribe(listener);

    session.clear('logout');

    expect(beforeClear).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
  });

  it('ends the previous session before authenticate accepts a replacement login', () => {
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });
    session.authenticate(liveResponse);
    const previous = session.getSnapshot();
    const replacement: LoginResponse = {
      accessToken: 'second-token',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      user: { id: 'u2', username: 'bob', email: null, emailVerified: false },
    };

    session.authenticate(replacement);

    expect(beforeClear).toHaveBeenCalledTimes(1);
    expect(beforeClear).toHaveBeenCalledWith(previous, 'logout');
    expect(session.getSnapshot()).toEqual({
      status: 'authenticated',
      accessToken: 'second-token',
      expiresAt: replacement.expiresAt,
      user: { id: 'u2', username: 'bob', email: null, emailVerified: false },
    });
  });

  it('does not call the callback when authenticate starts from anonymous', () => {
    const beforeClear = vi.fn();
    const session = createAuthSession({ onBeforeClear: beforeClear });

    session.authenticate(liveResponse);

    expect(beforeClear).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ status: 'authenticated' });
  });

  it('does not let the previous expiry timer clear a newly authenticated session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
    try {
      const session = createAuthSession();
      session.authenticate(timedResponse);
      const replacement: LoginResponse = {
        accessToken: 'new-token',
        expiresAt: '2026-08-21T01:00:00.000Z',
        user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
      };
      session.authenticate(replacement);

      // The replaced session's 15-minute timer would fire here if it were still armed.
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(session.getSnapshot()).toEqual({
        status: 'authenticated',
        accessToken: 'new-token',
        expiresAt: replacement.expiresAt,
        user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
      });
      expect(session.getAccessToken()).toBe('new-token');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a login accepted during cleanup and arms its expiry instead of overwriting it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));
    try {
      const expiredAlice: LoginResponse = {
        accessToken: 'alice-expired-token',
        expiresAt: '2026-08-24T10:30:00.000Z',
        user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
      };
      const replacementBob: LoginResponse = {
        accessToken: 'bob-replacement-token',
        expiresAt: '2026-08-24T11:00:00.000Z',
        user: { id: 'u2', username: 'bob', email: null, emailVerified: false },
      };
      const beforeClear = vi.fn();
      const session = createAuthSession({ onBeforeClear: beforeClear });
      beforeClear.mockImplementation((previous) => {
        if (previous.user.id === 'u1') {
          session.authenticate(replacementBob);
        }
      });
      session.authenticate(expiredAlice);
      const emittedStatuses: string[] = [];
      session.subscribe(() => {
        emittedStatuses.push(session.getSnapshot().status);
      });

      // The expiry timer calls clear('expired') when it fires; drive the same call
      // directly so the reentrant login inside the cleanup callback is deterministic.
      session.clear('expired');

      expect(beforeClear).toHaveBeenCalledTimes(1);
      expect(beforeClear).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'authenticated', user: { id: 'u1', username: 'alice', email: null, emailVerified: false } }),
        'expired',
      );
      expect(session.getSnapshot()).toEqual({
        status: 'authenticated',
        accessToken: replacementBob.accessToken,
        expiresAt: replacementBob.expiresAt,
        user: replacementBob.user,
      });
      expect(emittedStatuses).not.toContain('anonymous');
      expect(session.getAccessToken()).toBe('bob-replacement-token');

      // The replacement login's own absolute expiry timer is armed.
      vi.advanceTimersByTime(60 * 60 * 1000 - 1);
      expect(session.getSnapshot()).toMatchObject({
        status: 'authenticated',
        accessToken: 'bob-replacement-token',
      });
      vi.advanceTimersByTime(1);
      expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the replacement session timer when the cleanup callback clears reentrantly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));
    try {
      const expiredAlice: LoginResponse = {
        accessToken: 'alice-expired-token',
        expiresAt: '2026-08-24T10:30:00.000Z',
        user: { id: 'u1', username: 'alice', email: null, emailVerified: false },
      };
      const replacementBob: LoginResponse = {
        accessToken: 'bob-replacement-token',
        expiresAt: '2026-08-24T11:00:00.000Z',
        user: { id: 'u2', username: 'bob', email: null, emailVerified: false },
      };
      const beforeClear = vi.fn();
      const session = createAuthSession({ onBeforeClear: beforeClear });
      beforeClear.mockImplementation((previous) => {
        if (previous.user.id === 'u1') {
          session.authenticate(replacementBob);
          // This reentrant clear is ignored; it must not cancel Bob's expiry timer.
          session.clear('unauthorized');
        }
      });
      session.authenticate(expiredAlice);

      session.clear('expired');

      expect(beforeClear).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toEqual({
        status: 'authenticated',
        accessToken: replacementBob.accessToken,
        expiresAt: replacementBob.expiresAt,
        user: replacementBob.user,
      });

      // Bob's timer survived the ignored reentrant clear and clears him at his own expiry.
      vi.advanceTimersByTime(60 * 60 * 1000 - 1);
      expect(session.getSnapshot()).toMatchObject({
        status: 'authenticated',
        accessToken: 'bob-replacement-token',
      });
      vi.advanceTimersByTime(1);

      expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'expired' });
      expect(beforeClear).toHaveBeenCalledTimes(2);
      expect(beforeClear).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'authenticated', user: { id: 'u2', username: 'bob', email: null, emailVerified: false } }),
        'expired',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
