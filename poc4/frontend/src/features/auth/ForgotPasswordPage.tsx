import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  authErrorCode,
  getAuthOptions,
  isNetworkError,
  requestEmailCode,
  resetPassword,
} from '../../api/authApi';
import { AuthField, AuthPageFrame, validateNewPassword } from './RegisterPage';
import { CaptchaField } from './CaptchaField';

export const UNIFORM_RECOVERY_NOTICE = '若该邮箱已绑定账号，将收到验证码';

const SEND_LABEL = '发送找回验证码';
const SUBMIT_LABEL = '重置密码';

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [mailAvailable, setMailAvailable] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
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
        if (!cancelled) setMailAvailable(next.emailAvailable);
      })
      .catch(() => {
        if (!cancelled) setMailAvailable(null);
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

  const stepTwo = emailChallengeId !== null;
  const mailUnavailable = mailAvailable === false;
  const captchaReady = captchaId !== null && captchaAnswer.trim().length > 0;
  const canSend =
    !sending &&
    !submitting &&
    !mailUnavailable &&
    captchaReady &&
    email.trim().length > 0 &&
    cooldownSeconds === 0;

  const resetChallenge = useCallback(() => {
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
    if (emailChallengeId !== null) resetChallenge();
    setError(null);
  }

  function showUniformNotice(): void {
    setNotice(UNIFORM_RECOVERY_NOTICE);
    setError(null);
  }

  async function onSendCode(): Promise<void> {
    if (!canSend || captchaId === null) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await requestEmailCode({
        purpose: 'RESET_PASSWORD',
        email: email.trim().toLowerCase(),
        captchaId,
        captchaAnswer: captchaAnswer.trim(),
      });
      if (!mountedRef.current) return;
      setEmailChallengeId(response.challengeId);
      setCooldownSeconds(response.retryAfterSeconds);
      showUniformNotice();
      setCaptchaAnswer('');
      setCaptchaId(null);
      setCaptchaKey((key) => key + 1);
    } catch (reason) {
      if (!mountedRef.current) return;
      const code = authErrorCode(reason);
      if (code === 'MAIL_NOT_CONFIGURED') {
        setError('邮件服务未配置，暂时无法发送验证码。');
      } else if (code === 'AUTH_RATE_LIMITED') {
        setError('发送过于频繁，请稍后再试。');
        setCooldownSeconds(60);
      } else if (code === 'CAPTCHA_INVALID') {
        setError('图形验证码不正确，请重新输入。');
        setCaptchaAnswer('');
        setCaptchaId(null);
        setCaptchaKey((key) => key + 1);
      } else if (code === 'VALIDATION_ERROR') {
        setError('邮箱格式不正确，请检查后重试。');
      } else if (isNetworkError(reason)) {
        // A failed send must not reveal whether the email is bound: use the
        // same uniform notice as a normal 202 response.
        showUniformNotice();
      } else {
        showUniformNotice();
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  async function onReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!stepTwo || submitting || sending) return;
    setError(null);
    const trimmedCode = emailCode.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError('请输入 6 位数字邮箱验证码。');
      return;
    }
    const passwordError = validateNewPassword(newPassword);
    if (passwordError !== null) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword({
        email: email.trim().toLowerCase(),
        emailChallengeId: emailChallengeId ?? '',
        emailCode: trimmedCode,
        newPassword,
      });
      if (!mountedRef.current) return;
      navigate('/login', { replace: true, state: { passwordReset: true } });
    } catch (reason) {
      if (!mountedRef.current) return;
      const code = authErrorCode(reason);
      if (code === 'EMAIL_CODE_INVALID') {
        setError('邮箱验证码无效或已过期，请重新获取。');
      } else if (code === 'VALIDATION_ERROR') {
        setError('新密码格式不符合要求，请检查后重试。');
      } else if (code === 'AUTH_RATE_LIMITED') {
        setError('提交过于频繁，请稍后再试。');
      } else if (isNetworkError(reason)) {
        setError('网络请求失败，请稍后重试。');
      } else {
        setError('密码重置失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const footer = (
    <div className="space-y-2">
      <p>未绑定邮箱的历史账号无法通过邮箱找回密码，请在登录后使用「修改密码」。</p>
      <p>
        想起密码了？{' '}
        <Link to="/login" className="text-[#dfff82] hover:underline">
          返回登录
        </Link>
      </p>
    </div>
  );

  return (
    <AuthPageFrame
      title="找回密码"
      subtitle="通过已绑定邮箱的验证码重置密码；重置成功后返回登录。"
      footer={footer}
    >
      <form onSubmit={onReset} noValidate className="space-y-4">
        <AuthField
          id="forgot-email"
          label="邮箱"
          type="email"
          inputMode="email"
          value={email}
          onChange={onEmailChanged}
          autoComplete="email"
          placeholder="账号绑定的邮箱"
          disabled={sending || submitting}
        />
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
            <AuthField
              id="forgot-email-code"
              label="邮箱验证码"
              inputMode="numeric"
              value={emailCode}
              onChange={setEmailCode}
              autoComplete="one-time-code"
              placeholder="6 位数字"
              disabled={submitting}
            />
            <AuthField
              id="forgot-new-password"
              label="新密码"
              type="password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              placeholder="8–64 个字符"
              disabled={submitting}
            />
            <AuthField
              id="forgot-confirm-new-password"
              label="确认新密码"
              type="password"
              value={confirmNewPassword}
              onChange={setConfirmNewPassword}
              autoComplete="new-password"
              placeholder="再次输入新密码"
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={submitting || sending || emailCode.trim().length === 0 || newPassword.length === 0}
              className="h-11 w-full rounded-md border border-[#dfff82] bg-[#dfff82] px-4 text-sm font-semibold text-[#10140d] transition hover:bg-[#edffb2] disabled:cursor-default disabled:opacity-55"
            >
              {submitting ? '正在重置…' : SUBMIT_LABEL}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void onSendCode()}
          disabled={!canSend}
          className="h-11 w-full rounded-md border border-white/20 bg-white/8 px-4 text-sm font-semibold text-white transition hover:bg-white/14 disabled:cursor-default disabled:opacity-50"
        >
          {sending ? '正在发送…' : stepTwo ? '重新发送验证码' : SEND_LABEL}
        </button>
      </form>
    </AuthPageFrame>
  );
}
