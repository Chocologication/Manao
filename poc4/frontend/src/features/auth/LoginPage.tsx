import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowUpRight, Eye, EyeOff, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { login } from '../../api/authApi';
import { EntryLayout } from './EntryLayout';
import styles from './LoginPage.module.css';
import { ApiRequestError } from '../../api/ApiRequestError';
import { consumeLoginNotice, type LoginLifecycleNotice } from '../../app/appRuntime';
import { useAuth } from './AuthProvider';
import { useReducedMotion } from '@/features/preferences/motionPreferences';

gsap.registerPlugin(useGSAP);

const DEFAULT_POST_LOGIN_PATH = '/projects';
function loginNoticeMessage(notice: LoginLifecycleNotice): string {
  switch (notice) {
    case 'registered':
      return '注册成功，请使用新账号登录。';
    case 'passwordReset':
      return '密码已重置，请使用新密码登录。';
    case 'passwordChanged':
      return '密码已更新，请重新登录。';
  }
}
type ViewTransitionDocument = Document & {
  startViewTransition?: (
    update: () => void | Promise<void>,
  ) => { finished: Promise<void> };
};

function resolvePostLoginPath(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  return from;
}

function LoginTransition({ onComplete }: { onComplete: () => void }) {
  const transitionRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      const timeline = gsap.timeline({
        defaults: { ease: 'power3.out' },
        onComplete,
      });

      if (reduceMotion) {
        timeline.set(transitionRef.current, { opacity: 1 });
        timeline.progress(1);
        return;
      }

      timeline
        .fromTo(
          '.entry-transition__mark',
          { opacity: 0, scale: 0.88, y: 8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.38 },
          0,
        )
        .fromTo(
          '.entry-transition__eyebrow, .entry-transition__title',
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.28, stagger: 0.08 },
          0.1,
        )
        .fromTo(
          '.manao-transition-progress',
          { scaleX: 0 },
          { scaleX: 1, duration: 0.42, ease: 'power2.inOut' },
          0.12,
        )
        .fromTo(
          '.manao-transition-status',
          { opacity: 0, y: 6 },
          { opacity: 1, y: 0, duration: 0.24, stagger: 0.06 },
          0.2,
        );
    },
    { scope: transitionRef, dependencies: [reduceMotion], revertOnUpdate: true },
  );

  return (
    <div
      ref={transitionRef}
      className={`entry-transition ${styles.transition}`}
      role="status"
      aria-live="polite"
      aria-label="正在进入码瑙工作台"
    >
      <div className="entry-transition__content">
        <div className="entry-transition__mark">
          码
        </div>
        <p className="entry-transition__eyebrow">正在进入码瑙工作台</p>
        <h2 className="entry-transition__title">进入云端开发实验室</h2>

        <div className="entry-transition__track">
          <div className="manao-transition-progress entry-transition__progress" />
        </div>

        <div className="entry-transition__steps">
          <span className="manao-transition-status">认证完成</span>
          <span className="manao-transition-status">载入项目</span>
          <span className="manao-transition-status">准备跳转</span>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { snapshot, authenticate } = useAuth();
  const reducedMotion = useReducedMotion();
  const location = useLocation();
  const navigate = useNavigate();
  const redirectAfterLoginRef = useRef<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const transitionResolveRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  const [oneShotNotice, setOneShotNotice] = useState<LoginLifecycleNotice | null>(null);
  const oneShotConsumedRef = useRef(false);

  useEffect(() => {
    if (snapshot.status !== 'anonymous' || oneShotConsumedRef.current) {
      return;
    }
    oneShotConsumedRef.current = true;
    setOneShotNotice(consumeLoginNotice());
  }, [snapshot.status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      transitionResolveRef.current?.();
      transitionResolveRef.current = null;
    };
  }, []);

  if (snapshot.status === 'authenticated') {
    return <Navigate to={redirectAfterLoginRef.current ?? DEFAULT_POST_LOGIN_PATH} replace />;
  }

  const submitDisabled = pending || username.length === 0 || password.length === 0;
  const sessionExpired =
    snapshot.reason === 'unauthorized' || snapshot.reason === 'expired';
  const alertMessage =
    error ?? (sessionExpired ? 'Your session has expired. Please sign in again.' : null);
  const lifecycle = location.state as
    | { registered?: boolean; passwordReset?: boolean; passwordChanged?: boolean }
    | null;
  const successMessage =
    oneShotNotice !== null
      ? loginNoticeMessage(oneShotNotice)
      : lifecycle?.registered === true
        ? '注册成功，请使用新账号登录。'
        : lifecycle?.passwordReset === true
          ? '密码已重置，请使用新密码登录。'
          : lifecycle?.passwordChanged === true
            ? '密码已更新，请重新登录。'
            : null;
  const displayAlertMessage =
    error === 'Invalid username or password'
      ? '用户名或密码错误'
      : error === 'Network request failed'
        ? '网络请求失败'
        : error === 'Unable to sign in'
          ? '登录失败'
          : sessionExpired
            ? '登录会话已过期，请重新登录'
            : null;

  function beginTransition(): Promise<void> {
    setTransitioning(true);
    return new Promise((resolve) => {
      transitionResolveRef.current = resolve;
    });
  }

  function completeTransition(): void {
    transitionResolveRef.current?.();
    transitionResolveRef.current = null;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || username.length === 0 || password.length === 0) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await login({ username, password });
      if (!mountedRef.current) return;
      const target = resolvePostLoginPath(
        (location.state as { from?: unknown } | null)?.from,
      );
      redirectAfterLoginRef.current = target;
      if (!reducedMotion) await beginTransition();
      if (!mountedRef.current) return;
      let committed = false;
      const commitLogin = async () => {
        if (committed || !mountedRef.current) return;
        committed = true;
        authenticate(response);
        await navigate(target, { replace: true });
      };
      const viewTransitionDocument = document as ViewTransitionDocument;
      if (!reducedMotion && viewTransitionDocument.startViewTransition) {
        // A skipped browser animation must not turn successful authentication into an error.
        try {
          await viewTransitionDocument.startViewTransition(commitLogin).finished;
        } catch {
          await commitLogin();
        }
      } else {
        await commitLogin();
      }
    } catch (reason) {
      if (!mountedRef.current) return;
      if (reason instanceof ApiRequestError && reason.status === 401) {
        setError('Invalid username or password');
      } else if (reason instanceof Error && /network request failed/i.test(reason.message)) {
        setError('Network request failed');
      } else {
        setError('Unable to sign in');
      }
    } finally {
      if (mountedRef.current) {
        setTransitioning(false);
        setPending(false);
      }
    }
  }

  return (
    <>
      <EntryLayout>
          <section
            aria-labelledby="access-title"
            className="entry__form"
          >
            <div className="entry__form-heading">
              <div>
                <h2 id="access-title">登录开发实验室</h2>
                <p>进入你的云端项目、文件与运行记录。</p>
              </div>
              <span className="entry__security-mark">
                <ShieldCheck size={20} aria-hidden="true" />
              </span>
            </div>

            <div className="entry__form-meta">
              <span>个人工作区</span>
              <span>安全会话</span>
            </div>

            <form method="post" onSubmit={onSubmit} className="entry__fields">
              {successMessage && <p role="status" className="entry__notice">{successMessage}</p>}
              <div className="entry__field">
                <label htmlFor="username">用户名</label>
                <input
                  id="username"
                  name="username"
                  aria-label="Username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="entry__input"
                  aria-invalid={Boolean(displayAlertMessage)}
                  aria-describedby={displayAlertMessage ? 'login-error' : undefined}
                  placeholder="用户名"
                />
                <UserRound className="entry__input-icon" size={17} aria-hidden="true" />
              </div>

              <div className="entry__field">
                <label htmlFor="password">密码</label>
                <input
                  id="password"
                  name="password"
                  aria-label="Password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="entry__input entry__input--password"
                  aria-invalid={Boolean(displayAlertMessage)}
                  aria-describedby={displayAlertMessage ? 'login-error' : undefined}
                  placeholder="请输入密码"
                />
                <button type="button" className="entry__password-toggle" title={showPassword ? '隐藏密码' : '显示密码'} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>

              {alertMessage ? (
                <p
                  id="login-error"
                  role="alert"
                  className="entry__error"
                >
                  {displayAlertMessage}
                  <span className="sr-only">{alertMessage}</span>
                </p>
              ) : null}

              <button
                type="submit"
                disabled={submitDisabled}
                aria-label="Sign in"
                className="entry__submit group"
              >
                {pending ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    正在进入工作台
                  </>
                ) : (
                  <>
                    进入实验工作台
                    <ArrowUpRight
                      className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </>
                )}
              </button>
            </form>

            <p className="entry__account-link">
              还没有账号？<Link to="/register">创建账号 <ArrowUpRight size={14} aria-hidden="true" /></Link>
            </p>

            <p className="entry__account-link"><Link to="/forgot-password">忘记密码</Link></p>

            {import.meta.env.MODE === 'mock' && (
              <div className="entry__demo-hint">
                <span>演示账号：alice / demo-pass</span>
                <span>演示环境</span>
              </div>
            )}
          </section>
      </EntryLayout>
      {transitioning ? <LoginTransition onComplete={completeTransition} /> : null}
    </>
  );
}
