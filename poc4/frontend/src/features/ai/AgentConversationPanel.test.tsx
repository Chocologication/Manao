import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/AppProviders';
import { queryClient } from '@/app/appRuntime';
import { resetAppRuntime } from '@/test/renderApp';
import { server } from '@/mocks/node';
import { ALICE_SEED_PROJECT_ID } from '@/mocks/state';
import { workspaceSessionStore } from '@/features/editor/workspaceSession';
import { fileKeys } from '@/features/files/fileQueries';
import { agentTaskStorageKey } from '@/api/agentTaskApi';
import type { AgentTaskSnapshot } from '@/contracts/agentTask';
import { AgentConversationPanel } from './AgentConversationPanel';
import type { AgentTaskPanelProps } from './AgentTaskPanel';

const P = ALICE_SEED_PROJECT_ID, U = 'user-alice';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
it('shows actual live Markdown while locked, aborts on switching, and leaves explicit close untouched', async () => {
  let emit!: (value: unknown) => void; let aborted = false; const posts: string[] = [];
  server.use(http.get('/api/v1/projects/:projectId/agent-tasks/:taskId/live-output', ({ request }) => {
    request.signal.addEventListener('abort', () => { aborted = true; });
    return new HttpResponse(new ReadableStream({ start(controller) { emit = value => controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify(value) + '\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }), http.post('/api/v1/projects/:projectId/agent-tasks/:taskId/close', ({ request }) => { posts.push(request.url); return HttpResponse.error(); }));
  const h = panel({ task: task({ conversationId: A }) }); await waitFor(() => expect(emit).toBeDefined());
  await act(async () => emit({ revision: 1, taskId: T, conversationId: A, durableHeadSeq: 1, current: { messageOrdinal: 0, phase: 'generating', blocks: [{ contentIndex: 0, kind: 'thinking', text: 'live reason' }, { contentIndex: 1, kind: 'text', text: '# live heading\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~~js\nhello();\n~~~' }], modelTruncated: false, displayTruncated: false }, unavailable: false }));
  expect(await screen.findByRole('heading', { name: 'live heading' })).toBeVisible(); expect(screen.getByRole('table')).toBeVisible(); expect(screen.getByText('hello();').tagName).toBe('CODE'); expect(screen.getByText('live reason')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '会话 B' })); await screen.findByText('B 原文'); await waitFor(() => expect(aborted).toBe(true)); expect(screen.queryByText('live reason')).toBeNull(); expect(h.close).not.toHaveBeenCalled(); expect(posts).toEqual([]);
});
const URL = `/api/v1/projects/${P}/conversations`;
it('pauses project current while browsing another conversation', async () => {
  const pause = vi.fn();
  panel({ task: task({ conversationId: A }), onPause: pause });
  await screen.findByText('A 原文');
  await userEvent.click(screen.getByRole('button', { name: '会话 B' }));
  await screen.findByText('B 原文');
  await userEvent.click(screen.getByRole('button', { name: 'Pause & take over' }));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull();
});
it('shows the selected conversation usage and clears a cached measurement when its refresh fails', async () => {
  server.use(http.get(URL + '/:id', ({ params }) => HttpResponse.json(conversation(String(params.id), {
    usage: { tokens: params.id === A ? 262144 : 786432, contextWindow: 1048576, percent: params.id === A ? 25 : 75 },
  }))));
  panel(); await screen.findByText('A 原文');
  expect(screen.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuenow', '25');
  await userEvent.click(screen.getByRole('button', { name: '会话 B' })); await screen.findByText('B 原文');
  expect(screen.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuenow', '75');
  server.use(http.get(URL + '/' + B, () => HttpResponse.json({ message: 'unavailable' }, { status: 503 })));
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['agent-conversations', U, P, B, 'detail'] }); });
  await waitFor(() => expect(screen.getByRole('progressbar', { name: '上下文占用' })).not.toHaveAttribute('aria-valuenow'));
  expect(screen.getByText('占用暂不可用')).toBeInTheDocument();
});
it('initializes effort per conversation and polling keeps a dirty selection', async () => {
  server.use(http.get(`${URL}/:id`, ({ params }) => HttpResponse.json(conversation(String(params.id), { nextReasoningEffort: params.id === A ? 'low' : 'max' }))));
  panel(); await screen.findByText('A 原文');
  expect(screen.getByRole('button', { name: /推理强度/ })).toHaveTextContent('推理强度 · 低');
  await userEvent.click(screen.getByRole('button', { name: /推理强度/ })); fireEvent.change(screen.getByRole('slider', { name: '推理强度' }), { target: { value: '0' } }); await userEvent.keyboard('{Escape}');
  await act(async () => { await queryClient.invalidateQueries(); });
  expect(screen.getByRole('button', { name: /推理强度/ })).toHaveTextContent('推理强度 · 关闭');
  await userEvent.click(screen.getByRole('button', { name: '会话 B' })); await screen.findByText('B 原文');
  expect(screen.getByRole('button', { name: /推理强度/ })).toHaveTextContent('推理强度 · 最高');
});
function conversation(id = A, extra = {}) { return { conversationId: id, title: id === A ? '会话 A' : '会话 B', headSeq: 1, lastTaskId: null, activeTaskId: null, usage: null, compactRequestId: null, compactState: null, compactFailureCode: null, ...extra }; }
it('keeps the current task end control while the selected historical conversation cannot load', async () => {
  sessionStorage.setItem(`manao.agent-conversation.${U}.${P}`, B);
  server.use(http.get(`${URL}/${B}`, () => HttpResponse.json({ message: 'unavailable' }, { status: 503 })));
  const h = panel({ task: task({ conversationId: A }) });
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: 'End task' }));
  expect(h.close).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
});
function task(extra = {}): AgentTaskSnapshot { return { taskId: T, state: 'RUNNING', workspaceRevision: '7', writesLocked: true, progress: [], changedPaths: [], summary: null, failureCode: null, ...extra }; }
function panel(extra: Partial<AgentTaskPanelProps> & { historyTarget?: HTMLElement | null } = {}) {
  const accepted = vi.fn(), close = vi.fn();
  const props = { projectId: P, userId: U, task: null, settledTask: null, pollFailed: false, writePending: false, hasActiveRun: false, runAuthorityKnown: true, reloading: false, closePending: false, onTaskAccepted: accepted, onClose: close, ...extra };
  return { ...render(<AppProviders><AgentConversationPanel {...props} /></AppProviders>), props, accepted, close };
}
beforeEach(() => {
  resetAppRuntime(); sessionStorage.clear(); workspaceSessionStore.getState().activateProject(P);
  queryClient.setQueryData(fileKeys.revision(P), '7');
  server.use(
    http.get(URL, () => HttpResponse.json({ items: [conversation(), conversation(B)], nextCursor: null })),
    http.get(`${URL}/:id`, ({ params }) => HttpResponse.json(conversation(String(params.id)))),
    http.get(`${URL}/:id/entries`, ({ params }) => HttpResponse.json({ items: [{ seq: 1, taskId: T, kind: 'assistant', text: `${params.id === A ? 'A' : 'B'} 原文`, toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false }], nextBeforeSeq: null, nextBeforeOffset: null })),
  );
});
afterEach(async () => { cleanup(); await queryClient.cancelQueries(); resetAppRuntime(); });

