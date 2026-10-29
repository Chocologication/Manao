import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from '@/api/httpClient';
import { useAgentLiveOutput, type LiveScope } from './useAgentLiveOutput';
import { handleUnauthorized, logout } from '@/app/appRuntime';
const scope: LiveScope = { userId: 'alice', projectId: 'p', conversationId: 'c', taskId: 't' };
const snap = (revision = 1, taskId = 't', conversationId = 'c') => ({ revision, taskId, conversationId, durableHeadSeq: 5, current: { messageOrdinal: 0, phase: 'generating', blocks: [{ contentIndex: 0, kind: 'text', text: 'visible ' + revision }], modelTruncated: false, displayTruncated: false }, unavailable: false });
function fixture() {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []; const signals: AbortSignal[] = []; const canceled = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => { signals.push(options!.signal!); return new Response(new ReadableStream({ start(c) { controllers.push(c); }, cancel: canceled }), { headers: { 'Content-Type': 'text/event-stream' } }); });
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl }));
  return { fetchImpl, signals, canceled, controllers, publish: (value: unknown, index = 0) => controllers[index]!.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n')) };
}
afterEach(() => { cleanup(); setHttpClient(null); vi.useRealTimers(); });
it.each([logout, handleUnauthorized])('closes the display stream through the existing session cleanup path', async closeSession => {
  const f = fixture(); const h = renderHook(() => useAgentLiveOutput(scope)); await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => f.publish(snap())); act(() => closeSession()); await waitFor(() => expect(f.signals[0]!.aborted).toBe(true));
  expect(h.result.current.latest).toBeNull(); expect(f.canceled).toHaveBeenCalled();
});
it('publishes latest self-contained revisions, ignoring duplicates, old revisions and wrong scope', async () => {
  const f = fixture(); const h = renderHook(() => useAgentLiveOutput(scope)); await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => { f.publish(snap(9)); }); expect(h.result.current.latest?.revision).toBe(9);
  await act(async () => { f.publish(snap(3)); f.publish(snap(9)); f.publish(snap(10, 'other')); });
  expect(h.result.current.latest?.revision).toBe(9); expect(h.result.current.connectionState).toBe('live');
});
it.each(['userId', 'projectId', 'conversationId', 'taskId'])('aborts and clears display on %s change without mutating a task', async field => {
  const f = fixture(); const h = renderHook(props => useAgentLiveOutput(props), { initialProps: scope }); await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => { f.publish(snap()); }); h.rerender({ ...scope, [field]: 'other' });
  expect(h.result.current.latest).toBeNull(); expect(f.signals[0]!.aborted).toBe(true); await waitFor(() => expect(f.canceled).toHaveBeenCalled());
  expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); h.unmount(); expect(f.signals[1]!.aborted).toBe(true);
});
it('backs off reconnects by 1, 2, then capped 5 seconds without rerunning the task', async () => {
  vi.useFakeTimers(); const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  setHttpClient(new HttpClient({ getAccessToken: () => 't', onUnauthorized: vi.fn(), fetchImpl })); renderHook(() => useAgentLiveOutput(scope));
  await act(async () => {}); expect(fetchImpl).toHaveBeenCalledTimes(1);
  for (const [delay, calls] of [[1000, 2], [2000, 3], [5000, 4], [5000, 5]]) { await act(async () => { await vi.advanceTimersByTimeAsync(delay! - 1); }); expect(fetchImpl).toHaveBeenCalledTimes(calls! - 1); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetchImpl).toHaveBeenCalledTimes(calls!); }
});
it.each([204, 429, 503, 401])('falls back without a busy loop for HTTP %s', async status => {
  vi.useFakeTimers(); const logout = vi.fn(); const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: logout, fetchImpl })); const h = renderHook(() => useAgentLiveOutput(scope));
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(h.result.current.connectionState).toBe(status === 204 ? 'history' : 'unavailable'); expect(logout).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('malformed stream preserves the last preview and falls back; retry and remount only subscribe', async () => {
  const f = fixture(); const h = renderHook(() => useAgentLiveOutput(scope)); await waitFor(() => expect(f.controllers).toHaveLength(1));
  await act(async () => { f.publish(snap()); f.publish({ bad: true }); }); expect(h.result.current.latest?.revision).toBe(1); expect(h.result.current.connectionState).toBe('unavailable');
  act(() => h.result.current.retry()); await waitFor(() => expect(f.controllers).toHaveLength(2)); h.unmount();
  renderHook(() => useAgentLiveOutput(scope)); await waitFor(() => expect(f.controllers).toHaveLength(3)); expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
