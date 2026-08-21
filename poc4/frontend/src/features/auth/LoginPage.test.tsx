import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from 'react-router';
import type { LoginResponse } from '../../contracts/auth';
import { HttpClient, setHttpClient } from '../../api/httpClient';
import { AuthProvider } from './AuthProvider';
import { createAuthSession, type AuthSession } from './authSession';
import { LoginPage } from './LoginPage';
import { RequireAuth } from './RequireAuth';

const loginResponse: LoginResponse = {
  accessToken: 'mem-token',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  user: { id: 'u1', username: 'alice' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorizedBody() {
  return {
    code: 'UNAUTHENTICATED' as const,
    message: 'Invalid username or password',
    traceId: 'trace-login',
  };
}

function installClient(session: AuthSession, fetchImpl: typeof fetch): void {
  setHttpClient(
    new HttpClient({
      getAccessToken: () => session.getAccessToken(),
      onUnauthorized: () => {
        session.clear('unauthorized');
      },
      fetchImpl,
    }),
  );
}

function LocationEcho() {
  const location = useLocation();
  const historyAction = useNavigationType();
  return (
    <div
      data-testid="location-echo"
      data-pathname={location.pathname}
      data-search={location.search}
      data-history-action={historyAction}
      data-state={JSON.stringify(location.state)}
    />
  );
}

function readLocation() {
  const echo = screen.getByTestId('location-echo');
  return {
    pathname: echo.getAttribute('data-pathname') ?? '',
    search: echo.getAttribute('data-search') ?? '',
    historyAction: echo.getAttribute('data-history-action') ?? '',
    stateJson: echo.getAttribute('data-state') ?? 'null',
  };
}

function renderAuthApp(options: {
  session?: AuthSession;
  initialEntries?: Array<string | { pathname: string; search?: string; state?: unknown }>;
}) {
  const session = options.session ?? createAuthSession();
  const view = render(
    <AuthProvider session={session}>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/login']}>
        <LocationEcho />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/projects" element={<main>Projects</main>} />
            <Route path="/projects/:projectId" element={<main>Project</main>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

  return { ...view, session };
}

afterEach(() => {
  cleanup();
  setHttpClient(null);
});

describe('LoginPage', () => {
  it('renders username and password inputs with explicit labels', () => {
    renderAuthApp({});

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('disables submit when either input is blank', async () => {
    const user = userEvent.setup();
    renderAuthApp({});
    const submit = screen.getByRole('button', { name: /sign in/i });

    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Username'), 'alice');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText('Username'));
    expect(submit).toBeDisabled();
  });

  it('disables submit while login is pending', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    let resolveLogin: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    installClient(session, fetchImpl);
    renderAuthApp({ session });

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    const submit = screen.getByRole('button', { name: /sign in/i });
    await user.click(submit);

    expect(submit).toBeDisabled();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();

    resolveLogin?.(jsonResponse(loginResponse));
    expect(await screen.findByText('Projects')).toBeInTheDocument();
  });

  it('shows an alert for invalid credentials without echoing the password', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    const password = 'super-secret-password';
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(unauthorizedBody(), 401));
    installClient(session, fetchImpl);
    renderAuthApp({ session });

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid/i);
    expect(alert).not.toHaveTextContent(password);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(session.getSnapshot().status).toBe('anonymous');
    expect(window.location.href).not.toContain(password);
  });

  it('keeps a network error on the page and allows retry', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(loginResponse));
    installClient(session, fetchImpl);
    renderAuthApp({ session });

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/network request failed/i);
    expect(alert).not.toHaveTextContent('demo-pass');
    expect(screen.getByLabelText('Username')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('Projects')).toBeInTheDocument();
    expect(session.getAccessToken()).toBe('mem-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stores the response in memory and replaces history with the protected target', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(loginResponse));
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem');
    installClient(session, fetchImpl);
    renderAuthApp({
      session,
      initialEntries: [{ pathname: '/login', state: { from: '/projects/prj-1' } }],
    });

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(session.getSnapshot()).toEqual({
      status: 'authenticated',
      accessToken: 'mem-token',
      expiresAt: loginResponse.expiresAt,
      user: { id: 'u1', username: 'alice' },
    });
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    const location = readLocation();
    expect(location.pathname).toBe('/projects/prj-1');
    expect(location.historyAction).toBe('REPLACE');
    expect(location.search).toBe('');
    expect(location.stateJson).not.toContain('demo-pass');
    expect(location.stateJson).not.toContain('mem-token');
    expect(`${location.pathname}${location.search}`).not.toContain('demo-pass');
  });

  it('ignores query from and unsafe location state, defaulting to /projects', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(loginResponse));
    installClient(session, fetchImpl);
    renderAuthApp({
      session,
      initialEntries: [
        {
          pathname: '/login',
          search: '?from=https://evil.example/phish',
          state: { from: '//evil.example' },
        },
      ],
    });

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Projects')).toBeInTheDocument();
    const location = readLocation();
    expect(location.pathname).toBe('/projects');
    expect(location.search).toBe('');
  });

  it('redirects authenticated visitors of /login to /projects even when from is present', () => {
    const session = createAuthSession();
    session.authenticate(loginResponse);
    renderAuthApp({
      session,
      initialEntries: [{ pathname: '/login', state: { from: '/projects/prj-1' } }],
    });

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(readLocation().pathname).toBe('/projects');
  });

  it('shows one expired-session alert when the session reason is unauthorized', () => {
    const session = createAuthSession();
    session.authenticate(loginResponse);
    session.clear('unauthorized');
    renderAuthApp({ session, initialEntries: ['/login'] });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/session has expired/i);
    expect(alerts[0]).not.toHaveTextContent('mem-token');
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('shows one expired-session alert when the session reason is expired', () => {
    const session = createAuthSession();
    session.authenticate(loginResponse);
    session.clear('expired');
    renderAuthApp({ session, initialEntries: ['/login'] });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/session has expired/i);
  });

  it('does not show an expired-session message after logout', () => {
    const session = createAuthSession();
    session.authenticate(loginResponse);
    session.clear('logout');
    renderAuthApp({ session, initialEntries: ['/login'] });

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  it('redirects anonymous users from protected routes to /login with in-app pathname state', async () => {
    const user = userEvent.setup();
    const session = createAuthSession();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(loginResponse));
    installClient(session, fetchImpl);
    renderAuthApp({
      session,
      initialEntries: ['/projects/prj-1'],
    });

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    const loginLocation = readLocation();
    expect(loginLocation.pathname).toBe('/login');
    expect(JSON.parse(loginLocation.stateJson)).toEqual({ from: '/projects/prj-1' });
    expect(loginLocation.historyAction).toBe('REPLACE');
    expect(loginLocation.search).toBe('');

    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'demo-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(readLocation().pathname).toBe('/projects/prj-1');
  });
});