it('portals only navigation and keeps the original selection and task controller', async () => {
  const host = document.createElement('aside'); document.body.append(host);
  const h = panel({ historyTarget: host, task: task({ conversationId: A }) });
  await screen.findByText('A 原文');
  expect(within(host).getByRole('navigation', { name: '会话列表' })).toBeInTheDocument();
  expect(within(h.container).queryByRole('navigation', { name: '会话列表' })).toBeNull();
  await userEvent.click(within(host).getByRole('button', { name: '会话 B' }));
  await screen.findByText('B 原文');
  expect(sessionStorage.getItem(`manao.agent-conversation.${U}.${P}`)).toBe(B);
  expect(h.close).not.toHaveBeenCalled();
  host.remove();
});
it('does not duplicate navigation while the shell history host is pending', async () => {
  panel({ historyTarget: null }); await screen.findByText('A 原文');
  expect(screen.queryByRole('navigation', { name: '会话列表' })).toBeNull();
});

it('creates an empty conversation without submitting a model task', async () => {
  let taskPosts = 0;
  server.use(http.post(`${URL}/:id/tasks`, () => { taskPosts++; return HttpResponse.error(); }), http.post(URL, async ({ request }) => HttpResponse.json(conversation((await request.json() as { conversationId: string }).conversationId, { title: '新会话', headSeq: 0 }))));
  panel(); await userEvent.click(await screen.findByRole('button', { name: '新建会话' }));
  expect(await screen.findByRole('button', { name: '新会话' })).toHaveAttribute('aria-pressed', 'true');
  expect(taskPosts).toBe(0);
});
it('switches history and ignores a late A response in B', async () => {
  let release = () => {}; let started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  server.use(http.get(`${URL}/${A}/entries`, async () => { started = true; await held; return HttpResponse.json({ items: [{ seq: 1, taskId: T, kind: 'assistant', text: 'A late', toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false }], nextBeforeSeq: null, nextBeforeOffset: null }); }));
  panel(); await waitFor(() => expect(started).toBe(true));
  await userEvent.click(screen.getByRole('button', { name: '会话 B' }));
  expect(await screen.findByText('B 原文')).toBeInTheDocument();
  await act(async () => { release(); await held; });
  expect(screen.queryByText('A late')).not.toBeInTheDocument();
});
it('restores selection and authoritative last round after remount', async () => {
  server.use(http.get(`${URL}/${B}`, () => HttpResponse.json(conversation(B, { lastTaskId: T }))), http.get(`/api/v1/projects/${P}/agent-tasks/${T}`, () => HttpResponse.json(task({ state: 'FAILED', writesLocked: false, conversationId: B, failureCode: 'AI_CONTEXT_UNAVAILABLE' }))));
  const first = panel(); await userEvent.click(await screen.findByRole('button', { name: '会话 B' })); first.unmount();
  panel(); expect(await screen.findByText('B 原文')).toBeInTheDocument();
  expect(await screen.findByText('FAILED')).toBeInTheDocument(); expect(screen.getByText('AI_CONTEXT_UNAVAILABLE')).toBeInTheDocument();
});
it('submits the selected conversation with original task/conversation identity persisted before POST', async () => {
  let posted: Record<string, unknown> | null = null, stored: string | null = null;
  server.use(http.post(`${URL}/${B}/tasks`, async ({ request }) => { posted = await request.json() as Record<string, unknown>; stored = sessionStorage.getItem(agentTaskStorageKey(U, P)); return HttpResponse.json(task({ taskId: posted.taskId, conversationId: B })); }));
  const h = panel(); await userEvent.click(await screen.findByRole('button', { name: '会话 B' }));
  await userEvent.type(screen.getByLabelText('Task goal'), '第二轮目标'); await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await waitFor(() => expect(h.accepted).toHaveBeenCalled());
  expect(posted).toMatchObject({ prompt: '第二轮目标', expectedWorkspaceRevision: '7' });
  expect(JSON.parse(stored!)).toEqual({ taskId: posted!.taskId, conversationId: B });
});
it('recovers the original uncertain A task after switching B and never submits a replacement', async () => {
  let release = () => {}, postedId = '', posts = 0;
  const held = new Promise<void>(r => { release = r; });
  server.use(http.post(`${URL}/${A}/tasks`, async ({ request }) => { posts++; postedId = (await request.json() as { taskId: string }).taskId; await held; return HttpResponse.error(); }), http.get(`/api/v1/projects/${P}/agent-tasks/:id`, ({ params }) => HttpResponse.json(task({ taskId: String(params.id), conversationId: A }))));
  const h = panel(); await screen.findByText('A 原文'); await userEvent.type(screen.getByLabelText('Task goal'), 'A 目标'); await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await waitFor(() => expect(postedId).not.toBe('')); await userEvent.click(screen.getByRole('button', { name: '会话 B' }));
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  release();
  await waitFor(() => expect(h.accepted).toHaveBeenCalledWith(expect.objectContaining({ taskId: postedId })));
  expect(screen.getByRole('button', { name: '会话 B' })).toHaveAttribute('aria-pressed', 'true'); expect(posts).toBe(1);
});
it('keeps global occupancy and explicit close when another conversation is selected', async () => {
  const h = panel({ task: task({ conversationId: A, state: 'NEEDS_ATTENTION' }) });
  await userEvent.click(await screen.findByRole('button', { name: '会话 B' }));
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '压缩上下文' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '项目有任务运行中' }));
  expect(screen.getByRole('button', { name: '会话 A' })).toHaveAttribute('aria-pressed', 'true'); expect(h.close).not.toHaveBeenCalled();
});
it.each(['occupying', 'settled'])('retains old task-only progress and explicit controls: %s', async state => {
  const snapshot = task({ state: state === 'occupying' ? 'RUNNING' : 'COMPLETED', writesLocked: state === 'occupying', progress: [{ seq: 1, kind: 'message', text: 'legacy progress', truncated: true }] });
  panel(state === 'occupying' ? { task: snapshot } : { settledTask: snapshot });
  expect(await screen.findByText(/legacy progress/)).toBeInTheDocument();
  if (state === 'occupying') expect(screen.getByRole('button', { name: 'End task' })).toBeInTheDocument();
});
it('does not replace the current conversation round with an older settled shell snapshot', async () => {
  server.use(http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, { lastTaskId: B }))), http.get(`/api/v1/projects/${P}/agent-tasks/${B}`, () => HttpResponse.json(task({ taskId: B, conversationId: A, state: 'FAILED', writesLocked: false }))));
  panel({ settledTask: task({ taskId: T, conversationId: A, state: 'COMPLETED', writesLocked: false }) });
  expect(await screen.findByText('FAILED')).toBeInTheDocument(); expect(screen.queryByText('COMPLETED')).not.toBeInTheDocument();
});
it('keeps native history once, uses authoritative status, and displays unknown usage after compaction', async () => {
  server.use(http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, { lastTaskId: T, compactState: 'COMPLETED', compactRequestId: B }))), http.get(`/api/v1/projects/${P}/agent-tasks/${T}`, () => HttpResponse.json(task({ state: 'COMPLETED', writesLocked: false, conversationId: A, summary: 'A 原文', progress: [{ seq: 1, kind: 'message', text: 'truncated duplicate', truncated: true }] }))));
  panel(); expect(await screen.findByText('COMPLETED')).toBeInTheDocument(); expect(screen.getAllByText('A 原文')).toHaveLength(1); expect(screen.queryByText('truncated duplicate')).not.toBeInTheDocument(); expect(screen.getByText('占用暂不可用')).toBeInTheDocument();
});
it('preserves an uncertain compact request and checks the original detail before a later click', async () => {
  let posted: { requestId: string; expectedHeadSeq: number } | null = null; let posts = 0;
  server.use(http.post(`${URL}/${A}/compact`, async ({ request }) => { posts++; posted = await request.json() as typeof posted; return HttpResponse.error(); }), http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, posted ? { compactRequestId: posted.requestId, compactState: 'RUNNING' } : {}))));
  const h = panel(); await screen.findByText('A 原文'); await userEvent.click(screen.getByRole('button', { name: '压缩上下文' }));
  await waitFor(() => expect(posts).toBe(1)); expect(screen.getByRole('button', { name: '压缩上下文' })).toBeDisabled();
  h.unmount(); panel(); await screen.findByText('压缩中'); expect(posts).toBe(1); expect(posted).toMatchObject({ expectedHeadSeq: 1 });
});

