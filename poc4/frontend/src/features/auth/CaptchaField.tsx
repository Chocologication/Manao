import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getCaptcha } from '../../api/authApi';
import type { CaptchaResponse } from '../../contracts/auth';

export type CaptchaFieldProps = {
  /** The answer lives in the owning form's memory only; the field never stores it. */
  answer: string;
  onAnswerChange: (answer: string) => void;
  onChallengeChange?: (challengeId: string | null) => void;
  disabled?: boolean;
  label?: string;
  inputId?: string;
};

/**
 * Image captcha control. It owns the challenge id and image, reports the id to
 * the form, and clears the externally held answer on every refresh. The server
 * response and the DOM never contain the answer.
 */
export function CaptchaField({
  answer,
  onAnswerChange,
  onChallengeChange,
  disabled = false,
  label = '图形验证码',
  inputId,
}: CaptchaFieldProps) {
  const generatedId = useId();
  const resolvedInputId = inputId ?? `captcha-answer-${generatedId}`;
  const [captcha, setCaptcha] = useState<CaptchaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const answerChangeRef = useRef(onAnswerChange);
  const challengeChangeRef = useRef(onChallengeChange);

  useEffect(() => {
    answerChangeRef.current = onAnswerChange;
    challengeChangeRef.current = onChallengeChange;
  }, [onAnswerChange, onChallengeChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setLoading(true);
    setError(null);
    setCaptcha(null);
    answerChangeRef.current('');
    challengeChangeRef.current?.(null);
    try {
      const next = await getCaptcha();
      if (!mountedRef.current || generationRef.current !== generation) return;
      setCaptcha(next);
      challengeChangeRef.current?.(next.challengeId);
    } catch {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setError('验证码加载失败，请点击刷新重试。');
    } finally {
      if (mountedRef.current && generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="entry__field">
      <label htmlFor={resolvedInputId} >
        {label}
      </label>
      <div className="entry__captcha-row">
        <input
          id={resolvedInputId}
          name="captchaAnswer"
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={answer}
          disabled={disabled || captcha === null}
          onChange={(event) => answerChangeRef.current(event.currentTarget.value)}
          className="entry__input entry__input--plain"
          placeholder="输入图中字符"
        />
        <div className="entry__captcha-image">
          {captcha !== null ? (
            <img
              src={`data:image/png;base64,${captcha.imageBase64}`}
              alt={label}
              className="h-full w-full object-contain"
            />
          ) : loading ? (
            <LoaderCircle className="size-5 animate-spin text-black/60" aria-hidden="true" />
          ) : (
            <span className="text-xs text-black/50">未加载</span>
          )}
        </div>
        <button
          type="button"
          aria-label="刷新图形验证码"
          title="刷新图形验证码"
          disabled={disabled || loading}
          onClick={() => void refresh()}
          className="entry__captcha-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="entry__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
