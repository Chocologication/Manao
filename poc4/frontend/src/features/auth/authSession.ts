import type { AuthUser, LoginResponse } from '../../contracts/auth';

export type AuthSnapshot =
  | { status: 'anonymous'; reason: 'initial' | 'logout' | 'expired' | 'unauthorized' }
  | { status: 'authenticated'; accessToken: string; expiresAt: string; user: AuthUser };

export type AnonymousReason = Exclude<
  Extract<AuthSnapshot, { status: 'anonymous' }>['reason'],
  'initial'
>;

export type AuthSession = {
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  authenticate(response: LoginResponse): void;
  clear(reason: AnonymousReason): void;
  getAccessToken(): string | null;
};

const INITIAL_SNAPSHOT: AuthSnapshot = { status: 'anonymous', reason: 'initial' };
const MAX_TIMEOUT_MS = 2_147_483_647;

export function createAuthSession(): AuthSession {
  let snapshot: AuthSnapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryGeneration = 0;

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
    expiryGeneration += 1;
    clearExpiryTimer();
    if (snapshot.status === 'anonymous') {
      return;
    }
    snapshot = { status: 'anonymous', reason };
    emit();
  }

  return {
    getSnapshot,
    subscribe,
    authenticate,
    clear,
    getAccessToken,
  };
}