it('explicitly retries an unregistered compact after remount with the byte-identical original identity from B', async () => {
  const bodies: string[] = [], paths: string[] = []; let completed = false;
  const key = `manao.agent-compact.${U}.${P}`;
  server.use(
    http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, completed ? { compactRequestId: JSON.parse(bodies[0]!).requestId, compactState: 'COMPLETED' } : {}))),
    http.post(`${URL}/:id/compact`, async ({ request, params }) => {
      bodies.push(await request.text()); paths.push(String(params.id));
      if (bodies.length === 1) return HttpResponse.error(); // Never registered by the backend.
      completed = true;
      return HttpResponse.json(conversation(A, { compactRequestId: JSON.parse(bodies[0]!).requestId, compactState: 'COMPLETED' }));
    }),
  );
  const h = panel(); await screen.findByText('A 原文');
  await userEvent.click(screen.getByRole('button', { name: '压缩上下文' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: '核对压缩状态' })).toBeEnabled());
  const stored = sessionStorage.getItem(key);
  expect(JSON.parse(stored!)).toMatchObject({ conversationId: A, expectedHeadSeq: 1, requestId: JSON.parse(bodies[0]!).requestId });
  h.unmount(); panel(); await screen.findByText('A 原文');
  await userEvent.click(screen.getByRole('button', { name: '会话 B' })); await screen.findByText('B 原文');
  await userEvent.type(screen.getByLabelText('Task goal'), 'B 下一轮');
  await userEvent.click(screen.getByRole('button', { name: '核对压缩状态' }));
  expect(sessionStorage.getItem(key)).toBe(stored); expect(bodies).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '压缩上下文' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '重试原压缩请求' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
  expect(bodies).toEqual([bodies[0], bodies[0]]); expect(paths).toEqual([A, A]);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(screen.getByRole('button', { name: '压缩上下文' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '会话 B' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('压缩完成')).not.toBeInTheDocument();
});

