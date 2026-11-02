import type { AuthUser, LoginResponse } from '../../contracts/auth';

export type AuthSnapshot =
  | { status: 'anonymous'; reason: 'initial' | 'logout' | 'expired' | 'unauthorized' }
  | { status: 'authenticated'; accessToken: string; expiresAt: string; user: AuthUser };

export type AuthenticatedSnapshot = Extract<AuthSnapshot, { status: 'authenticated' }>;

export type AnonymousReason = Exclude<
  Extract<AuthSnapshot, { status: 'anonymous' }>['reason'],
  'initial'
>;

export type AuthSessionOptions = {
  /**
   * Runs once per authenticated session, synchronously before the anonymous
   * snapshot is emitted, so logout/expiry/401 share one cleanup path.
   */
  onBeforeClear?: (previous: AuthenticatedSnapshot, reason: AnonymousReason) => void;
};

export type AuthSession = {
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  authenticate(response: LoginResponse): void;
  clear(reason: AnonymousReason): void;
  getAccessToken(): string | null;
};

const INITIAL_SNAPSHOT: AuthSnapshot = { status: 'anonymous', reason: 'initial' };
const MAX_TIMEOUT_MS = 2_147_483_647;

export function createAuthSession(options: AuthSessionOptions = {}): AuthSession {
  let snapshot: AuthSnapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryGeneration = 0;
  let clearing = false;

  function emit(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function clearExpiryTimer(): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function scheduleExpiry(expiresAt: string): void {
    clearExpiryTimer();
    expiryGeneration += 1;
    const generation = expiryGeneration;
    const expiresMs = Date.parse(expiresAt);

    function arm(): void {
      if (generation !== expiryGeneration) {
        return;
      }
      const remaining = Number.isFinite(expiresMs) ? expiresMs - Date.now() : 0;
      if (remaining <= 0) {
        clear('expired');
        return;
      }
      // setTimeout delay is a 32-bit signed int; re-arm until absolute expiresAt.
      expiryTimer = setTimeout(() => {
        expiryTimer = null;
        arm();
      }, Math.min(remaining, MAX_TIMEOUT_MS));
    }

    arm();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): AuthSnapshot {
    return snapshot;
  }

  function getAccessToken(): string | null {
    return snapshot.status === 'authenticated' ? snapshot.accessToken : null;
  }

  function authenticate(response: LoginResponse): void {
    // A replacement login ends the previous authenticated session first so its
    // user-scoped ids, connections, buffers and cache never leak into the new one.
    if (snapshot.status === 'authenticated') {
      clear('logout');
    }
    snapshot = {
      status: 'authenticated',
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      user: response.user,
    };
    scheduleExpiry(response.expiresAt);
    emit();
  }

  function clear(reason: AnonymousReason): void {
    // An ignored reentrant clear (a cleanup step ending the session again) must not
    // cancel the expiry timer of a replacement session accepted during that cleanup.
    if (clearing) {
      return;
    }
    expiryGeneration += 1;
    clearExpiryTimer();
    // Repeated clears are no-ops: one session runs its cleanup exactly once.
    if (snapshot.status !== 'authenticated') {
      return;
    }
    const previous = snapshot;
    clearing = true;
    try {
      try {
        options.onBeforeClear?.(previous, reason);
      } catch {
        // A failing cleanup observer must not keep the stale credentials alive.
      }
    } finally {
      // A cleanup step (or a disposer it runs) may have accepted a replacement
      // login while this clear was in progress: never overwrite that newer session.
      if (snapshot === previous) {
        snapshot = { status: 'anonymous', reason };
      }
      clearing = false;
      emit();
    }
  }

  return {
    getSnapshot,
    subscribe,
    authenticate,
    clear,
    getAccessToken,
  };
}
