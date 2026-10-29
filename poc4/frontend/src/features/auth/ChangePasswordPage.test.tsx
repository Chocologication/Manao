import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { HttpClient, setHttpClient } from '../../api/httpClient';
import {
  authSession,
  consumeLoginNotice,
  handleUnauthorized,
  httpClient,
} from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { AuthProvider } from './AuthProvider';
import { ChangePasswordPage } from './ChangePasswordPage';
import { LoginPage } from './LoginPage';
import { RequireAuth } from './RequireAuth';

const CURRENT_INPUT = '当前密码';
const NEW_INPUT = '新密码';
const CONFIRM_INPUT = '确认新密码';
const SUBMIT_LABEL = '修改密码';

function LocationEcho() {
  const location = useLocation();
  const historyAction = useNavigationType();
  return (
    <div
      data-testid="location-echo"
      hidden
      data-pathname={location.pathname}
      data-history-action={historyAction}
      data-state={JSON.stringify(location.state)}
    />
  );
}

function readLocation() {
  const echo = screen.getByTestId('location-echo');
  return {
    pathname: echo.getAttribute('data-pathname') ?? '',
    stateJson: echo.getAttribute('data-state') ?? 'null',
  };
}

function renderChangePasswordPage() {
  setHttpClient(httpClient);
  return render(
    <AuthProvider session={authSession}>
      <MemoryRouter initialEntries={['/account/password']}>
        <LocationEcho />
        <Routes>
          <Route path="/account/password" element={<ChangePasswordPage />} />
          <Route path="/login" element={<main>LOGIN_PAGE</main>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login({ username: 'alice', password: 'demo-pass' });
  authSession.authenticate(response);
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  currentPassword: string,
  newPassword: string,
  confirmPassword = newPassword,
): Promise<void> {
  await user.type(screen.getByLabelText(CURRENT_INPUT), currentPassword);
  await user.type(screen.getByLabelText(NEW_INPUT), newPassword);
  await user.type(screen.getByLabelText(CONFIRM_INPUT), confirmPassword);
}

beforeEach(() => {
  setHttpClient(httpClient);
});

afterEach(() => {
  cleanup();
  setHttpClient(httpClient);
  consumeLoginNotice();
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
});

describe('ChangePasswordPage', { timeout: 15_000 }, () => {
  it('terminates the current session with success feedback only after the password changes', async () => {
    await authenticateAsAlice();
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'demo-pass', 'brand-new-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    const snapshot = authSession.getSnapshot();
    expect(snapshot).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(authSession.getAccessToken()).toBeNull();
    // The confirmation travels as an in-memory one-shot notice: RequireAuth's
    // redirect may overwrite the router location state.
    expect(consumeLoginNotice()).toBe('passwordChanged');
  });

  it('shows an inline error for a wrong current password without logging out', async () => {
    await authenticateAsAlice();
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'wrong-pass', 'brand-new-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/当前密码不正确/);
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(authSession.getAccessToken()).not.toBeNull();
    expect(readLocation().pathname).toBe('/account/password');
    expect(screen.getByLabelText(CURRENT_INPUT)).toBeInTheDocument();
  });

  it('rejects a mismatched confirmation before sending any request', async () => {
    await authenticateAsAlice();
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'demo-pass', 'brand-new-pass-1', 'different-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/两次输入的新密码不一致/);
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(readLocation().pathname).toBe('/account/password');
  });

  it('rejects a new password outside the registration password contract', async () => {
    await authenticateAsAlice();
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'demo-pass', 'short');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/8.*64|至少 8/);
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('keeps the page usable when the network request fails', async () => {
    await authenticateAsAlice();
    server.use(http.post('/api/v1/auth/password-change', () => HttpResponse.error()));
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'demo-pass', 'brand-new-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/网络请求失败/);
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(screen.getByLabelText(CURRENT_INPUT)).toBeInTheDocument();
  });

  it('never logs out a newer login when a stale change-password success arrives', async () => {
    await authenticateAsAlice();
    const originalFetch = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;
    let aResponseSettled = false;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!intercepted && url.endsWith('/api/v1/auth/password-change')) {
        intercepted = true;
        await gate;
      }
      const response = await originalFetch(input, init);
      if (url.endsWith('/api/v1/auth/password-change')) aResponseSettled = true;
      return response;
    }) as typeof fetch;
    setHttpClient(
      new HttpClient({
        getAccessToken: () => authSession.getAccessToken(),
        onUnauthorized: handleUnauthorized,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
      }),
    );
    const user = userEvent.setup();
    renderChangePasswordPage();
    await fillForm(user, 'demo-pass', 'brand-new-pass-1');

    try {
      await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));
      expect(await screen.findByRole('button', { name: '正在修改…' })).toBeDisabled();

      authSession.clear('logout');
      const bob = await login({ username: 'bob', password: 'demo-pass' });
      authSession.authenticate(bob);
      const bobSnapshot = authSession.getSnapshot();
      release();

      // Wait until A's 204 is really back and the page finished handling it, so
      // an unconditional clear would be observed before the assertions run.
      await waitFor(() => expect(aResponseSettled).toBe(true));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: SUBMIT_LABEL })).toBeEnabled(),
      );

      expect(authSession.getSnapshot()).toBe(bobSnapshot);
      expect(bobSnapshot).toMatchObject({
        status: 'authenticated',
        user: { username: 'bob' },
        accessToken: bob.accessToken,
      });
      expect(authSession.getAccessToken()).toBe(bob.accessToken);
      expect(readLocation().pathname).toBe('/account/password');
      expect(screen.queryByText('LOGIN_PAGE')).not.toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows the password-changed confirmation exactly once after the guard redirect', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    await authenticateAsAlice();
    const user = userEvent.setup();
    setHttpClient(httpClient);
    const view = render(
      <AuthProvider session={authSession}>
        <MemoryRouter initialEntries={['/account/password']}>
          <LocationEcho />
          <Routes>
            <Route path="/account" element={<RequireAuth />}>
              <Route path="password" element={<ChangePasswordPage />} />
            </Route>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/projects" element={<main>PROJECTS_PAGE</main>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    await fillForm(user, 'demo-pass', 'brand-new-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    // The protected route's anonymous redirect races the explicit navigate; the
    // one-shot in-memory notice must still surface the confirmation on /login.
    expect(await screen.findByRole('status')).toHaveTextContent('密码已更新');
    expect(readLocation().pathname).toBe('/login');
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain('passwordChanged');
    expect(window.location.href).not.toContain('passwordChanged');
    view.unmount();
  });
});