it.each([true, false])('reconciles a definite original retry refusal without leaking A into B; detail available: %s', async available => {
  const key = `manao.agent-compact.${U}.${P}`;
  const intent = { conversationId: A, requestId: T, expectedHeadSeq: 1 };
  sessionStorage.setItem(key, JSON.stringify(intent));
  let refused = false, posts = 0;
  server.use(
    http.get(`${URL}/${A}`, () => refused && !available ? HttpResponse.error() : HttpResponse.json(conversation(A, { headSeq: 2 }))),
    http.post(`${URL}/${A}/compact`, async ({ request }) => {
      expect(await request.json()).toEqual(intent); posts++; refused = true;
      return HttpResponse.json({ code: 'AI_CONTEXT_CONFLICT', message: 'conflict', traceId: 'conflict' }, { status: 409 });
    }),
  );
  panel(); await userEvent.click(await screen.findByRole('button', { name: '会话 B' })); await screen.findByText('B 原文');
  await userEvent.type(screen.getByLabelText('Task goal'), 'B 下一轮');
  await userEvent.click(screen.getByRole('button', { name: '重试原压缩请求' }));
  await waitFor(() => expect(posts).toBe(1));
  if (!available) await waitFor(() => expect(screen.getByRole('button', { name: '重试原压缩请求' })).toBeEnabled());
  await waitFor(() => expect(sessionStorage.getItem(key)).toBe(available ? null : JSON.stringify(intent)));
  expect(screen.getByRole('button', { name: '会话 B' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('压缩请求被拒绝，请稍后重试')).not.toBeInTheDocument();
  if (available) expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
  else expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
});

it.each([409, 403])('keeps the original pending identity after retry refusal %i while its unchanged base can still be admitted', async status => {
  const key = `manao.agent-compact.${U}.${P}`;
  const stored = JSON.stringify({ conversationId: A, requestId: T, expectedHeadSeq: 1 });
  sessionStorage.setItem(key, stored); let posts = 0;
  server.use(http.post(`${URL}/${A}/compact`, () => { posts++; return HttpResponse.json({ code: 'AI_CONTEXT_BUSY', message: 'refused', traceId: 'refused' }, { status }); }));
  panel(); await screen.findByText('A 原文');
  await userEvent.type(screen.getByLabelText('Task goal'), '下一轮');
  await userEvent.click(screen.getByRole('button', { name: '重试原压缩请求' }));
  await waitFor(() => expect(posts).toBe(1));
  await waitFor(() => expect(screen.getByRole('button', { name: '重试原压缩请求' })).toBeEnabled());
  expect(sessionStorage.getItem(key)).toBe(stored);
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '压缩上下文' })).toBeDisabled();
});

