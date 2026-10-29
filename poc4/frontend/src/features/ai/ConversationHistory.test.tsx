import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/AppProviders';
import { queryClient } from '@/app/appRuntime';
import { resetAppRuntime } from '@/test/renderApp';
import { server } from '@/mocks/node';
import { ConversationHistory } from './ConversationHistory';
import type { LiveSnapshot } from './agentLiveOutput';
import { HttpClient, setHttpClient } from '@/api/httpClient';
it.each(['malformed', 'disconnect'])('promotes a newer ACK over an old prefix when %s races its pending history', async failure => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, release!: () => void, subscriptions = 0;
  const encode = (value: unknown) => new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n');
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl: async (input, init) => {
    expect(init?.method).toBe('GET'); const path = String(input);
    if (path.endsWith('/live-output')) { subscriptions++; return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
    if (path.includes('beforeSeq=9')) await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify({ items: path.includes('beforeSeq=9') ? [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('old preview now fully saved', { seq: 6, contentIndex: 1 })] : [], nextBeforeSeq: null, nextBeforeOffset: null }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  render(<AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} taskId={T} headSeq={8} terminal={false} /></AppProviders>);
  await waitFor(() => expect(controller).toBeDefined()); await act(async () => controller.enqueue(encode(live(5, 1, 'old preview')))); await screen.findByText('old preview');
  const next = { ...live(8, 2, 'new unsaved preview'), revision: 50 }; await act(async () => controller.enqueue(encode(next))); await waitFor(() => expect(release).toBeDefined());
  expect(screen.queryByText('new unsaved preview')).toBeNull(); expect(screen.getAllByText('old preview')).toHaveLength(1);
  await act(async () => { if (failure === 'malformed') controller.enqueue(encode({ bad: true })); else controller.close(); });
  await act(async () => release()); expect(await screen.findByText('new unsaved preview')).toBeVisible(); expect(screen.getAllByText('old preview now fully saved')).toHaveLength(1); expect(screen.getByLabelText('实时预览')).toHaveTextContent('new unsaved preview');
  if (failure === 'malformed') await userEvent.click(screen.getByRole('button', { name: '重连实时展示' }));
  await waitFor(() => expect(subscriptions).toBe(2), { timeout: 2000 }); await act(async () => controller.enqueue(encode(next)));
  expect(screen.getByText('new unsaved preview')).toBeVisible(); expect(screen.getAllByText('old preview now fully saved')).toHaveLength(1);
});
it('promotes a late normal ACK after terminal polling found a fuller saved answer', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encode = (value: LiveSnapshot) => new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n');
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl: async input => {
    const path = String(input);
    if (path.endsWith('/live-output')) return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(JSON.stringify({ items: path.includes('beforeSeq=7') ? [item('reason', { seq: 6, kind: 'thinking' }), item('hello world', { seq: 6, contentIndex: 1 })] : [], nextBeforeSeq: null, nextBeforeOffset: null }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  const view = (terminal: boolean) => <AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} taskId={T} headSeq={terminal ? 6 : 5} terminal={terminal} /></AppProviders>;
  const h = render(view(false)); await waitFor(() => expect(controller).toBeDefined());
  const first = { ...live(5, 1, 'hello'), revision: 1 };
  await act(async () => controller.enqueue(encode(first))); await screen.findByText('hello');
  await userEvent.click(screen.getByText('思考中'));
  h.rerender(view(true)); expect(await screen.findByText('实时预览未确认保存')).toBeVisible();
  expect(screen.getByText('hello')).toBeVisible(); expect(screen.queryByText('hello world')).toBeNull();
  await act(async () => controller.enqueue(encode({ ...first, revision: 2, durableHeadSeq: 6, current: null })));
  expect(await screen.findByText('hello world')).toBeVisible(); expect(screen.getAllByText('hello world')).toHaveLength(1);
  expect(screen.queryByLabelText('实时预览')).toBeNull(); expect(screen.queryByText('实时预览未确认保存')).toBeNull();
  expect(screen.getByText('reason')).not.toBeVisible();
});
it('keeps advancing fallback history with current:null and does not regress on retry', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, subscriptions = 0; const bounds: number[] = [];
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl: async input => {
    const path = String(input); if (path.endsWith('/live-output')) { subscriptions++; return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
    const bound = Number(new globalThis.URL(path, 'http://fixture').searchParams.get('beforeSeq')); bounds.push(bound); return new Response(JSON.stringify({ items: [item('saved ' + bound, { seq: bound - 1 })], nextBeforeSeq: null, nextBeforeOffset: null }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  const view = (headSeq: number) => <AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} taskId={T} headSeq={headSeq} terminal={false} /></AppProviders>;
  const h = render(view(5)); await waitFor(() => expect(controller).toBeDefined()); await act(async () => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify({ ...live(), current: null }) + '\n\n')));
  await act(async () => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: broken\n\n'))); h.rerender(view(8)); await screen.findByText('saved 9'); h.rerender(view(10)); await screen.findByText('saved 11');
  await userEvent.click(screen.getByRole('button', { name: '重连实时展示' })); await waitFor(() => expect(subscriptions).toBe(2)); await act(async () => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify({ ...live(), current: null }) + '\n\n')));
  expect(screen.getByText('saved 11')).toBeVisible(); expect(bounds.slice(1)).not.toContain(6); expect(screen.queryByLabelText('实时预览')).toBeNull();
});
function live(head = 5, ordinal = 1, text = 'preview'): LiveSnapshot { return { revision: head + ordinal, taskId: 'task-original', conversationId: 'c-history', durableHeadSeq: head, current: { messageOrdinal: ordinal, phase: 'generating', blocks: [{ contentIndex: 0, kind: 'thinking', text: 'reason' }, { contentIndex: 1, kind: 'text', text }], modelTruncated: false, displayTruncated: false }, unavailable: false }; }
function historyView(snapshot: LiveSnapshot, headSeq = 5, terminal = false) { return <AppProviders><ConversationHistory userId="alice" projectId="p-history" conversationId="c-history" headSeq={headSeq} liveSnapshot={snapshot} terminal={terminal} /></AppProviders>; }
it.each([204, 429, 503, 'malformed'] as const)('advances RUNNING-task history after transport fallback %s without duplicate previews', async status => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, subscriptions = 0, release!: () => void;
  const requests: string[] = []; const encode = (value: unknown) => new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n');
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl: async (input, init) => {
    expect(init?.method).toBe('GET'); const path = String(input); requests.push(path);
    if (path.endsWith('/live-output')) {
      if (++subscriptions === 2 && status !== 'malformed') return new Response(null, { status });
      return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const bound = new globalThis.URL(path, 'http://fixture').searchParams.get('beforeSeq');
    if (bound === '9') await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify({ items: bound === '6' ? [] : [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('preview', { seq: 6, contentIndex: 1 }), item('later durable', { seq: 8 })], nextBeforeSeq: null, nextBeforeOffset: null }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  const view = (headSeq: number) => <AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} taskId={T} headSeq={headSeq} terminal={false} /></AppProviders>;
  const h = render(view(5)); await waitFor(() => expect(controller).toBeDefined()); await act(async () => controller.enqueue(encode(live()))); await screen.findByText('preview');
  await act(async () => { if (status === 'malformed') controller.enqueue(encode({ broken: true })); else controller.close(); });
  await waitFor(() => expect(status === 'malformed' ? screen.queryByText(/实时展示暂不可用/) !== null : subscriptions === 2).toBe(true), { timeout: 2000 });
  h.rerender(view(8)); await waitFor(() => expect(release).toBeDefined()); expect(screen.getAllByText('preview')).toHaveLength(1); expect(screen.getByLabelText('实时预览')).toBeVisible();
  await act(async () => release()); expect(await screen.findByText('later durable')).toBeVisible(); expect(screen.queryByLabelText('实时预览')).toBeNull(); expect(screen.getAllByText('preview')).toHaveLength(1);
  if (status !== 204) {
    await userEvent.click(screen.getByRole('button', { name: '重连实时展示' })); await waitFor(() => expect(subscriptions).toBe(status === 'malformed' ? 2 : 3));
    await act(async () => controller.enqueue(encode(live()))); expect(screen.queryByLabelText('实时预览')).toBeNull();
    await act(async () => controller.enqueue(encode({ ...live(8, 2, 'resumed preview'), revision: 99 }))); expect(await screen.findByText('resumed preview')).toBeVisible(); expect(screen.getAllByText('preview')).toHaveLength(1);
  }
  expect(requests.some(path => path.includes('beforeSeq=9'))).toBe(true);
});
it('keeps an unconfirmed live preview alone when active fallback history has a mismatched first group', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let finalBound = false;
  setHttpClient(new HttpClient({ getAccessToken: () => 'token', onUnauthorized: vi.fn(), fetchImpl: async input => {
    const path = String(input); if (path.endsWith('/live-output')) return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    finalBound ||= path.includes('beforeSeq=9'); return new Response(JSON.stringify({ items: path.includes('beforeSeq=9') ? [item('mismatched', { seq: 6 }), item('preview', { seq: 8 })] : [], nextBeforeSeq: null, nextBeforeOffset: null }), { headers: { 'Content-Type': 'application/json' } });
  } }));
  const view = (headSeq: number) => <AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} taskId={T} headSeq={headSeq} terminal={false} /></AppProviders>;
  const h = render(view(5)); await waitFor(() => expect(controller).toBeDefined()); await act(async () => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(live()) + '\n\n'))); await screen.findByText('preview');
  await act(async () => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: broken\n\n'))); h.rerender(view(8));
  expect(await screen.findByText('实时预览未确认保存')).toBeVisible(); expect(finalBound).toBe(true); expect(screen.getByLabelText('实时预览')).toBeVisible(); expect(screen.getAllByText('preview')).toHaveLength(1); expect(screen.queryByText('mismatched')).toBeNull();
});
it('loads final durable history when the last received ACK has no current draft', async () => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => HttpResponse.json({ items: new globalThis.URL(request.url).searchParams.get('beforeSeq') === '6' ? [] : [item('last durable answer', { seq: 8 })], nextBeforeSeq: null, nextBeforeOffset: null })));
  const acknowledged = { ...live(), current: null }; const h = render(historyView(acknowledged)); await act(async () => {}); h.rerender(historyView(acknowledged, 8, true)); expect(await screen.findByText('last durable answer')).toBeVisible();
});
it('follows new output only while already near the bottom', async () => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', () => HttpResponse.json({ items: [], nextBeforeSeq: null, nextBeforeOffset: null })));
  const view = (value: LiveSnapshot) => <div data-testid="scroll" style={{ overflowY: 'auto' }}>{historyView(value)}</div>;
  const h = render(view(live())); await screen.findByText('preview'); const scroller = screen.getByTestId('scroll');
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } }); scroller.scrollTop = 790; fireEvent.scroll(scroller);
  h.rerender(view({ ...live(5, 1, 'longer preview'), revision: 10 })); await screen.findByText('longer preview'); expect(scroller.scrollTop).toBe(1000);
  scroller.scrollTop = 100; fireEvent.scroll(scroller); h.rerender(view({ ...live(5, 1, 'latest preview'), revision: 11 })); await screen.findByText('latest preview'); expect(scroller.scrollTop).toBe(100);
});

