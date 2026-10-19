import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/AppProviders';
import { queryClient } from '@/app/appRuntime';
import { resetAppRuntime } from '@/test/renderApp';
import { server } from '@/mocks/node';
import { ConversationHistory } from './ConversationHistory';
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
    const older = url.searchParams.has('beforeSeq');
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
  server.use(http.get(URL, ({ request }) => HttpResponse.json(new globalThis.URL(request.url).searchParams.has('beforeSeq') ? { items: [item('head')], nextBeforeSeq: null, nextBeforeOffset: null } : { items: [item('tail', { textOffset: 10 })], nextBeforeSeq: 5, nextBeforeOffset: 10 })));
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
  server.use(http.get(URL, ({ request }) => HttpResponse.json(new globalThis.URL(request.url).searchParams.has('beforeSeq')
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
