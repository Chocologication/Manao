import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { authErrorCode, getAuthOptions, isNetworkError, register, requestEmailCode } from '../../api/authApi';
import type { AuthOptionsResponse } from '../../contracts/auth';
import { CaptchaField } from './CaptchaField';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
const PASSWORD_MAX_UTF8_BYTES = 72;

export function validateNewPassword(password: string): string | null {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    return '密码需为 8–64 个字符。';
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_UTF8_BYTES) {
    return '密码过长，请缩短后重试。';
  }
  return null;
}

type AuthPageFrameProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/** Shared account-page frame; keeps the three lifecycle pages visually consistent. */
export function AuthPageFrame({ eyebrow, title, subtitle, children, footer }: AuthPageFrameProps) {
  return (
    <main className="relative isolate flex min-h-[100svh] items-center justify-center overflow-hidden bg-[#070a09] px-5 py-10 text-white">
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,rgba(223,255,130,0.08),transparent_40%),linear-gradient(180deg,#0a0f0c,#050807)]"
        aria-hidden="true"
      />
      <section
        aria-label={title}
        className="w-full max-w-xl rounded-xl border border-white/15 bg-black/55 p-6 shadow-[0_32px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8"
      >
        <p className="font-mono text-[11px] uppercase text-[#dfff82]">{eyebrow ?? 'MANAO / ACCOUNT'}</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">{title}</h1>
        {subtitle !== undefined ? <p className="mt-2 text-sm leading-6 text-white/60">{subtitle}</p> : null}
        <div className="mt-6 space-y-4">{children}</div>
        {footer !== undefined ? (
          <div className="mt-6 border-t border-white/10 pt-4 text-xs text-white/50">{footer}</div>
        ) : null}
      </section>
    </main>
  );
}

type AuthFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'text' | 'email' | 'numeric';
  disabled?: boolean;
};

export function AuthField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  placeholder,
  inputMode,
  disabled = false,
}: AuthFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-xs font-medium uppercase text-white/58">
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-label={label}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 w-full rounded-md border border-white/18 bg-white/8 px-3 text-base text-white outline-none transition placeholder:text-white/30 focus:border-white/55 focus:bg-white/12 disabled:opacity-60"
      />
    </div>
  );
}

const SEND_LABEL = '发送邮箱验证码';
const RESEND_LABEL = '重新发送验证码';
const SUBMIT_LABEL = '注册账号';

