import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { LoginResponse } from '../../contracts/auth';
import type { AnonymousReason, AuthSession, AuthSnapshot } from './authSession';

type AuthContextValue = {
  snapshot: AuthSnapshot;
  authenticate: (response: LoginResponse) => void;
  clear: (reason: AnonymousReason) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: AuthSession;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const value = useMemo<AuthContextValue>(
    () => ({
      snapshot,
      authenticate: session.authenticate,
      clear: session.clear,
    }),
    [session, snapshot],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}
