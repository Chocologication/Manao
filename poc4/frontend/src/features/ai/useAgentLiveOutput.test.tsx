import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from '@/api/httpClient';
import { authSession } from '@/app/appRuntime';
import { useAgentLiveOutput, type LiveScope } from './useAgentLiveOutput';

const scope: LiveScope = { userId: 'alice', projectId: 'p', conversationId: 'c', taskId: 't' };
const snap = (revision = 1, taskId = 't', conversationId = 'c') => ({
  revision,
  taskId,
  conversationId,
  durableHeadSeq: 5,
  current: {
    messageOrdinal: 0,
    phase: 'generating',
    blocks: [{ contentIndex: 0, kind: 'text', text: 'visible ' + revision }],
    modelTruncated: false,
    displayTruncated: false,
  },
  unavailable: false,
});

const LIVE_OUTPUT_PATH = '/live-output';
const ME_PATH = '/api/v1/auth/me';

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function fixture() {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const canceled = vi.fn();
  const meResponses: Array<() => Promise<Response> | Response> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
    const url = requestUrl(input);
    signals.push(options!.signal!);
    if (url.includes(LIVE_OUTPUT_PATH)) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controllers.push(controller);
          },
          cancel: canceled,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const next = meResponses.shift();
    if (next === undefined) {
      throw new TypeError('unexpected request ' + url);
    }
    return next();
  });
  setHttpClient(
    new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl }),
  );
  return {
    fetchImpl,
    controllers,
    signals,
    canceled,
    meResponses,
    publish: (value: unknown, index = 0) =>
      controllers[index]!.enqueue(
        new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n'),
      ),
    publishFrame: (frame: string, index = 0) =>
      controllers[index]!.enqueue(new TextEncoder().encode(frame)),
    endStream: (index = 0) => controllers[index]!.close(),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}


afterEach(() => {
  cleanup();
  setHttpClient(null);
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
});

it('closes the display stream through the existing session cleanup path', async () => {
  authSession.authenticate({
    accessToken: 'live-output-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-alice', username: 'alice' },
  });
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => f.publish(snap()));
  act(() => authSession.clear('logout'));
  await waitFor(() => expect(f.signals[0]!.aborted).toBe(true));
  expect(h.result.current.latest).toBeNull();
  expect(f.canceled).toHaveBeenCalled();
});

it('publishes latest self-contained revisions, ignoring duplicates, old revisions and wrong scope', async () => {
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => {
    f.publish(snap(9));
  });
  expect(h.result.current.latest?.revision).toBe(9);
  await act(async () => {
    f.publish(snap(3));
    f.publish(snap(9));
    f.publish(snap(10, 'other'));
  });
  expect(h.result.current.latest?.revision).toBe(9);
  expect(h.result.current.connectionState).toBe('live');
});

it.each(['userId', 'projectId', 'conversationId', 'taskId'])(
  'aborts and clears display on %s change without mutating a task',
  async (field) => {
    const f = fixture();
    const h = renderHook((props) => useAgentLiveOutput(props), { initialProps: scope });
    await waitFor(() => expect(f.controllers).toHaveLength(1));
    await act(async () => {
      f.publish(snap());
    });
    h.rerender({ ...scope, [field]: 'other' });
    expect(h.result.current.latest).toBeNull();
    expect(f.signals[0]!.aborted).toBe(true);
    await waitFor(() => expect(f.canceled).toHaveBeenCalled());
    expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    h.unmount();
    expect(f.signals[1]!.aborted).toBe(true);
  },
);

it('checks /auth/me once per abnormal end and allows only one bounded reconnect', async () => {
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  const meOk = () =>
    jsonResponse({ id: 'usr-alice', username: 'alice', email: null, emailVerified: false }, 200);
  act(() => {
    f.meResponses.push(meOk, meOk);
    f.endStream(0);
  });

  await waitFor(() => expect(h.result.current.connectionState).toBe('reconnecting'));
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  expect(requestUrl(f.fetchImpl.mock.calls[1]![0])).toBe(ME_PATH);

  // Exactly one bounded retry: a second abnormal end verifies once more and
  // then shows "disconnected" with no further timer loop.
  await waitFor(() => expect(f.controllers).toHaveLength(2), { timeout: 3000 });
  act(() => f.endStream(1));
  await waitFor(() => expect(h.result.current.connectionState).toBe('unavailable'));
  expect(f.fetchImpl).toHaveBeenCalledTimes(4);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(f.fetchImpl).toHaveBeenCalledTimes(4);
});