it('reconciles when the final detail head arrives after the terminal task poll', async () => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => HttpResponse.json({ items: new globalThis.URL(request.url).searchParams.get('beforeSeq') === '6' ? [] : [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('preview', { seq: 6, contentIndex: 1 })], nextBeforeSeq: null, nextBeforeOffset: null })));
  const first = live(); const h = render(historyView(first)); await screen.findByText('preview'); h.rerender(historyView(first, 5, true)); await act(async () => {});
  h.rerender(historyView(first, 6, true)); await waitFor(() => expect(screen.queryByLabelText('实时预览')).toBeNull()); expect(screen.getAllByText('preview')).toHaveLength(1);
});
it.each([true, false])('uses prefix correspondence only for display truncation, displayTruncated=%s', async displayTruncated => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => HttpResponse.json({ items: new globalThis.URL(request.url).searchParams.get('beforeSeq') === '6' ? [] : [item('reason complete', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('preview complete', { seq: 6, contentIndex: 1 })], nextBeforeSeq: null, nextBeforeOffset: null })));
  const first = live(); first.current!.displayTruncated = displayTruncated; first.current!.modelTruncated = true;
  const h = render(historyView(first)); await screen.findByText('preview'); expect(screen.getByText('模型响应达到输出上限，本条内容可能不完整')).toBeVisible();
  expect(Boolean(screen.queryByText('实时预览已裁切，完整内容请在保存后查看历史'))).toBe(displayTruncated);
  h.rerender(historyView(first, 6, true));
  if (displayTruncated) { expect(await screen.findByText('preview complete')).toBeVisible(); expect(screen.queryByLabelText('实时预览')).toBeNull(); }
  else expect(await screen.findByText('实时预览未确认保存')).toBeVisible();
});
it('preserves a preview when terminal history pagination fails', async () => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => {
    const b = new globalThis.URL(request.url).searchParams.get('beforeSeq');
    return b === '6' ? HttpResponse.json({ items: [], nextBeforeSeq: null, nextBeforeOffset: null }) : b === '11' ? HttpResponse.json({ items: [item('later', { seq: 10 })], nextBeforeSeq: 7, nextBeforeOffset: 0 }) : new HttpResponse(null, { status: 503 });
  }));
  const first = live(); const h = render(historyView(first)); await screen.findByText('preview'); h.rerender(historyView(first, 10, true)); expect(await screen.findByText('无法加载会话历史')).toBeVisible(); expect(screen.getByText('同步中')).toBeVisible(); expect(screen.getByLabelText('实时预览')).toBeVisible();
});

