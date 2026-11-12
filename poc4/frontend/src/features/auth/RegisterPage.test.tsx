import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHttpClient } from '../../api/httpClient';
import { authSession, httpClient } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { AuthProvider } from './AuthProvider';
import { RegisterPage } from './RegisterPage';

const USER_INPUT = '用户名';
const EMAIL_INPUT = '邮箱';
const PASSWORD_INPUT = '密码';
const CONFIRM_PASSWORD_INPUT = '确认密码';
const CAPTCHA_INPUT = '图形验证码';
const CODE_INPUT = '邮箱验证码';
const SEND_LABEL = '发送邮箱验证码';
const SUBMIT_LABEL = '注册账号';

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
    historyAction: echo.getAttribute('data-history-action') ?? '',
    stateJson: echo.getAttribute('data-state') ?? 'null',
  };
}

function renderRegisterPage() {
  setHttpClient(httpClient);
  return render(
    <AuthProvider session={authSession}>
      <MemoryRouter initialEntries={['/register']}>
        <LocationEcho />
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<main>LOGIN_PAGE</main>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function waitForCaptcha() {
  await screen.findByRole('img', { name: CAPTCHA_INPUT });
}

async function fillStepOne(
  user: ReturnType<typeof userEvent.setup>,
  values: { username: string; email: string; password: string; confirmPassword?: string },
) {
  await user.type(screen.getByLabelText(USER_INPUT), values.username);
  await user.type(screen.getByLabelText(EMAIL_INPUT), values.email);
  await user.type(screen.getByLabelText(PASSWORD_INPUT), values.password);
  await user.type(
    screen.getByLabelText(CONFIRM_PASSWORD_INPUT),
    values.confirmPassword ?? values.password,
  );
  await waitForCaptcha();
  await user.type(screen.getByLabelText(CAPTCHA_INPUT), '12345');
}

async function refreshCaptchaAndAnswer(user: ReturnType<typeof userEvent.setup>, answer: string) {
  await user.click(screen.getByRole('button', { name: '刷新图形验证码' }));
  await waitFor(() => expect(screen.getByLabelText(CAPTCHA_INPUT)).toBeEnabled());
  await user.type(screen.getByLabelText(CAPTCHA_INPUT), answer);
}

async function sendEmailCode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: SEND_LABEL }));
  expect(await screen.findByLabelText(CODE_INPUT)).toBeInTheDocument();
}

beforeEach(() => {
  // jsdom has no layout; exercise form behavior without GSAP transform measurement.
  const matchMedia = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...matchMedia(query), matches: query === '(prefers-reduced-motion: reduce)',
  }));
  setHttpClient(httpClient);
});

afterEach(() => {
  cleanup();
  setHttpClient(httpClient);
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
});