it('clears the current session when the one-shot /auth/me check answers 401', async () => {
  authSession.authenticate({
    accessToken: 'revoked-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-alice', username: 'alice' },
  });
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  act(() => {
    f.meResponses.push(() =>
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'Authentication required', traceId: 'trace-me' },
        401,
      ),
    );
    f.endStream();
  });

  await waitFor(() => expect(authSession.getSnapshot().status).toBe('anonymous'));
  expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
  await waitFor(() => expect(h.result.current.connectionState).toBe('history'));
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});

it('only shows disconnected when the session check itself has a network failure', async () => {
  authSession.authenticate({
    accessToken: 'still-valid-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-alice', username: 'alice' },
  });
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  act(() => {
    f.meResponses.push(() => Promise.reject(new TypeError('network down')));
    f.endStream();
  });

  await waitFor(() => expect(h.result.current.connectionState).toBe('unavailable'));
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  expect(authSession.getSnapshot()).toMatchObject({
    status: 'authenticated',
    accessToken: 'still-valid-token',
  });
});

it('raises the auth.revoked SSE event into the unified session cleanup', async () => {
  authSession.authenticate({
    accessToken: 'sse-revoked-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-alice', username: 'alice' },
  });
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => {
    f.publishFrame('event: auth.revoked\ndata: {}\n\n');
  });

  await waitFor(() => expect(authSession.getSnapshot().status).toBe('anonymous'));
  expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
  await waitFor(() => expect(h.result.current.connectionState).toBe('history'));
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});

it('ignores a late /auth/me answer for an old login instead of clearing the newer session', async () => {
  authSession.authenticate({
    accessToken: 'alice-old-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-alice', username: 'alice' },
  });
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  let resolveMe: (response: Response) => void = () => {};
  const pendingMe = new Promise<Response>((resolve) => {
    resolveMe = resolve;
  });
  act(() => {
    f.meResponses.push(() => pendingMe);
    f.endStream();
  });
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledTimes(2));

  authSession.clear('logout');
  authSession.authenticate({
    accessToken: 'bob-new-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: { id: 'usr-bob', username: 'bob' },
  });
  await act(async () => {
    resolveMe(
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'Authentication required', traceId: 'trace-me' },
        401,
      ),
    );
  });

  await waitFor(() => expect(h.result.current.latest).toBeNull());
  expect(h.result.current.connectionState).toBe('history');
  expect(authSession.getSnapshot()).toMatchObject({
    status: 'authenticated',
    accessToken: 'bob-new-token',
    user: { username: 'bob' },
  });
});

it.each([204, 429, 503, 401])('falls back without a busy loop for HTTP %s', async (status) => {
  const meResponses: Array<() => Response> = [];
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const next = meResponses.shift();
    if (next !== undefined) return next();
    return new Response(null, { status });
  });
  const logout = vi.fn();
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: logout, fetchImpl }));
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() =>
    expect(h.result.current.connectionState).toBe(status === 204 ? 'history' : 'unavailable'),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(logout).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});

it('malformed stream preserves the last preview and falls back; retry and remount only subscribe', async () => {
  const f = fixture();
  const h = renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => {
    f.publish(snap());
    f.publish({ bad: true });
  });
  expect(h.result.current.latest?.revision).toBe(1);
  expect(h.result.current.connectionState).toBe('unavailable');
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  act(() => h.result.current.retry());
  await waitFor(() => expect(f.controllers).toHaveLength(2));
  h.unmount();
  renderHook(() => useAgentLiveOutput(scope));
  await waitFor(() => expect(f.controllers).toHaveLength(3));
  expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