it('holds a coherent cut until newest bounded history arrives and ignores an older pending promise', async () => {
  const releases = new Map<number, () => void>(), seen: number[] = [];
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', async ({ request }) => {
    const bound = Number(new globalThis.URL(request.url).searchParams.get('beforeSeq')); seen.push(bound);
    if (bound === 9 || bound === 11) await new Promise<void>(r => releases.set(bound, r));
    return HttpResponse.json({ items: [item('history ' + bound, { seq: bound - 1 })], nextBeforeSeq: null, nextBeforeOffset: null });
  }));
  const h = render(historyView(live())); await screen.findByText('preview'); expect(screen.getByText('history 6')).toBeVisible();
  h.rerender(historyView(live(8, 2, 'new preview'), 99)); await waitFor(() => expect(releases.has(9)).toBe(true)); expect(screen.getByText('preview')).toBeVisible(); expect(screen.queryByText('new preview')).toBeNull();
  h.rerender(historyView(live(10, 3, '# newest'), 99)); await waitFor(() => expect(releases.has(11)).toBe(true)); await act(async () => releases.get(11)!());
  expect(await screen.findByRole('heading', { name: 'newest' })).toBeVisible(); expect(screen.getByText('history 11')).toBeVisible(); expect(screen.queryByText('preview')).toBeNull();
  await act(async () => releases.get(9)!()); expect(screen.queryByText('history 9')).toBeNull(); expect(seen).not.toContain(100);
});
it('preserves user thinking choice through delta, ended and the acknowledged history promotion', async () => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => HttpResponse.json({ items: Number(new globalThis.URL(request.url).searchParams.get('beforeSeq')) === 6 ? [] : [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('preview', { seq: 6, contentIndex: 1 })], nextBeforeSeq: null, nextBeforeOffset: null })));
  const first = live(); const h = render(historyView(first)); const thought = await screen.findByText('reason'); expect(thought).toBeVisible(); await userEvent.click(screen.getByText('思考中')); expect(thought).not.toBeVisible();
  h.rerender(historyView({ ...first, revision: 9, current: { ...first.current!, phase: 'ended' } })); expect(screen.getByText('reason')).not.toBeVisible();
  h.rerender(historyView({ ...first, revision: 10, durableHeadSeq: 6, current: null }, 6)); await waitFor(() => expect(screen.getAllByText('preview')).toHaveLength(1)); await waitFor(() => expect(screen.queryByLabelText('实时预览')).toBeNull()); expect(screen.getByText('reason')).not.toBeVisible();
});
it('paginates terminal history to the original cut before replacing a lost-ACK draft', async () => {
  let release!: () => void; const cursors: string[] = [];
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', async ({ request }) => {
    const url = new globalThis.URL(request.url); cursors.push(url.search); const b = url.searchParams.get('beforeSeq');
    if (b === '6') return HttpResponse.json({ items: [], nextBeforeSeq: null, nextBeforeOffset: null });
    if (b === '11') return HttpResponse.json({ items: [item('later', { seq: 10 })], nextBeforeSeq: 7, nextBeforeOffset: 0 });
    await new Promise<void>(r => { release = r; }); return HttpResponse.json({ items: [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item('preview', { seq: 6, contentIndex: 1 })], nextBeforeSeq: null, nextBeforeOffset: null });
  }));
  const first = live(); const h = render(historyView(first)); await screen.findByText('preview'); h.rerender(historyView(first, 10, true)); await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByLabelText('实时预览')).toBeVisible(); expect(screen.getByText('同步中')).toBeVisible(); await act(async () => release());
  await waitFor(() => expect(screen.queryByLabelText('实时预览')).toBeNull()); expect(screen.getAllByText('preview')).toHaveLength(1); expect(cursors.some(v => v.includes('beforeSeq=7') && v.includes('beforeOffset=0'))).toBe(true);
});
it.each(['wrong task', 'wrong index', 'wrong kind', 'wrong text', 'later match'])('retains an unconfirmed preview when the first complete native group has %s', async problem => {
  server.use(http.get('/api/v1/projects/p-history/conversations/c-history/entries', ({ request }) => {
    const bounded = new globalThis.URL(request.url).searchParams.get('beforeSeq') === '6';
    const candidate = [item('reason', { seq: 6, kind: 'thinking', contentIndex: 0 }), item(problem === 'wrong text' || problem === 'later match' ? 'different' : 'preview', { seq: 6, contentIndex: problem === 'wrong index' ? 2 : 1, kind: problem === 'wrong kind' ? 'thinking' : 'assistant' })].map(v => problem === 'wrong task' ? { ...v, taskId: 'another' } : v);
    if (problem === 'later match') candidate.push(item('reason', { seq: 7, kind: 'thinking', contentIndex: 0 }), item('preview', { seq: 7, contentIndex: 1 }));
    return HttpResponse.json({ items: bounded ? [] : candidate, nextBeforeSeq: null, nextBeforeOffset: null });
  }));
  const first = live(); const h = render(historyView(first)); await screen.findByText('preview'); h.rerender(historyView(first, 10, true)); expect(await screen.findByText('实时预览未确认保存')).toBeVisible(); expect(screen.getByLabelText('实时预览')).toBeVisible();
});
const P = 'p-history', C = 'c-history', T = 'task-original';
const URL = `/api/v1/projects/${P}/conversations/${C}/entries`;
function item(text: string, extra = {}) { return { seq: 5, taskId: T, kind: 'assistant', text, toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false, ...extra }; }
function mount(extra = {}) { return render(<AppProviders><ConversationHistory userId="alice" projectId={P} conversationId={C} headSeq={5} {...extra} /></AppProviders>); }
beforeEach(() => resetAppRuntime());
afterEach(async () => { cleanup(); await queryClient.cancelQueries(); resetAppRuntime(); });
it('reassembles UTF16 fragments, same-seq tools and literal code through the offset cursor', async () => {
  const cursors: string[] = [];
  server.use(http.get(URL, ({ request }) => {
    const url = new globalThis.URL(request.url); cursors.push(url.search);
    const older = url.searchParams.has('beforeOffset');
    return HttpResponse.json(older ? { items: [item('中文😀<script>'), item('build', { kind: 'tool_call', toolCallId: 'one' }), item('application', { kind: 'tool_call', toolCallId: 'two' })], nextBeforeSeq: null, nextBeforeOffset: null }
      : { items: [item('alert(1)</script>\n```java\ncode\n```', { textOffset: 12 })], nextBeforeSeq: 5, nextBeforeOffset: 12 });
  }));
  mount(); expect(await screen.findByText(/alert\(1\)/)).toBeInTheDocument(); expect(screen.getByText('还有更早内容')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '加载更早历史' }));
  expect((await screen.findByText(/中文😀/)).textContent).toBe('中文😀<script>alert(1)</script>');
  expect(screen.getByText('code').tagName).toBe('CODE');
  expect(screen.getByText('build')).toBeInTheDocument(); expect(screen.getByText('application')).toBeInTheDocument(); expect(cursors[1]).toContain('beforeSeq=5'); expect(cursors[1]).toContain('beforeOffset=12'); expect(document.querySelector('script')).toBeNull();
});
it('rejects conflicting or gapped fragments instead of fabricating full history', async () => {
  server.use(http.get(URL, ({ request }) => HttpResponse.json(new globalThis.URL(request.url).searchParams.has('beforeOffset') ? { items: [item('head')], nextBeforeSeq: null, nextBeforeOffset: null } : { items: [item('tail', { textOffset: 10 })], nextBeforeSeq: 5, nextBeforeOffset: 10 })));
  mount(); await userEvent.click(await screen.findByRole('button', { name: '加载更早历史' })); expect(await screen.findByText('历史片段不完整，请重新加载')).toBeInTheDocument(); expect(screen.queryByText('headtail')).not.toBeInTheDocument();
});
it('reads historical safe tool details using the original task and reuses View run', async () => {
  const viewRun = vi.fn();
  server.use(http.get(URL, () => HttpResponse.json({ items: [item('app_http_get', { kind: 'tool_result', toolCallId: 'http-original' })], nextBeforeSeq: null, nextBeforeOffset: null })), http.get(`/api/v1/projects/${P}/agent-tasks/${T}/tools/http-original`, () => HttpResponse.json({ toolCallId: 'http-original', toolName: 'app_http_get', data: { kind: 'app_http_get', runId: '44444444-4444-4444-8444-444444444444', path: '/api/books', statusCode: 200, contentType: 'text/plain', body: '<h1>safe</h1>', truncated: false, error: null } })));
  mount({ onViewRun: viewRun }); await userEvent.click(await screen.findByRole('button', { name: '查看工具结果' })); expect(await screen.findByText('<h1>safe</h1>')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'View run' })); expect(viewRun).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444'); expect(document.querySelector('h1')).toBeNull();
});
it.each([
  ['read_file', { path: 'src/历史.java', content: '历史文件内容 <script>literal</script>', sha256: 'b'.repeat(64) }, '历史文件内容 <script>literal</script>'],
  ['list_files', { directory: 'src', entries: [{ path: 'src/历史.java', name: '历史.java', kind: 'file', hidden: false, sizeBytes: 64, hasChildren: null }], hasMore: false }, 'src/历史.java'],
])('opens the original task %s detail from conversation history', async (toolName, data, visible) => {
  const requestedPaths: string[] = [];
  server.use(
    http.get(URL, () => HttpResponse.json({ items: [item(toolName, { kind: 'tool_result', toolCallId: 'call_original_file' })], nextBeforeSeq: null, nextBeforeOffset: null })),
    http.get(`/api/v1/projects/${P}/agent-tasks/:taskId/tools/:callId`, ({ request }) => {
      requestedPaths.push(new globalThis.URL(request.url).pathname);
      return HttpResponse.json({ toolCallId: 'call_original_file', toolName, data });
    }),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '查看工具结果' }));
  expect(await screen.findByText(visible)).toBeInTheDocument();
  expect(requestedPaths).toEqual([`/api/v1/projects/${P}/agent-tasks/${T}/tools/call_original_file`]);
  expect(screen.queryByText('Result unavailable')).not.toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
});
it('does not display internal projection kinds or raw payload fields', async () => {
  server.use(http.get(URL, () => HttpResponse.json({ items: [item('visible'), item('SECRET SYSTEM', { kind: 'system', raw: 'PRIVATE' })], nextBeforeSeq: null, nextBeforeOffset: null })));
  mount(); expect(await screen.findByText('无法加载会话历史')).toBeInTheDocument(); expect(screen.queryByText('SECRET THINKING')).not.toBeInTheDocument(); expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
});

