import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { login } from '../../api/authApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from './AuthProvider';

const DEFAULT_POST_LOGIN_PATH = '/projects';

function resolvePostLoginPath(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  return from;
}

export function LoginPage() {
  const { snapshot, authenticate } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const redirectAfterLoginRef = useRef<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (snapshot.status === 'authenticated') {
    return <Navigate to={redirectAfterLoginRef.current ?? DEFAULT_POST_LOGIN_PATH} replace />;
  }

  const submitDisabled = pending || username.length === 0 || password.length === 0;
  const sessionExpired =
    snapshot.reason === 'unauthorized' || snapshot.reason === 'expired';
  const alertMessage =
    error ?? (sessionExpired ? 'Your session has expired. Please sign in again.' : null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || username.length === 0 || password.length === 0) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await login({ username, password });
      const target = resolvePostLoginPath(
        (location.state as { from?: unknown } | null)?.from,
      );
      redirectAfterLoginRef.current = target;
      authenticate(response);
      await navigate(target, { replace: true });
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) {
        setError('Invalid username or password');
      } else if (reason instanceof Error && /network request failed/i.test(reason.message)) {
        setError('Network request failed');
      } else {
        setError('Unable to sign in');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <form method="post" onSubmit={onSubmit}>
        <label htmlFor="username">Username</label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label htmlFor="password">Password</label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {alertMessage ? <p role="alert">{alertMessage}</p> : null}
        <Button type="submit" disabled={submitDisabled}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
