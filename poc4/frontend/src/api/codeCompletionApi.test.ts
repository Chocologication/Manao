import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from './httpClient';
import { requestTabCompletion } from './codeCompletionApi';

afterEach(() => setHttpClient(null));

it('sends only current context to an encoded same-origin route with JWT and cancellation', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"completion":"a + b"}'));
  setHttpClient(new HttpClient({ getAccessToken: () => 'fixture-token', onUnauthorized: vi.fn(), fetchImpl }));
  const signal = new AbortController().signal;
  await expect(requestTabCompletion('project/one', { prefix: '  return ', suffix: '\n' }, signal))
    .resolves.toEqual({ completion: 'a + b' });
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('/api/v1/projects/project%2Fone/code-completions');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
  expect(JSON.parse(String(init?.body))).toEqual({ prefix: '  return ', suffix: '\n' });
  expect(init?.signal).toBe(signal);
});

it('keeps the existing HttpClient unauthorized side effect', async () => {
  const unauthorized = vi.fn();
  setHttpClient(new HttpClient({ getAccessToken: () => 'expired', onUnauthorized: unauthorized,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":"UNAUTHENTICATED"}', { status: 401 })) }));
  await expect(requestTabCompletion('project', { prefix: '', suffix: '' }, new AbortController().signal)).rejects.toThrow();
  expect(unauthorized).toHaveBeenCalledOnce();
});