it('orders thinking, answers and tools by native index and keeps two same-kind blocks distinct', async () => {
  server.use(http.get(URL, () => HttpResponse.json({ items: [
    item('final answer', { contentIndex: 4, modelTruncated: true }),
    item('first thought', { kind: 'thinking', contentIndex: 0 }),
    item('middle answer', { contentIndex: 1 }),
    item('second thought', { kind: 'thinking', contentIndex: 2 }),
    item('read_file', { kind: 'tool_call', contentIndex: 3, toolCallId: 'read' }),
  ], nextBeforeSeq: null, nextBeforeOffset: null })));
  const h = mount();
  await screen.findByText('final answer');
  const articles = [...h.container.querySelectorAll('article')];
  expect(articles.map(row => row.textContent)).toEqual([expect.stringContaining('first thought'), expect.stringContaining('middle answer'), expect.stringContaining('second thought'), expect.stringContaining('read_file'), expect.stringContaining('final answer')]);
  expect(screen.getAllByText('模型响应达到输出上限，本条内容可能不完整')).toHaveLength(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('joins a large fenced block across pages before rendering and preserves an earlier thinking block', async () => {
  const prefix = '# 完成\n\n- 已验证\n\n~~~java\n' + '😀'.repeat(17000);
  server.use(http.get(URL, ({ request }) => HttpResponse.json(new globalThis.URL(request.url).searchParams.has('beforeOffset')
    ? { items: [item('reason', { kind: 'thinking', contentIndex: 0 }), item(prefix, { contentIndex: 1 })], nextBeforeSeq: null, nextBeforeOffset: null }
    : { items: [item('class A {}\n~~~', { contentIndex: 1, textOffset: prefix.length, modelTruncated: true })], nextBeforeSeq: 5, nextBeforeOffset: prefix.length })));
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '加载更早历史' }));
  expect(await screen.findByRole('heading', { name: '完成' })).toBeVisible();
  expect(screen.getByRole('list')).toBeVisible();
  expect(screen.getByText(/class A/).tagName).toBe('CODE');
  expect(screen.getByText(/class A/).textContent).toBe('😀'.repeat(17000) + 'class A {}\n');
  expect(screen.getByText('reason')).toBeInTheDocument();
  expect(screen.queryByText('还有更早内容')).not.toBeInTheDocument();
  expect(screen.getByText('模型响应达到输出上限，本条内容可能不完整')).toBeVisible();
});
it('ignores late tool details when the conversation scope changes', async () => {
  let release = () => {}, started = false; const held = new Promise<void>(r => { release = r; });
  server.use(http.get(URL, () => HttpResponse.json({ items: [item('build', { kind: 'tool_result', toolCallId: 'b' })], nextBeforeSeq: null, nextBeforeOffset: null })), http.get(`/api/v1/projects/${P}/conversations/other/entries`, () => HttpResponse.json({ items: [item('other conversation')], nextBeforeSeq: null, nextBeforeOffset: null })), http.get(`/api/v1/projects/${P}/agent-tasks/${T}/tools/b`, async () => { started = true; await held; return HttpResponse.json({ toolCallId: 'b', toolName: 'build', data: { output: 'A LATE TOOL' } }); }));
  const h = mount(); await userEvent.click(await screen.findByRole('button', { name: '查看工具结果' })); await waitFor(() => expect(started).toBe(true));
  h.rerender(<AppProviders><ConversationHistory userId="alice" projectId={P} conversationId="other" headSeq={5} /></AppProviders>); expect(await screen.findByText('other conversation')).toBeInTheDocument(); await act(async () => { release(); await held; }); expect(screen.queryByText('A LATE TOOL')).not.toBeInTheDocument();
});