it('does not apply a late A compaction failure to the selected B view', async () => {
  let release = () => {}, started = false; const held = new Promise<void>(resolve => { release = resolve; });
  server.use(http.post(`${URL}/${A}/compact`, async () => { started = true; await held; return HttpResponse.json({ code: 'PROJECT_BUSY', message: 'busy', traceId: 'busy' }, { status: 409 }); }));
  panel(); await screen.findByText('A 原文'); await userEvent.click(screen.getByRole('button', { name: '压缩上下文' }));
  await waitFor(() => expect(started).toBe(true)); await userEvent.click(screen.getByRole('button', { name: '会话 B' })); expect(await screen.findByText('B 原文')).toBeInTheDocument();
  await act(async () => { release(); await held; });
  await waitFor(() => expect(screen.getByRole('button', { name: '压缩上下文' })).toBeEnabled());
  expect(screen.queryByText('压缩请求被拒绝，请稍后重试')).not.toBeInTheDocument();
});

it('keeps the original text after a completed manual compaction and never invents final usage', async () => {
  let state: string | null = null, requestId: string | null = null;
  server.use(
    http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, { headSeq: state === 'COMPLETED' ? 2 : 1, compactState: state, compactRequestId: requestId, usage: state === 'COMPLETED' ? { tokens: null, contextWindow: 1048576, percent: null } : { tokens: 786432, contextWindow: 1048576, percent: 75 } }))),
    http.post(`${URL}/${A}/compact`, async ({ request }) => { requestId = (await request.json() as { requestId: string }).requestId; state = 'RUNNING'; return HttpResponse.json(conversation(A, { compactRequestId: requestId, compactState: state })); }),
    http.get(`${URL}/${A}/entries`, () => HttpResponse.json({ items: [{ seq: 1, taskId: T, kind: 'assistant', text: '永久保留的原文', toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false }, ...(state === 'COMPLETED' ? [{ seq: 2, taskId: null, kind: 'compaction', text: '上下文已压缩', toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false }] : [])], nextBeforeSeq: null, nextBeforeOffset: null })),
  );
  panel(); expect(await screen.findByText('约 75.0%')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: '压缩上下文' }));
  expect(await screen.findByText('压缩中')).toBeInTheDocument(); state = 'COMPLETED';
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['agent-conversations', U, P] }); });
  expect(await screen.findByText('压缩完成')).toBeInTheDocument(); expect(screen.getByText('占用暂不可用')).toBeInTheDocument();
  expect(screen.getAllByText('永久保留的原文')).toHaveLength(1); expect(screen.getByRole('button', { name: '压缩上下文' })).toBeEnabled();
});

