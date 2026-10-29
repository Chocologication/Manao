import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from '../../api/httpClient';
import { CaptchaField } from './CaptchaField';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function captchaResponse(challengeId: string): Response {
  return new Response(
    JSON.stringify({
      challengeId,
      imageBase64: PNG_BASE64,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function installCaptchaFetch(challenges: string[]): ReturnType<typeof vi.fn<typeof fetch>> {
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const challengeId = challenges[Math.min(index, challenges.length - 1)] ?? 'captcha-1';
    index += 1;
    return captchaResponse(challengeId);
  });
  setHttpClient(new HttpClient({ getAccessToken: () => null, onUnauthorized: vi.fn(), fetchImpl }));
  return fetchImpl;
}

function Harness() {
  const [answer, setAnswer] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  return (
    <div>
      <CaptchaField
        answer={answer}
        onAnswerChange={setAnswer}
        onChallengeChange={setChallengeId}
      />
      <output data-testid="answer-value">{answer}</output>
      <output data-testid="challenge-value">{challengeId ?? ''}</output>
    </div>
  );
}

afterEach(() => {
  cleanup();
  setHttpClient(null);
});

describe('CaptchaField', { timeout: 15_000 }, () => {
  it('loads a PNG challenge and reports the challenge id without any answer data', async () => {
    const fetchImpl = installCaptchaFetch(['captcha-alpha', 'captcha-beta']);
    const user = userEvent.setup();
    render(<Harness />);

    const image = await screen.findByRole('img', { name: '图形验证码' });
    expect(image).toHaveAttribute('src', `data:image/png;base64,${PNG_BASE64}`);
    await waitFor(() => expect(screen.getByTestId('challenge-value')).toHaveTextContent('captcha-alpha'));

    const answerInput = screen.getByLabelText('图形验证码');
    await user.type(answerInput, '12345');
    expect(screen.getByTestId('answer-value')).toHaveTextContent('12345');
    expect(document.body.textContent ?? '').not.toContain('captchaAnswer');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(await fetchImpl.mock.results[0]!.value)).not.toContain('12345');
  });

  it('clears the external answer and fetches a fresh challenge when refreshed', async () => {
    installCaptchaFetch(['captcha-alpha', 'captcha-beta']);
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('challenge-value')).toHaveTextContent('captcha-alpha'));

    await user.type(screen.getByLabelText('图形验证码'), '98765');
    await user.click(screen.getByRole('button', { name: '刷新图形验证码' }));

    await waitFor(() => expect(screen.getByTestId('challenge-value')).toHaveTextContent('captcha-beta'));
    expect(screen.getByTestId('answer-value')).toHaveTextContent('');
    expect(screen.getByLabelText('图形验证码')).toHaveValue('');
  });

  it('shows a retryable error and no challenge when the captcha request fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(captchaResponse('captcha-recovered'));
    setHttpClient(new HttpClient({ getAccessToken: () => null, onUnauthorized: vi.fn(), fetchImpl }));
    render(<Harness />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/验证码加载失败/);
    await waitFor(() => expect(screen.getByTestId('challenge-value')).toHaveTextContent(''));

    await userEvent.setup().click(screen.getByRole('button', { name: '刷新图形验证码' }));
    await waitFor(() =>
      expect(screen.getByTestId('challenge-value')).toHaveTextContent('captcha-recovered'),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
