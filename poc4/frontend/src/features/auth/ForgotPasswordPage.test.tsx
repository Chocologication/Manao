import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setHttpClient } from '../../api/httpClient';
import { authSession, httpClient } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { AuthProvider } from './AuthProvider';
import { ForgotPasswordPage } from './ForgotPasswordPage';

const EMAIL_INPUT = '邮箱';
const CAPTCHA_INPUT = '图形验证码';
const CODE_INPUT = '邮箱验证码';
const NEW_PASSWORD_INPUT = '新密码';
const SEND_LABEL = '发送找回验证码';
const SUBMIT_LABEL = '重置密码';
const UNIFORM_NOTICE = '若该邮箱已绑定账号，将收到验证码';

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

function renderForgotPage() {
  setHttpClient(httpClient);
  return render(
    <AuthProvider session={authSession}>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <LocationEcho />
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<main>LOGIN_PAGE</main>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function requestCode(
  user: ReturnType<typeof userEvent.setup>,
  email: string,
): Promise<void> {
  await user.type(screen.getByLabelText(EMAIL_INPUT), email);
  await screen.findByRole('img', { name: CAPTCHA_INPUT });
  await user.type(screen.getByLabelText(CAPTCHA_INPUT), '12345');
  await user.click(screen.getByRole('button', { name: SEND_LABEL }));
}

beforeEach(() => {
  setHttpClient(httpClient);
});

afterEach(() => {
  cleanup();
  setHttpClient(httpClient);
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
});

describe('ForgotPasswordPage', { timeout: 15_000 }, () => {
  it('resets the password through two in-page steps and returns to login without a token', async () => {
    const user = userEvent.setup();
    const newPassword = 'reborn-pass-1';
    renderForgotPage();

    await requestCode(user, 'alice@example.com');
    expect(await screen.findByText(UNIFORM_NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText(CODE_INPUT)).toBeInTheDocument();

    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    await user.type(screen.getByLabelText(NEW_PASSWORD_INPUT), newPassword);
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    expect(readLocation().pathname).toBe('/login');
    expect(readLocation().stateJson).toContain('passwordReset');
    expect(authSession.getSnapshot().status).toBe('anonymous');
    expect(authSession.getAccessToken()).toBeNull();
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain(newPassword);
    expect(stored).not.toContain('123456');
  });

  it('returns the same uniform notice for an unknown email as for a bound email', async () => {
    const user = userEvent.setup();
    renderForgotPage();
    await requestCode(user, 'nobody@example.com');

    const unknownNotice = await screen.findByText(UNIFORM_NOTICE);
    expect(unknownNotice).toBeInTheDocument();
    expect(screen.queryByText(/不存在|未注册|未知邮箱/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(CODE_INPUT)).toBeInTheDocument();
  });

  it('shows the same uniform notice when the send request fails, without leaking why', async () => {
    server.use(http.post('/api/v1/auth/email-codes', () => HttpResponse.error()));
    const user = userEvent.setup();
    renderForgotPage();
    await requestCode(user, 'nobody@example.com');

    expect(await screen.findByText(UNIFORM_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/网络请求失败|邮件发送失败|不存在/)).not.toBeInTheDocument();
  });

  it('keeps the anonymous session when the reset code is rejected', async () => {
    server.use(
      http.post('/api/v1/auth/password-reset', () =>
        HttpResponse.json(
          { code: 'EMAIL_CODE_INVALID', message: 'Invalid email code', traceId: 'trace-reset' },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderForgotPage();
    await requestCode(user, 'alice@example.com');
    await screen.findByLabelText(CODE_INPUT);
    await user.type(screen.getByLabelText(CODE_INPUT), '000000');
    await user.type(screen.getByLabelText(NEW_PASSWORD_INPUT), 'invalid-pass-1');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/邮箱验证码无效/);
    expect(authSession.getSnapshot().status).toBe('anonymous');
    expect(authSession.getAccessToken()).toBeNull();
    expect(readLocation().pathname).toBe('/forgot-password');
    expect(screen.getByLabelText(CODE_INPUT)).toBeInTheDocument();
  });

  it('shows an explicit mail-not-configured state instead of a fake send', async () => {
    server.use(
      http.get('/api/v1/auth/options', () =>
        HttpResponse.json({ registrationEnabled: true, emailAvailable: false }),
      ),
    );
    renderForgotPage();

    expect(await screen.findByText(/邮件服务.*未配置/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SEND_LABEL })).toBeDisabled();
  });

  it('tells legacy accounts without a bound email that email recovery is unavailable', () => {
    renderForgotPage();

    expect(screen.getByText(/未绑定邮箱/)).toBeInTheDocument();
    expect(screen.getByText(/无法通过邮箱找回/)).toBeInTheDocument();
  });
});
