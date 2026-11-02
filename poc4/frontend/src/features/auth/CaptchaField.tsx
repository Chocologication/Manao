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
    <div>
      <label htmlFor={resolvedInputId} className="mb-2 block text-xs font-medium uppercase text-white/58">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={resolvedInputId}
          name="captchaAnswer"
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={answer}
          disabled={disabled || captcha === null}
          onChange={(event) => answerChangeRef.current(event.currentTarget.value)}
          className="h-11 w-full min-w-0 rounded-md border border-white/18 bg-white/8 px-3 text-base text-white outline-none transition placeholder:text-white/30 focus:border-white/55 focus:bg-white/12"
          placeholder="输入图中字符"
        />
        <div className="flex h-11 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/18 bg-white/90">
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
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/18 text-white/70 transition hover:text-white disabled:cursor-default disabled:opacity-50"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