it('continues two settled programming rounds in one conversation with new task IDs', async () => {
  const ids: string[] = [];
  server.use(http.post(`${URL}/${A}/tasks`, async ({ request }) => { const id = (await request.json() as { taskId: string }).taskId; ids.push(id); return HttpResponse.json(task({ taskId: id, conversationId: A, state: 'COMPLETED', writesLocked: false })); }), http.get(`/api/v1/projects/${P}/agent-tasks/:id`, ({ params }) => HttpResponse.json(task({ taskId: String(params.id), conversationId: A, state: 'COMPLETED', writesLocked: false }))));
  const h = panel(); await screen.findByText('A 原文'); await userEvent.type(screen.getByLabelText('Task goal'), '首轮'); await userEvent.click(screen.getByRole('button', { name: 'Start task' })); await waitFor(() => expect(h.accepted).toHaveBeenCalledTimes(1));
  await userEvent.clear(screen.getByLabelText('Task goal')); await userEvent.type(screen.getByLabelText('Task goal'), '继续修改'); await userEvent.click(screen.getByRole('button', { name: 'Start task' })); await waitFor(() => expect(h.accepted).toHaveBeenCalledTimes(2));
  expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]); expect(screen.getByRole('button', { name: '会话 A' })).toHaveAttribute('aria-pressed', 'true');
});

it('keeps original task identity when reconciliation returns a mismatched conversation', async () => {
  sessionStorage.setItem(agentTaskStorageKey(U, P), JSON.stringify({ taskId: T, conversationId: A }));
  let posts = 0;
  server.use(http.get(`/api/v1/projects/${P}/agent-tasks/${T}`, () => HttpResponse.json(task({ conversationId: B }))), http.post(`${URL}/:id/tasks`, () => { posts++; return HttpResponse.error(); }));
  const h = panel(); await screen.findByText('A 原文'); await userEvent.type(screen.getByLabelText('Task goal'), '核对原请求'); await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  expect(await screen.findByText('Could not verify the previous task. Try again in a moment.')).toBeInTheDocument();
  expect(h.accepted).not.toHaveBeenCalled(); expect(posts).toBe(0); expect(JSON.parse(sessionStorage.getItem(agentTaskStorageKey(U, P))!)).toEqual({ taskId: T, conversationId: A });
});

it('shows the new conversation round after a legacy task-only result', async () => {
  server.use(http.get(`${URL}/${A}`, () => HttpResponse.json(conversation(A, { lastTaskId: B }))), http.get(`/api/v1/projects/${P}/agent-tasks/${B}`, () => HttpResponse.json(task({ taskId: B, conversationId: A, state: 'FAILED', writesLocked: false }))));
  panel({ settledTask: task({ state: 'COMPLETED', writesLocked: false, summary: 'old legacy' }) });
  expect(await screen.findByText('FAILED')).toBeInTheDocument(); expect(screen.queryByText('old legacy')).not.toBeInTheDocument();
});
