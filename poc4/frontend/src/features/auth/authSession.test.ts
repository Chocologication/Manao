import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '../../contracts/auth';
import { createAuthSession } from './authSession';

const liveResponse: LoginResponse = {
  accessToken: 'mem-token',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  user: { id: 'u1', username: 'alice' },
};

const timedResponse: LoginResponse = {
  accessToken: 'mem-token',
  expiresAt: '2026-08-21T00:15:00.000Z',
  user: { id: 'u1', username: 'alice' },
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
      user: { id: 'u1', username: 'alice' },
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
