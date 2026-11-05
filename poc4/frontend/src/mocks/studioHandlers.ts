import { http, HttpResponse } from 'msw';
import { readOwnedProjectSummary, resolveUserByAccessToken } from './state';
import { getMockFile, getWorkspaceRevision, resolveFileText, saveMockFile } from './fileFixtures';
import type { Application, Attachment, Conversation, FileChange, ModelInput, StudioModel, Turn, TurnInput, ApplyInput, Validation } from '../features/ai/studio/types';

type MockTurn = { owner: string; project: string; input: string; started: number; turn: Turn; full: string; applied?: boolean };
const models = new Map<string, StudioModel[]>(), conversations = new Map<string, { owner: string; project: string; view: Conversation }>(), turns = new Map<string, MockTurn>(), attachments = new Map<string, { owner: string; project: string; view: Attachment }>();
export function resetStudioMock() { models.clear(); conversations.clear(); turns.clear(); attachments.clear(); }
const modelId = 'c91f47f0-173b-4c54-b7a7-c93b6a4339cc';
const validation: Validation = { goal: 'test', exitCode: 0, cleanupConfirmed: true, output: '[Mock] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0\nBUILD SUCCESS', testReports: [{ testClass: 'demo.AppTest', tests: 4, failures: 0, errors: 0, skipped: 0 }] };
const isNodeProject = (project: string) => getMockFile(project, 'package.json') !== null;
const validationFor = (project: string): Validation => isNodeProject(project)
  ? { ...validation, output: '[Mock] pnpm run build && pnpm run test\nTests: 2, Passed: 2, Failed: 0', testReports: [{ testClass: 'node:test', tests: 2, failures: 0, errors: 0, skipped: 0 }] }
  : validation;
