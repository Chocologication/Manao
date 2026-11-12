import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { authErrorCode, getAuthOptions, isNetworkError, register, requestEmailCode } from '../../api/authApi';
import type { AuthOptionsResponse } from '../../contracts/auth';
import { CaptchaField } from './CaptchaField';
import { AuthField, AuthPageFrame } from './AuthPageFrame';
import { validateNewPassword } from './registrationValidation';

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
    options !== null &&
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
    const passwordError = validateNewPassword(password);
    if (passwordError) {
      setError(passwordError);
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
      <Link to="/login" className="entry__text-link">
        返回登录
      </Link>
    </span>
  );

  if (registrationClosed) {
    return (
      <AuthPageFrame title="注册账号" subtitle="创建独立的 Manao 账号。" footer={footer}>
        <p role="status" className="entry__notice">
          注册暂未开放，请联系管理员或稍后再试。
        </p>
      </AuthPageFrame>
    );
  }

  if (options === null && optionsFailed) {
    return (
      <AuthPageFrame title="注册账号" subtitle="创建独立的 Manao 账号。" footer={footer}>
        <p role="alert" className="entry__error">
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
      <form onSubmit={onRegister} noValidate className="entry__fields">
        <AuthField id="register-username" label="用户名" value={username} onChange={setUsername} autoComplete="username" placeholder="3–32 位小写字母、数字或下划线" disabled={sending || submitting} />
        <AuthField id="register-email" label="邮箱" type="email" inputMode="email" value={email} onChange={onEmailChanged} autoComplete="email" placeholder="用于接收验证码" disabled={sending || submitting} />
        <AuthField id="register-password" label="密码" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="8–64 个字符" disabled={sending || submitting} />
        <AuthField id="register-confirm-password" label="确认密码" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="再次输入密码" disabled={sending || submitting} />
        {mailUnavailable ? (
          <p role="status" className="entry__notice">
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
          <p role="status" className="entry__notice">
            {notice}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="entry__error">
            {error}
          </p>
        ) : null}
        {cooldownSeconds > 0 ? (
          <p className="entry__field-hint">重新发送需等待 {cooldownSeconds} 秒</p>
        ) : null}
        {stepTwo ? (
          <div className="entry__fields entry__verification">
            <AuthField id="register-email-code" label="邮箱验证码" inputMode="numeric" value={emailCode} onChange={setEmailCode} autoComplete="one-time-code" placeholder="6 位数字" disabled={submitting} />
            <button
              type="submit"
              disabled={submitting || sending || emailCode.trim().length === 0}
              className="entry__submit"
            >
              {submitting ? '正在注册…' : SUBMIT_LABEL}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void onSendCode()}
          disabled={!canSend}
          className="entry__secondary"
        >
          {sending ? '正在发送…' : stepTwo ? RESEND_LABEL : SEND_LABEL}
        </button>
      </form>
    </AuthPageFrame>
  );
}