it('deduplicates identical fragments and preserves distinct tools at the same sequence', async () => {
  server.use(http.get(URL, () => HttpResponse.json({ items: [item('answer'), item('answer'), item('build', { kind: 'tool_call', toolCallId: 'one' }), item('build', { kind: 'tool_call', toolCallId: 'two' })], nextBeforeSeq: null, nextBeforeOffset: null })));
  mount(); expect(await screen.findAllByText('answer')).toHaveLength(1); expect(screen.getAllByText('build')).toHaveLength(2);
});

it.each(['bob', 'other-project'])('does not reuse cached history across owner/project scope: %s', async scope => {
  let fetches = 0;
  server.use(http.get('/api/v1/projects/:projectId/conversations/:id/entries', () => HttpResponse.json({ items: [item(++fetches === 1 ? 'private A' : 'new scope')], nextBeforeSeq: null, nextBeforeOffset: null })));
  const h = mount(); await screen.findByText('private A');
  h.rerender(<AppProviders><ConversationHistory userId={scope === 'bob' ? 'bob' : 'alice'} projectId={scope === 'other-project' ? 'other-project' : P} conversationId={C} headSeq={5} /></AppProviders>);
  expect(await screen.findByText('new scope')).toBeInTheDocument(); expect(screen.queryByText('private A')).not.toBeInTheDocument();
});