describe('RegisterPage', { timeout: 15_000 }, () => {
  it('registers through two in-page steps, then returns to login without a token', async () => {
    const user = userEvent.setup();
    const password = 'carol-pass-1';
    renderRegisterPage();

    await fillStepOne(user, { username: 'newcarol', email: 'carol@example.com', password });
    await sendEmailCode(user);
    expect(screen.getByText(/邮箱验证码已发送/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    const location = readLocation();
    expect(location.pathname).toBe('/login');
    expect(authSession.getSnapshot().status).toBe('anonymous');
    expect(authSession.getAccessToken()).toBeNull();
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain(password);
    expect(stored).not.toContain('123456');
  });

  it('keeps the valid email code after a username conflict so the user can retype the username', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await fillStepOne(user, { username: 'alice', email: 'fresh@example.com', password: 'fresh-pass-1' });
    await sendEmailCode(user);
    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/用户名.*占用|已被占用/);
    expect(screen.getByLabelText(CODE_INPUT)).toHaveValue('123456');
    expect(screen.getByLabelText(USER_INPUT)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(USER_INPUT));
    await user.type(screen.getByLabelText(USER_INPUT), 'freshcarol');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('anonymous');
  });

  it('clears the sent code challenge when the email changes', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await fillStepOne(user, { username: 'mover', email: 'mover@example.com', password: 'mover-pass-1' });
    await sendEmailCode(user);
    expect(screen.getByLabelText(CODE_INPUT)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(EMAIL_INPUT));
    await user.type(screen.getByLabelText(EMAIL_INPUT), 'moved@example.com');

    await waitFor(() => expect(screen.queryByLabelText(CODE_INPUT)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: SEND_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(/邮箱验证码已发送/)).not.toBeInTheDocument();
  });

  it('does not persist the password or the email code across a refresh', async () => {
    const user = userEvent.setup();
    const password = 'refresh-pass-1';
    const view = renderRegisterPage();
    await fillStepOne(user, { username: 'refresher', email: 'refresh@example.com', password });
    await sendEmailCode(user);
    await user.type(screen.getByLabelText(CODE_INPUT), '123456');

    view.unmount();
    renderRegisterPage();

    await waitFor(() => expect(screen.getByLabelText(USER_INPUT)).toHaveValue(''));
    expect(screen.getByLabelText(PASSWORD_INPUT)).toHaveValue('');
    expect(screen.queryByLabelText(CODE_INPUT)).not.toBeInTheDocument();
    await waitForCaptcha();
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain(password);
    expect(stored).not.toContain('123456');
  });

  it('disables resending during the server-provided cooldown', async () => {
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'cooldown', email: 'cooldown@example.com', password: 'cooldown-pass-1' });
    await sendEmailCode(user);

    const resend = screen.getByRole('button', { name: /重新发送/ });
    expect(resend).toBeDisabled();
    expect(screen.getByText(/60 ?秒/)).toBeInTheDocument();
  });

  it('shows an explicit closed state when registration is disabled by the server options', async () => {
    server.use(
      http.get('/api/v1/auth/options', () =>
        HttpResponse.json({ registrationEnabled: false, emailAvailable: true }),
      ),
    );
    renderRegisterPage();

    expect(await screen.findByText(/注册暂未开放/)).toBeInTheDocument();
    expect(screen.queryByLabelText(USER_INPUT)).not.toBeInTheDocument();
  });

  it('shows an explicit mail-not-configured state without blocking the page', async () => {
    server.use(
      http.get('/api/v1/auth/options', () =>
        HttpResponse.json({ registrationEnabled: true, emailAvailable: false }),
      ),
    );
    renderRegisterPage();

    expect(await screen.findByText(/邮件服务.*未配置/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SEND_LABEL })).toBeDisabled();
  });

  it('keeps the send button disabled while the email-code request is pending', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendCalls = 0;
    server.use(
      http.post('/api/v1/auth/email-codes', async () => {
        sendCalls += 1;
        await gate;
        return HttpResponse.json(
          {
            challengeId: 'challenge-pending',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            retryAfterSeconds: 60,
          },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'pending', email: 'pending@example.com', password: 'pending-pass-1' });
    const send = screen.getByRole('button', { name: SEND_LABEL });
    await user.click(send);

    expect(send).toBeDisabled();
    await user.click(send);
    expect(sendCalls).toBe(1);

    release();
    expect(await screen.findByLabelText(CODE_INPUT)).toBeInTheDocument();
  });

  it('keeps an existing login when a public registration request answers a business 422', async () => {
    authSession.authenticate({
      accessToken: 'existing-session-token',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      user: { id: 'usr-existing', username: 'existing', email: null, emailVerified: false },
    });
    server.use(
      http.post('/api/v1/auth/email-codes', () =>
        HttpResponse.json(
          { code: 'CAPTCHA_INVALID', message: 'Captcha is invalid or expired', traceId: 'trace-422' },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, {
      username: 'existing',
      email: 'existing@example.com',
      password: 'existing-pass-1',
    });
    await user.click(screen.getByRole('button', { name: SEND_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/图形验证码不正确/);
    expect(authSession.getSnapshot()).toMatchObject({
      status: 'authenticated',
      accessToken: 'existing-session-token',
    });
  });

  it('keeps the first-step send in cooldown after a rate-limited send even with a fresh captcha', async () => {
    let sendCalls = 0;
    server.use(
      http.post('/api/v1/auth/email-codes', () => {
        sendCalls += 1;
        return HttpResponse.json(
          { code: 'AUTH_RATE_LIMITED', message: 'Too many requests', traceId: 'trace-429' },
          { status: 429, headers: { 'Retry-After': '60' } },
        );
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'rate', email: 'rate@example.com', password: 'rate-pass-1' });
    await user.click(screen.getByRole('button', { name: SEND_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/发送过于频繁/);
    expect(screen.getByText(/60 ?秒/)).toBeInTheDocument();
    await refreshCaptchaAndAnswer(user, '54321');

    const send = screen.getByRole('button', { name: SEND_LABEL });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(sendCalls).toBe(1);
  });

  it('keeps the first-step send in cooldown after a mail send failure', async () => {
    let sendCalls = 0;
    server.use(
      http.post('/api/v1/auth/email-codes', () => {
        sendCalls += 1;
        return HttpResponse.json(
          { code: 'MAIL_SEND_FAILED', message: 'Mail delivery failed', traceId: 'trace-mail' },
          { status: 503 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'mailsend', email: 'mailsend@example.com', password: 'mailsend-pass-1' });
    await user.click(screen.getByRole('button', { name: SEND_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/邮件发送失败/);
    expect(screen.getByText(/60 ?秒/)).toBeInTheDocument();
    await refreshCaptchaAndAnswer(user, '54321');

    const send = screen.getByRole('button', { name: SEND_LABEL });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(sendCalls).toBe(1);
  });

  it('blocks the final register submit while a resend is pending', async () => {
    let sendCalls = 0;
    let releaseResend: () => void = () => {};
    const resendGate = new Promise<void>((resolve) => {
      releaseResend = resolve;
    });
    server.use(
      http.post('/api/v1/auth/email-codes', async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          return HttpResponse.json(
            {
              challengeId: 'challenge-first',
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              retryAfterSeconds: 0,
            },
            { status: 202 },
          );
        }
        await resendGate;
        return HttpResponse.json(
          {
            challengeId: 'challenge-second',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            retryAfterSeconds: 60,
          },
          { status: 202 },
        );
      }),
    );
    let registerCalls = 0;
    server.use(
      http.post('/api/v1/auth/register', () => {
        registerCalls += 1;
        return HttpResponse.json({ user: { id: 'usr-gated', username: 'gated' } }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'gated', email: 'gated@example.com', password: 'gated-pass-1' });
    await sendEmailCode(user);
    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    // The first send consumed the captcha: fill the freshly mounted challenge so
    // the resend button is enabled by the cooldown/captcha rules, then click it.
    await waitFor(() => expect(screen.getByLabelText(CAPTCHA_INPUT)).toBeEnabled());
    await user.type(screen.getByLabelText(CAPTCHA_INPUT), '54321');
    await waitFor(() => expect(screen.getByRole('button', { name: /重新发送/ })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: /重新发送/ }));
    expect(screen.getByRole('button', { name: '正在发送…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: SUBMIT_LABEL })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));
    expect(registerCalls).toBe(0);

    releaseResend();
    await waitFor(() => expect(screen.getByRole('button', { name: SUBMIT_LABEL })).toBeEnabled());
  });

  it('blocks a resend while the final register submit is pending', async () => {
    let releaseRegister: (() => void) | undefined;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    let sendCalls = 0;
    server.use(
      http.post('/api/v1/auth/email-codes', () => {
        sendCalls += 1;
        return HttpResponse.json(
          {
            challengeId: 'challenge-' + sendCalls,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            retryAfterSeconds: 0,
          },
          { status: 202 },
        );
      }),
    );
    server.use(
      http.post('/api/v1/auth/register', async () => {
        await registerGate;
        return HttpResponse.json({ user: { id: 'usr-slow', username: 'slow' } }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, { username: 'slow', email: 'slow@example.com', password: 'slow-pass-1' });
    await sendEmailCode(user);
    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    // Recreate a genuinely resendable state (cooldown 0 + fresh captcha): this is
    // what makes the reverse-mutex assertion meaningful.
    await waitFor(() => expect(screen.getByLabelText(CAPTCHA_INPUT)).toBeEnabled());
    await user.type(screen.getByLabelText(CAPTCHA_INPUT), '54321');
    expect(await screen.findByRole('button', { name: /重新发送/ })).toBeEnabled();
    const sendsBeforeSubmit = sendCalls;

    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));
    expect(await screen.findByRole('button', { name: '正在注册…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重新发送/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /重新发送/ }));
    expect(sendCalls).toBe(sendsBeforeSubmit);

    releaseRegister?.();
    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
  });

  it('blocks registration when the password confirmation differs', async () => {
    let registerCalls = 0;
    server.use(
      http.post('/api/v1/auth/register', () => {
        registerCalls += 1;
        return HttpResponse.json({ user: { id: 'usr-mismatch', username: 'mismatch' } }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRegisterPage();
    await fillStepOne(user, {
      username: 'mismatch',
      email: 'mismatch@example.com',
      password: 'mismatch-pass-1',
      confirmPassword: 'different-pass-1',
    });
    await sendEmailCode(user);
    await user.type(screen.getByLabelText(CODE_INPUT), '123456');
    await user.click(screen.getByRole('button', { name: SUBMIT_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/两次输入的密码不一致/);
    expect(registerCalls).toBe(0);
    expect(screen.queryByText('LOGIN_PAGE')).not.toBeInTheDocument();
  });
});
