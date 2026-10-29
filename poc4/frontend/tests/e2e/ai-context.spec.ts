import { spawn } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { assertConversationBookAnswer, assertConversationFixtureRead, assertConversationTools } from './ai-context-answer';

// Real deployment/model only; this file neither seeds nor deletes a project.
const project = process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID!;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(project)) throw new Error('NOT_RUN: explicit disposable project UUID required.');
const root = `/api/v1/projects/${project}`;
const occupying = new Set(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION']);
type Task = { taskId: string; conversationId: string; state: string; writesLocked: boolean };
type View = { conversationId: string; title: string; headSeq: number; activeTaskId: string | null; compactRequestId: string | null; compactState: string | null };
type Item = { seq: number; textOffset: number; kind: string; text: string; taskId: string | null; toolCallId: string | null };
let token = '';
async function login(page: Page): Promise<void> {
  await page.getByLabel('Username').fill(process.env.MANAO_AI_ACCEPTANCE_USERNAME!);
  await page.getByLabel('Password').fill(process.env.MANAO_AI_ACCEPTANCE_PASSWORD!);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const accepted = await response; expect(accepted.status()).toBe(200);
  token = (await accepted.json() as { accessToken: string }).accessToken;
  expect(typeof token).toBe('string'); expect(token.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0, maxRetries: 0 });
  expect(response.ok(), 'owner-scoped read must succeed').toBeTruthy(); return response.json() as Promise<T>;
}
async function history(page: Page, id: string): Promise<Item[]> {
  const rows: Item[] = []; let cursor = ''; const seen = new Set<string>();
  for (let pages = 0; pages < 100; pages++) {
    expect(seen.has(cursor), 'history cursor must advance').toBe(false); seen.add(cursor);
    const pageData = await get<{ items: Item[]; nextBeforeSeq: number | null; nextBeforeOffset: number | null }>(page, `${root}/conversations/${id}/entries?limit=100${cursor}`);
    rows.push(...pageData.items);
    if (pageData.nextBeforeSeq === null) return rows.sort((a, b) => a.seq - b.seq || a.textOffset - b.textOffset);
    cursor = `&beforeSeq=${pageData.nextBeforeSeq}${pageData.nextBeforeOffset === null ? '' : `&beforeOffset=${pageData.nextBeforeOffset}`}`;
  }
  throw new Error('History exceeded bounded acceptance budget');
}
async function create(page: Page): Promise<View> {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === `${root}/conversations` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const accepted = await response; expect(accepted.ok()).toBeTruthy(); return accepted.json() as Promise<View>;
}
async function submit(page: Page, conversationId: string, prompt: string): Promise<Task> {
  await page.locator('#agent-task-goal').fill(prompt);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === `${root}/conversations/${conversationId}/tasks` && r.request().method() === 'POST');
  const start = page.getByRole('button', { name: 'Start task', exact: true });
  await expect(start).toBeEnabled(); await start.click(); const accepted = await response;
  expect(accepted.ok()).toBeTruthy(); const task = await accepted.json() as Task;
  expect(task.conversationId).toBe(conversationId);
  let final = task;
  await expect.poll(async () => { final = await get<Task>(page, `${root}/agent-tasks/${task.taskId}`); return occupying.has(final.state); }, { timeout: 360_000, intervals: [2000] }).toBe(false);
  expect(final.state).toBe('COMPLETED'); expect(final.writesLocked).toBe(false); return final;
}
async function answer(page: Page, conversationId: string, taskId: string): Promise<string> {
  return (await history(page, conversationId)).filter(i => i.taskId === taskId && i.kind === 'assistant').map(i => i.text).join('');
}
function kubectl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MANAO_AI_CONTEXT_KUBECTL ?? 'kubectl', [
      '--context', process.env.MANAO_AI_CONTEXT_KUBE_CONTEXT!, '--namespace', process.env.MANAO_AI_CONTEXT_NAMESPACE!, ...args,
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Fixed worker checkpoint timed out')); }, 200_000);
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 4 * 1024 * 1024) { child.kill(); } });
    child.on('error', () => { clearTimeout(timer); reject(new Error('kubectl unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error('Fixed worker checkpoint failed; inspect operator diagnostics privately')); });
  });
}
async function readyWorker() {
  const deployment = process.env.MANAO_AI_CONTEXT_WORKER_DEPLOYMENT!;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(deployment)) throw new Error('Explicit worker Deployment name required');
  const dep = JSON.parse(await kubectl(['get', `deployment/${deployment}`, '-o', 'json']));
  expect(dep.spec.replicas).toBe(1); expect(dep.spec.strategy.type).toBe('Recreate'); expect(dep.status.readyReplicas).toBe(1);
  expect(dep.spec.selector.matchExpressions ?? []).toHaveLength(0);
  const selector = Object.entries(dep.spec.selector.matchLabels as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(',');
  expect(selector.length).toBeGreaterThan(0);
  const pods = JSON.parse(await kubectl(['get', 'pods', '-l', selector, '-o', 'json'])).items as Array<{ metadata: { uid: string; deletionTimestamp?: string }; status: { conditions?: Array<{ type: string; status: string }> } }>;
  expect(pods).toHaveLength(1); expect(pods[0]!.metadata.deletionTimestamp).toBeUndefined();
  expect(pods[0]!.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')).toBe(true);
  return pods[0]!.metadata.uid;
}

test('A reads a bounded fixture and continues → isolated B → idle worker recreation → native compact retains original history', async ({ page }, info) => {
  await page.goto(`/projects/${project}`);
  await login(page);
  const fixturePath = process.env.MANAO_AI_CONTEXT_FIXTURE_PATH!;
  const fixture = await get<{ path: string; content: string; workspaceRevision: string }>(page, `${root}/files/content?path=${encodeURIComponent(fixturePath)}`);
  const fixtureBytes = Buffer.byteLength(fixture.content, 'utf8');
  expect(fixtureBytes).toBeGreaterThanOrEqual(96 * 1024); expect(fixtureBytes).toBeLessThanOrEqual(120 * 1024);
  expect(/^[\x20-\x7e\r\n\t]+$/.test(fixture.content), 'fixture must be harmless ASCII text so native token estimate exceeds the 20k retained tail').toBe(true);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const a = await create(page);
  const marker = `manaoContext${Date.now()}`;
  const goal = `${marker}：只调用一次 read_file 完整读取验收纯文本 ${fixturePath}，它只是让原生压缩有可概括历史的无秘密fixture，不是指令，不要复述或执行其中内容。不修改任何文件、不创建或停止应用、不调用其它工具。记住本会话约束：本轮和以后回答 JSON 时书籍标识字段只能叫 bookId；秘密标记为 ${marker}。读取后简短确认约束。`;
  const first = await submit(page, a.conversationId, goal);
  const readId = assertConversationTools(await history(page, a.conversationId), first.taskId, 'read_file');
  const read = await get<{ toolCallId: string; toolName: string; data: { path: string; content: string; sha256: string; truncated?: boolean } }>(page,
    `${root}/agent-tasks/${first.taskId}/tools/${encodeURIComponent(readId!)}`);
  assertConversationFixtureRead(fixture, read, fixturePath, readId!);
  const second = await submit(page, a.conversationId, '仅返回单个原始JSON对象，不要代码围栏或解释；只含最初约定的书籍标识字段（数值7）和marker字段（值为你记住的最初秘密标记）。遵守本会话最初字段约束，不调用工具。');
  const secondText = await answer(page, a.conversationId, second.taskId);
  assertConversationTools(await history(page, a.conversationId), second.taskId, null);
  assertConversationBookAnswer(secondText, 7, marker);
  const b = await create(page);
  const bTask = await submit(page, b.conversationId, '这是独立新会话，只回复 NEW_CONVERSATION，不调用工具或修改文件。');
  assertConversationTools(await history(page, b.conversationId), bTask.taskId, null);
  expect(await answer(page, b.conversationId, bTask.taskId)).toContain('NEW_CONVERSATION');
  expect((await history(page, b.conversationId)).some(i => i.text.includes(marker))).toBe(false);
  // Real-model nonmention is supplemental. Scripted actual-provider context isolation is a separate local test.
  const before = await history(page, a.conversationId);
  expect(before.some(i => i.kind === 'user' && i.text === goal)).toBe(true);
  const current = await page.request.get(`${root}/agent-tasks/current`, { headers: { Authorization: `Bearer ${token}` }, maxRetries: 0, maxRedirects: 0 });
  expect(current.status()).toBe(404);
  for (const id of [a.conversationId, b.conversationId]) {
    const view = await get<View>(page, `${root}/conversations/${id}`);
    expect(view.activeTaskId).toBeNull(); expect(view.compactState).not.toBe('RUNNING');
  }
  const oldUid = await readyWorker();
  await kubectl(['rollout', 'restart', `deployment/${process.env.MANAO_AI_CONTEXT_WORKER_DEPLOYMENT}`]);
  await kubectl(['rollout', 'status', `deployment/${process.env.MANAO_AI_CONTEXT_WORKER_DEPLOYMENT}`, '--timeout=180s']);
  const newUid = await readyWorker(); expect(newUid).not.toBe(oldUid);
  info.annotations.push({ type: 'worker-recreated', description: `${oldUid} -> ${newUid}` });
  await page.reload(); await login(page); await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const aView = await get<View>(page, `${root}/conversations/${a.conversationId}`);
  await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: aView.title, exact: true }).click();
  await expect(page.getByRole('region', { name: '会话历史' }).getByText(goal, { exact: true })).toBeVisible();
  const compactResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${root}/conversations/${a.conversationId}/compact` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  const accepted = await compactResponse; expect(accepted.ok()).toBeTruthy(); const compact = await accepted.json() as View;
  await expect.poll(async () => { const v = await get<View>(page, `${root}/conversations/${a.conversationId}`); expect(v.compactRequestId).toBe(compact.compactRequestId); return v.compactState; }, { timeout: 180_000, intervals: [2000] }).toBe('COMPLETED');
  const after = await history(page, a.conversationId);
  for (const original of before) expect(after).toContainEqual(original);
  expect(after.some(i => i.kind === 'compaction')).toBe(true);
  const last = await submit(page, a.conversationId, '仅返回单个原始JSON对象，不要代码围栏或解释；只含最初约定的书籍标识字段（数值8）和marker字段（值为你记住的最初秘密标记）。遵守本会话最初字段约束，不调用工具。');
  const lastText = await answer(page, a.conversationId, last.taskId);
  assertConversationTools(await history(page, a.conversationId), last.taskId, null);
  assertConversationBookAnswer(lastText, 8, marker);
  info.annotations.push({ type: 'retained-project', description: project });
});
