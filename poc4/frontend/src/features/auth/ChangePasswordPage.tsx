import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { authErrorCode, changePassword, isNetworkError } from '../../api/authApi';
import { authSession } from '../../app/appRuntime';
import { useAuth } from './AuthProvider';
import { AuthField, AuthPageFrame, validateNewPassword } from './RegisterPage';

const CURRENT_INPUT = '当前密码';
const NEW_INPUT = '新密码';
const CONFIRM_INPUT = '确认新密码';
const SUBMIT_LABEL = '修改密码';

export function ChangePasswordPage() {
  const { snapshot, clear } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (currentPassword.length === 0) {
      setError('请输入当前密码。');
      return;
    }
    const passwordError = validateNewPassword(newPassword);
    if (passwordError !== null) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    // Capture the exact session object this request belongs to: a success that
    // arrives after a logout/login must never terminate the newer session.
    const expectedSnapshot = authSession.getSnapshot();
    if (expectedSnapshot.status !== 'authenticated') {
      setError('当前会话已失效，请重新登录。');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      if (!mountedRef.current) return;
      if (authSession.getSnapshot() === expectedSnapshot) {
        clear('logout');
        navigate('/login', { replace: true, state: { passwordChanged: true } });
        return;
      }
    } catch (reason) {
      if (!mountedRef.current) return;
      const code = authErrorCode(reason);
      if (code === 'CURRENT_PASSWORD_INVALID') {
        setError('当前密码不正确，请重新输入。');
      } else if (code === 'VALIDATION_ERROR') {
        setError('新密码格式不符合要求，请检查后重试。');
      } else if (code === 'AUTH_RATE_LIMITED') {
        setError('提交过于频繁，请稍后再试。');
      } else if (isNetworkError(reason)) {
        setError('网络请求失败，请稍后重试。');
      } else {
        setError('修改密码失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const footer = (
    <span>
      修改密码后需要重新登录；后台运行中的任务不会停止。{' '}
      <Link to="/projects" className="text-[#dfff82] hover:underline">
        返回工作台
      </Link>
    </span>
  );

  if (snapshot.status !== 'authenticated') {
    return (
      <AuthPageFrame title="修改密码" subtitle="为当前登录账号设置新密码。" footer={footer}>
        <p role="status" className="rounded-md border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          当前未登录，请先登录后再修改密码。
        </p>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame
      title="修改密码"
      subtitle="修改成功后，当前账号的所有旧登录凭据和显示连接都会失效，需要重新登录。"
      footer={footer}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <AuthField
          id="change-current-password"
          label={CURRENT_INPUT}
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          placeholder="当前使用的密码"
          disabled={submitting}
        />
        <AuthField
          id="change-new-password"
          label={NEW_INPUT}
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          placeholder="8–64 个字符"
          disabled={submitting}
        />
        <AuthField
          id="change-confirm-password"
          label={CONFIRM_INPUT}
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          placeholder="再次输入新密码"
          disabled={submitting}
        />
        {error !== null ? (
          <p role="alert" className="rounded-md border border-red-300/25 bg-red-400/10 px-3 py-2 text-sm text-red-100">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="h-11 w-full rounded-md border border-[#dfff82] bg-[#dfff82] px-4 text-sm font-semibold text-[#10140d] transition hover:bg-[#edffb2] disabled:cursor-default disabled:opacity-55"
        >
          {submitting ? '正在修改…' : SUBMIT_LABEL}
        </button>
      </form>
    </AuthPageFrame>
  );
}