export function RegisterPage() {
  const navigate = useNavigate();
  const [options, setOptions] = useState<AuthOptionsResponse | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAuthOptions()
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch(() => {
        if (!cancelled) setOptionsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCooldownSeconds((remaining) => (remaining <= 1 ? 0 : remaining - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  const registrationClosed = options !== null && !options.registrationEnabled;
  const mailUnavailable = options !== null && !options.emailAvailable;
  const stepTwo = emailChallengeId !== null;
  const captchaReady = captchaId !== null && captchaAnswer.trim().length > 0;
  const usernameReady = username.trim().length > 0;
  const emailReady = email.trim().length > 0;
  const canSend =
    !sending &&
    !submitting &&
    !registrationClosed &&
    !mailUnavailable &&
    captchaReady &&
    usernameReady &&
    emailReady &&
    password.length > 0 &&
    cooldownSeconds === 0;

  const resetEmailChallenge = useCallback(() => {
    setEmailChallengeId(null);
    setEmailCode('');
    setCooldownSeconds(0);
    setNotice(null);
    setCaptchaAnswer('');
    setCaptchaId(null);
    setCaptchaKey((key) => key + 1);
  }, []);

  function onEmailChanged(value: string): void {
    setEmail(value);
    if (emailChallengeId !== null) {
      // A code is bound to the email that requested it: editing the email must
      // invalidate the old challenge instead of silently submitting it.
      resetEmailChallenge();
    }
    setError(null);
  }

  async function onSendCode(): Promise<void> {
    if (!canSend || captchaId === null) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await requestEmailCode({
        purpose: 'REGISTER_EMAIL',
        email: email.trim().toLowerCase(),
        captchaId,
        captchaAnswer: captchaAnswer.trim(),
      });
      if (!mountedRef.current) return;
      setEmailChallengeId(response.challengeId);
      setCooldownSeconds(response.retryAfterSeconds);
      setNotice('邮箱验证码已发送，请查收邮箱并继续完成注册。');
      setCaptchaAnswer('');
      setCaptchaId(null);
      setCaptchaKey((key) => key + 1);
    } catch (reason) {
      if (!mountedRef.current) return;
      const code = authErrorCode(reason);
      if (code === 'REGISTRATION_CLOSED') {
        setError('注册暂未开放，暂时无法注册新账号。');
      } else if (code === 'MAIL_NOT_CONFIGURED') {
        setError('邮件服务未配置，暂时无法发送验证码。');
      } else if (code === 'MAIL_SEND_FAILED') {
        // A failed send attempt still starts the server-side cooldown.
        setError('邮件发送失败，请稍后重试。');
        setCooldownSeconds(60);
      } else if (code === 'CAPTCHA_INVALID') {
        setError('图形验证码不正确，请重新输入。');
        setCaptchaAnswer('');
        setCaptchaId(null);
        setCaptchaKey((key) => key + 1);
      } else if (code === 'AUTH_RATE_LIMITED') {
        setError('发送过于频繁，请稍后再试。');
        setCooldownSeconds(60);
      } else if (isNetworkError(reason)) {
        setError('网络请求失败，请稍后重试。');
      } else {
        setError('验证码发送失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  async function onRegister(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!stepTwo || submitting || sending) return;
    setError(null);
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致。');
      return;
    }
    const trimmedCode = emailCode.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError('请输入 6 位数字邮箱验证码。');
      return;
    }
    setSubmitting(true);
    try {
      await register({
        username: username.trim().toLowerCase(),
        password,
        email: email.trim().toLowerCase(),
        emailChallengeId: emailChallengeId ?? '',
        emailCode: trimmedCode,
      });
      if (!mountedRef.current) return;
      navigate('/login', { replace: true, state: { registered: true } });
    } catch (reason) {
      if (!mountedRef.current) return;
      const code = authErrorCode(reason);
      if (code === 'USERNAME_TAKEN') {
        setError('用户名已被占用，请更换用户名后重新提交；当前邮箱验证码仍然有效。');
      } else if (code === 'EMAIL_TAKEN') {
        setError('该邮箱已被其他账号使用，请更换邮箱后重新获取验证码。');
      } else if (code === 'EMAIL_CODE_INVALID') {
        setError('邮箱验证码无效或已过期，请重新获取。');
      } else if (code === 'REGISTRATION_CLOSED') {
        setError('注册暂未开放，暂时无法注册新账号。');
      } else if (code === 'VALIDATION_ERROR') {
        setError('用户名、邮箱或密码格式不符合要求，请检查后重试。');
      } else if (code === 'AUTH_RATE_LIMITED') {
        setError('提交过于频繁，请稍后再试。');
      } else if (isNetworkError(reason)) {
        setError('网络请求失败，请稍后重试。');
      } else {
        setError('注册失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const footer = (
    <span>
      已有账号？{' '}
      <Link to="/login" className="text-[#dfff82] hover:underline">
        返回登录
      </Link>
    </span>
  );

  if (registrationClosed) {
    return (
      <AuthPageFrame title="注册账号" subtitle="创建独立的 Manao 账号。" footer={footer}>
        <p role="status" className="rounded-md border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          注册暂未开放，请联系管理员或稍后再试。
        </p>
      </AuthPageFrame>
    );
  }

  if (options === null && optionsFailed) {
    return (
      <AuthPageFrame title="注册账号" subtitle="创建独立的 Manao 账号。" footer={footer}>
        <p role="alert" className="rounded-md border border-red-300/25 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          无法确认注册状态，请稍后刷新页面重试。
        </p>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame
      title="注册账号"
      subtitle="使用用户名、密码和已验证邮箱创建账号；注册成功后返回登录，不会自动登录。"
      footer={footer}
    >
      <form onSubmit={onRegister} noValidate className="space-y-4">
        <AuthField id="register-username" label="用户名" value={username} onChange={setUsername} autoComplete="username" placeholder="3–32 位小写字母、数字或下划线" disabled={sending || submitting} />
        <AuthField id="register-email" label="邮箱" type="email" inputMode="email" value={email} onChange={onEmailChanged} autoComplete="email" placeholder="用于接收验证码" disabled={sending || submitting} />
        <AuthField id="register-password" label="密码" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="8–64 个字符" disabled={sending || submitting} />
        <AuthField id="register-confirm-password" label="确认密码" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="再次输入密码" disabled={sending || submitting} />
        {mailUnavailable ? (
          <p role="status" className="rounded-md border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
            邮件服务未配置，暂时无法发送验证码。
          </p>
        ) : null}
        <CaptchaField
          key={captchaKey}
          answer={captchaAnswer}
          onAnswerChange={setCaptchaAnswer}
          onChallengeChange={setCaptchaId}
          disabled={sending || submitting || mailUnavailable}
        />
        {notice !== null ? (
          <p role="status" className="rounded-md border border-[#dfff82]/30 bg-[#dfff82]/8 px-3 py-2 text-sm text-[#eaffb8]">
            {notice}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="rounded-md border border-red-300/25 bg-red-400/10 px-3 py-2 text-sm text-red-100">
            {error}
          </p>
        ) : null}
        {cooldownSeconds > 0 ? (
          <p className="text-xs text-white/50">重新发送需等待 {cooldownSeconds} 秒</p>
        ) : null}
        {stepTwo ? (
          <div className="space-y-4 border-t border-white/10 pt-4">
            <AuthField id="register-email-code" label="邮箱验证码" inputMode="numeric" value={emailCode} onChange={setEmailCode} autoComplete="one-time-code" placeholder="6 位数字" disabled={submitting} />
            <button
              type="submit"
              disabled={submitting || sending || emailCode.trim().length === 0}
              className="h-11 w-full rounded-md border border-[#dfff82] bg-[#dfff82] px-4 text-sm font-semibold text-[#10140d] transition hover:bg-[#edffb2] disabled:cursor-default disabled:opacity-55"
            >
              {submitting ? '正在注册…' : SUBMIT_LABEL}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void onSendCode()}
          disabled={!canSend}
          className="h-11 w-full rounded-md border border-white/20 bg-white/8 px-4 text-sm font-semibold text-white transition hover:bg-white/14 disabled:cursor-default disabled:opacity-50"
        >
          {sending ? '正在发送…' : stepTwo ? RESEND_LABEL : SEND_LABEL}
        </button>
      </form>
    </AuthPageFrame>
  );
}