const error = (status: number, code = 'ENTRY_NOT_FOUND') => HttpResponse.json({ code, message: code, traceId: 'studio-local-mock' }, { status });
function owner(request: Request, project?: string) { const user = resolveUserByAccessToken(request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null); return user && (!project || readOwnedProjectSummary(user.id, project)) ? user.id : null; }
function availableModels(user: string) { if (!models.has(user)) models.set(user, [{ id: modelId, label: '本地演示', baseUrl: 'https://mock.invalid/v1', model: 'local-mock', vision: true, tools: true, keyConfigured: true }]); return models.get(user)!; }
function ownedTurn(request: Request, project: string, id: string) { const user = owner(request, project), found = turns.get(id); return user && found?.owner === user && found.project === project ? found : null; }
function changes(project: string, id: string): FileChange[] {
  const path = 'README.md', file = getMockFile(project, path), before = file ? resolveFileText(file, false) : '';
  const lines = before.split('\n'), testInstruction = isNodeProject(project) ? '运行 pnpm run build 和 pnpm test 检查项目。' : '运行 mvn test 检查项目。';
  return [{ path, before, beforeSha256: 'a'.repeat(64), after: ['# Manao 项目说明', ...lines.slice(1), '', '## 验证', testInstruction].join('\n'), hunks: [
    { id: `${id}-heading`, start: 0, before: [lines[0] ?? ''], after: ['# Manao 项目说明'] },
    { id: `${id}-validation`, start: lines.length, before: [], after: ['', '## 验证', testInstruction] },
  ] }];
}
function advance(row: MockTurn) {
  const t = row.turn; if (!['RUNNING', 'STOPPING'].includes(t.state)) return;
  const duration = t.prompt.includes('[slow]') ? 12000 : 1800; const elapsed = Date.now() - row.started;
  const fraction = Math.min(1, elapsed / duration); const reply = row.full.slice(0, Math.floor(row.full.length * fraction));
  if (reply !== t.reply) { t.reply = reply; t.version++; }
  if (t.mode === 'TASK' && t.task) {
    const progress = [{ seq: 1, kind: 'tool_start', text: `read_file ${t.id}-read`, truncated: false }, { seq: 2, kind: 'tool_end', text: `read_file ${t.id}-read`, truncated: false }];
    if (fraction > .3) progress.push({ seq: 3, kind: 'tool_start', text: `write_file ${t.id}-write`, truncated: false }, { seq: 4, kind: 'tool_end', text: `write_file ${t.id}-write`, truncated: false });
    if (fraction > .6) progress.push({ seq: 5, kind: 'tool_start', text: `build ${t.id}-build`, truncated: false });
    if (fraction === 1) progress.push({ seq: 6, kind: 'tool_end', text: `build ${t.id}-build`, truncated: false });
    t.task.progress = progress;
  }
  if (fraction === 1) {
    if (t.prompt.includes('[error]')) { t.state = 'FAILED'; t.error = 'AI_MODEL_DISCONNECTED'; }
    else t.state = t.mode === 'TASK' && t.applyPolicy === 'REVIEW' ? 'REVIEW' : 'COMPLETED';
    if (t.task) {
      t.files = changes(row.project, t.id); t.task.state = t.state === 'FAILED' ? 'FAILED' : 'COMPLETED'; t.task.writesLocked = false; t.task.summary = t.reply;
      if (t.applyPolicy === 'AUTO' && !row.applied) { saveMockFile(row.project, t.files[0]!.path, t.files[0]!.after); row.applied = true; t.task.changedPaths = t.files.map(f => f.path); t.task.workspaceRevision = getWorkspaceRevision(row.project); }
    } else t.tools = [{ id: `${t.id}-read`, name: 'read_file', state: 'COMPLETED', result: '[Mock] 已读取 README.md，只读访问。' }];
    t.version++;
  }
}
const base = '/api/v1/projects/:project/assistant';
export const studioHandlers = [
  http.get(`${base}/applications/pending`, ({ request, params }) => {
    const user = owner(request, String(params.project)); if (!user) return error(404);
    return HttpResponse.json([...turns.values()].filter(row => row.owner === user && row.project === params.project && ['APPLYING', 'VALIDATING'].includes(row.turn.application?.state ?? '')).map(row => ({ ...row.turn.application, turnId: row.turn.id })));
  }),
  http.get('/api/v1/assistant/models', ({ request }) => { const user = owner(request); return user ? HttpResponse.json(availableModels(user)) : error(401, 'UNAUTHENTICATED'); }),
  http.post('/api/v1/assistant/models', async ({ request }) => {
    const user = owner(request); if (!user) return error(401, 'UNAUTHENTICATED');
    const body = await request.json() as ModelInput;
    if (!body.label?.trim() || !body.model?.trim() || !body.baseUrl?.startsWith('https://') || !body.apiKey && !availableModels(user).some(m => m.id === body.id)) return error(422, 'VALIDATION_ERROR');
    const model: StudioModel = { id: body.id, label: body.label, model: body.model, baseUrl: body.baseUrl, vision: body.vision, tools: body.tools, keyConfigured: true };
    models.set(user, [model, ...availableModels(user).filter(m => m.id !== model.id)]); return HttpResponse.json(model); // Mock never stores API keys.
  }),
  http.delete('/api/v1/assistant/models/:id', ({ request, params }) => { const user = owner(request); if (!user) return error(401, 'UNAUTHENTICATED'); models.set(user, availableModels(user).filter(m => m.id !== params.id)); return new HttpResponse(null, { status: 204 }); }),
  http.get(`${base}/conversations`, ({ request, params }) => { const user = owner(request, String(params.project)); return user ? HttpResponse.json([...conversations.values()].filter(c => c.owner === user && c.project === params.project).map(c => c.view).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) : error(404); }),
  http.post(`${base}/conversations/:conversation`, ({ request, params }) => {
    const user = owner(request, String(params.project)); if (!user) return error(404);
    const id = String(params.conversation), old = conversations.get(id);
    if (old && (old.owner !== user || old.project !== params.project)) return error(404);
    const view = old?.view ?? { id, title: '新会话', updatedAt: new Date().toISOString() }; conversations.set(id, { owner: user, project: String(params.project), view }); return HttpResponse.json(view);
  }),
  http.get(`${base}/conversations/:conversation/turns`, ({ request, params }) => {
    const user = owner(request, String(params.project)), c = conversations.get(String(params.conversation));
    if (!user || c?.owner !== user || c.project !== params.project) return error(404);
    return HttpResponse.json([...turns.values()].filter(row => row.owner === user && row.project === params.project && row.turn.conversationId === params.conversation).map(row => { advance(row); return row.turn; }));
  }),
  http.post(`${base}/conversations/:conversation/turns`, async ({ request, params }) => {
    const user = owner(request, String(params.project)), c = conversations.get(String(params.conversation)); if (!user || c?.owner !== user || c.project !== params.project) return error(404);
    const input = await request.json() as TurnInput, old = turns.get(input.id);
    if (old) return old.input === JSON.stringify(input) && old.owner === user && old.turn.conversationId === params.conversation ? HttpResponse.json(old.turn) : error(409, 'AI_TASK_MISMATCH');
    if (!input.prompt?.trim() || !availableModels(user).some(m => m.id === input.modelId)) return error(422, 'VALIDATION_ERROR');
    if ([...turns.values()].some(row => row.project === params.project && (row.turn.state === 'RUNNING' || row.turn.state === 'STOPPING'))) return error(409, 'AI_TASK_ACTIVE');
    if (input.mode === 'TASK' && input.expectedRevision !== getWorkspaceRevision(String(params.project))) return error(409, 'WORKSPACE_REVISION_CONFLICT');
    const turn: Turn = { ...input, conversationId: String(params.conversation), createdAt: new Date().toISOString(), state: 'RUNNING', reply: '', tools: [], files: [], version: 0,
      attachments: input.attachmentIds.map(id => attachments.get(id)?.view).filter((a): a is Attachment => !!a) };
    if (input.mode === 'TASK') { turn.taskId = input.id; turn.task = { taskId: input.id, conversationId: input.id, state: 'RUNNING', writesLocked: true, workspaceRevision: input.expectedRevision, progress: [], changedPaths: [], summary: null, failureCode: null, reasoningEffort: 'off' }; }
    c.view.title = input.prompt.slice(0, 50); c.view.updatedAt = turn.createdAt;
    const full = input.mode === 'CHAT' ? '我会结合当前项目的文件和日志，帮你梳理思路。\n\n### 项目概览\n\n- **项目结构**：源代码放在 `src/` 中，使用 Maven 管理构建。\n- **下一步**：先确认目标，再查看相关文件。\n\n```java\nSystem.out.println("Hello, Manao!");\n```\n\n这是一条本地 mock 回复，可继续对话或切换到任务模式。' : '已整理项目说明，并补充验证步骤。\n\n本次修改 **README.md**。' + (input.applyPolicy === 'REVIEW' ? '请确认是否接受；应用后会自动验证。' : '变更已直接应用到项目。');
    const nodeReply = '我会结合当前项目的文件和日志，帮你梳理思路。\n\n### 项目概览\n\n- **项目结构**：源代码放在 `src/` 中，使用 Node.js 24 与 pnpm 管理构建。\n- **验证方式**：先执行 `pnpm run build`，再执行 `pnpm test`。\n\n```javascript\nconsole.log("Hello, Manao!");\n```\n\n这是一条本地 mock 回复，可继续对话或切换到任务模式。';
    turns.set(turn.id, { owner: user, project: String(params.project), input: JSON.stringify(input), started: Date.now(), turn, full: input.mode === 'CHAT' && isNodeProject(String(params.project)) ? nodeReply : full }); return HttpResponse.json(turn);
  }),
  http.get(`${base}/turns/:turn`, ({ request, params }) => { const row = ownedTurn(request, String(params.project), String(params.turn)); if (!row) return error(404); advance(row); return HttpResponse.json(row.turn); }),
  http.post(`${base}/turns/:turn/stop`, ({ request, params }) => { const row = ownedTurn(request, String(params.project), String(params.turn)); if (!row) return error(404); row.turn.state = 'STOPPED'; row.turn.version++; if (row.turn.task) { row.turn.task.state = 'FAILED'; row.turn.task.writesLocked = false; row.turn.task.failureCode = 'AI_CLOSED'; } return HttpResponse.json(row.turn); }),
  http.get(`${base}/turns/:turn/events`, ({ request, params }) => {
    const row = ownedTurn(request, String(params.project), String(params.turn)); if (!row) return error(404);
    let timer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { const send = () => { if (request.signal.aborted) { clearInterval(timer); try { controller.close(); } catch { /* Cancellation may already have closed the stream. */ } return; } advance(row); controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(row.turn)}\n\n`)); if (!['RUNNING', 'STOPPING'].includes(row.turn.state)) { clearInterval(timer); controller.close(); } }; timer = setInterval(send, 90); send(); }, cancel() { clearInterval(timer); } });
    return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }),
  http.post(`${base}/attachments`, async ({ request, params }) => {
    const user = owner(request, String(params.project)); if (!user) return error(404);
    const body = await request.json() as { name: string; mediaType: string; base64: string };
    if (!body.base64 || body.base64.length > 12 * 1024 * 1024) return error(422, 'FILE_TOO_LARGE');
    const view = { id: crypto.randomUUID(), name: body.name, mediaType: body.mediaType || 'text/plain', size: Math.floor(body.base64.length * .75), truncated: false };
    attachments.set(view.id, { owner: user, project: String(params.project), view }); return HttpResponse.json(view);
  }),
  http.post(`${base}/turns/:turn/apply`, async ({ request, params }) => {
    const row = ownedTurn(request, String(params.project), String(params.turn)); if (!row) return error(404);
    const body = await request.json() as ApplyInput, t = row.turn;
    if (t.application?.requestId) return t.application.requestId === body.requestId ? HttpResponse.json(t.application) : error(409, 'AI_APPLY_MISMATCH');
    if (body.expectedRevision !== getWorkspaceRevision(row.project)) return error(409, 'WORKSPACE_REVISION_CONFLICT');
    const application: Application = { state: body.hunkIds.length ? 'COMPLETED' : 'REJECTED', requestId: body.requestId, hunkIds: body.hunkIds, baseRevision: Number(body.expectedRevision), taskId: body.requestId };
    for (const file of t.files) {
      const lines = (file.before ?? '').split('\n');
      for (const hunk of file.hunks.filter(h => body.hunkIds.includes(h.id)).sort((a, b) => b.start - a.start)) lines.splice(hunk.start, hunk.before.length, ...hunk.after);
      if (body.hunkIds.some(id => file.hunks.some(h => h.id === id))) saveMockFile(row.project, file.path, lines.join('\n'));
    }
    if (body.hunkIds.length) application.validation = validationFor(row.project);
    application.workspaceRevision = getWorkspaceRevision(row.project); t.application = application; t.version++; return HttpResponse.json(application);
  }),
  http.get('/api/v1/projects/:project/agent-tasks/current', ({ request, params }) => { const user = owner(request, String(params.project)); if (!user) return; const row = [...turns.values()].find(r => r.owner === user && r.project === params.project && r.turn.task?.writesLocked); if (!row) return; advance(row); return row.turn.task?.writesLocked ? HttpResponse.json(row.turn.task) : undefined; }),
  http.get('/api/v1/projects/:project/agent-tasks/:task', ({ request, params }) => { const row = ownedTurn(request, String(params.project), String(params.task)); if (!row?.turn.task) return; advance(row); return HttpResponse.json(row.turn.task); }),
  http.get('/api/v1/projects/:project/agent-tasks/:task/tools/:call', ({ request, params }) => { const row = ownedTurn(request, String(params.project), String(params.task)); if (!row) return; return HttpResponse.json({ toolCallId: String(params.call), toolName: String(params.call).endsWith('build') ? 'build' : 'read_file', data: String(params.call).endsWith('build') ? validationFor(row.project) : { path: 'README.md', staged: row.turn.applyPolicy === 'REVIEW' } }); }),
  http.post('/api/v1/projects/:project/agent-tasks/:task/close', ({ request, params }) => { const row = ownedTurn(request, String(params.project), String(params.task)); if (!row?.turn.task) return; row.turn.state = 'STOPPED'; row.turn.task.writesLocked = false; row.turn.task.state = 'FAILED'; row.turn.task.failureCode = 'AI_CLOSED'; row.turn.version++; return HttpResponse.json(row.turn.task); }),
];
