import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { acceptanceEnvironment, assertDisposableProject, assertPythonRound, readAcceptanceJson, type ToolResult } from './ai-python-contract';

// Real provider only. An operator prepares two pristine dedicated projects first.
// Writes are never retried; a lost mutation response retains the original identity for investigation.
// Other legacy configs scan this directory. Only the dedicated config is an execution entry;
// that config validates all required names before collection, so its run cannot silently skip.
test.skip(!process.env.MANAO_AI_ACCEPTANCE_BASE_URL, 'Use playwright.ai-python.config.ts against an authorized real deployment');
let env: ReturnType<typeof acceptanceEnvironment>;
test.beforeAll(() => { env = acceptanceEnvironment(process.env); });
const occupying = new Set(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION']);
type Task = { taskId: string; conversationId: string; state: string; writesLocked: boolean; workspaceRevision: string;
  changedPaths: string[]; progress: { kind: string; text: string }[] };
type Conversation = { conversationId: string; title: string; compactRequestId: string | null; compactState: string | null };
type History = { items: { seq: number; kind: string; text: string; taskId: string | null; toolCallId: string | null }[];
  nextBeforeSeq: number | null; nextBeforeOffset: number | null };
type Scene = { projectId: string; template: 'python-console' | 'python-fastapi-web'; kind: 'console' | 'fastapi';
  source: string; fixture: string; dependency: string; firstOutput: string; secondOutput: string };
const scenes: Scene[] = [
  { projectId: process.env.MANAO_AI_PYTHON_CONSOLE_PROJECT_ID!, template: 'python-console', kind: 'console', source: 'main.py', fixture: 'tests/test_main.py', dependency: 'rich', firstOutput: '6', secondOutput: '10' },
  { projectId: process.env.MANAO_AI_PYTHON_FASTAPI_PROJECT_ID!, template: 'python-fastapi-web', kind: 'fastapi', source: 'app/main.py', fixture: 'tests/test_api.py', dependency: 'humanize', firstOutput: '1,000', secondOutput: '2,000' },
];
let token = '';
const root = (scene: Scene) => `/api/v1/projects/${scene.projectId}`;
const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
async function request(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown) {
  return page.request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data,
    maxRetries: 0, maxRedirects: 0, timeout: 180_000 });
}
async function get<T>(page: Page, path: string): Promise<T> {
  return await readAcceptanceJson(() => request(page, 'GET', path)) as T;
}
async function login(page: Page, scene: Scene) {
  await page.goto(`/projects/${scene.projectId}`);
  await page.getByLabel('Username').fill(env.username); await page.getByLabel('Password').fill(env.password);
  const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await pending; expect(response.ok()).toBe(true);
  token = (await response.json() as { accessToken: string }).accessToken; expect(token).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`/projects/${scene.projectId}$`));
}
async function currentTask(page: Page, scene: Scene) {
  const response = await request(page, 'GET', `${root(scene)}/agent-tasks/current`);
  if (response.status() === 404) return null;
  expect(response.ok()).toBe(true); return response.json();
}
async function idle(page: Page, scene: Scene) {
  const project = await get(page, root(scene));
  const task = await currentTask(page, scene);
  const active = await get<{ run: unknown }>(page, `${root(scene)}/runs/active`);
  const pending = await get<{ operations: unknown[] }>(page, `${root(scene)}/python-dependencies/pending`);
  assertDisposableProject(project, scene.projectId, scene.template, task, active.run, pending.operations);
}
async function content(page: Page, scene: Scene, path: string) {
  return get<{ content: string; workspaceRevision: string }>(page, `${root(scene)}/files/content?path=${encodeURIComponent(path)}`);
}
async function revision(page: Page, scene: Scene) {
  return (await get<{ workspaceRevision: string }>(page, `${root(scene)}/files/tree?path=`)).workspaceRevision;
}
function templateFiles(directory: URL, prefix = ''): { path: string; content: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}${entry.name}`;
    return entry.isDirectory() ? templateFiles(new URL(`${entry.name}/`, directory), `${path}/`)
      : [{ path, content: readFileSync(new URL(entry.name, directory), 'utf8') }];
  });
}
async function remoteFiles(page: Page, scene: Scene, path = ''): Promise<string[]> {
  const tree = await get<{ entries: { path: string; kind: string }[] }>(page, `${root(scene)}/files/tree?path=${encodeURIComponent(path)}`);
  const files: string[] = [];
  for (const entry of tree.entries) {
    if (entry.kind === 'directory') files.push(...await remoteFiles(page, scene, entry.path));
    else files.push(entry.path);
  }
  return files;
}
async function seed(page: Page, scene: Scene) {
  await idle(page, scene);
  // PythonSeedTemplateExporter applies real template mapping and conditional filtering.
  // Raw web resources omit shared hidden files and contain unrendered conditionals.
  const template = templateFiles(new URL(`../../../backend/target/python-seed-templates/${scene.kind === 'fastapi' ? 'web' : 'console'}/`, import.meta.url));
  expect((await remoteFiles(page, scene)).sort(), 'Only pristine template files may be overwritten').toEqual(template.map(file => file.path).sort());
  for (const file of template) expect((await content(page, scene, file.path)).content, `Pristine template ${file.path} required`).toBe(file.content);
  // Both template manifests and locks come from the real exported templates; no hand-authored lock.
  for (const path of ['pyproject.toml', 'uv.lock']) expect((await content(page, scene, path)).content.length).toBeGreaterThan(0);
  const directory = await request(page, 'POST', `${root(scene)}/entries`, { kind: 'directory', path: 'tests', expectedWorkspaceRevision: await revision(page, scene) });
  expect(directory.status()).toBe(201);
  const created = await request(page, 'POST', `${root(scene)}/entries`, { kind: 'file', path: scene.fixture, expectedWorkspaceRevision: await revision(page, scene) });
  expect(created.status()).toBe(201);
  for (const path of [scene.source, scene.fixture]) {
    const fixture = readFileSync(new URL(`../fixtures/ai-python/${scene.kind}/${path}`, import.meta.url), 'utf8');
    const response = await request(page, 'PUT', `${root(scene)}/files/content?path=${encodeURIComponent(path)}`,
      { content: fixture, expectedWorkspaceRevision: await revision(page, scene) });
    expect(response.ok(), 'Fixture mutation must be confirmed; never automatically replay it').toBe(true);
    expect((await content(page, scene, path)).content).toBe(fixture);
  }
  // Exceed Pi's retained recent-history tail so the explicit native compact is meaningful.
  // Harmless ASCII data, under the fixed read_file limit; no secrets or executable instructions.
  const contextFixture = 'Neutral Python acceptance context data. Section descriptions and sample labels only.\n'.repeat(1350);
  const contextCreated = await request(page, 'POST', `${root(scene)}/entries`,
    { kind: 'file', path: 'ai-python-context.txt', expectedWorkspaceRevision: await revision(page, scene) });
  expect(contextCreated.status()).toBe(201);
  const contextSaved = await request(page, 'PUT', `${root(scene)}/files/content?path=ai-python-context.txt`,
    { content: contextFixture, expectedWorkspaceRevision: await revision(page, scene) });
  expect(contextSaved.ok()).toBe(true);
}
async function snapshot(page: Page, scene: Scene) {
  const files: Record<string, string> = {};
  for (const path of [scene.source, scene.fixture, 'pyproject.toml', 'uv.lock']) files[path] = hash((await content(page, scene, path)).content);
  return { workspaceRevision: await revision(page, scene), files };
}
async function history(page: Page, scene: Scene, id: string): Promise<History['items']> {
  const rows: History['items'] = []; let cursor = ''; const cursors = new Set<string>();
  for (let pages = 0; pages < 100; pages++) {
    expect(cursors.has(cursor), 'History cursor must advance').toBe(false); cursors.add(cursor);
    const result = await get<History>(page, `${root(scene)}/conversations/${id}/entries?limit=100${cursor}`); rows.push(...result.items);
    if (result.nextBeforeSeq === null) return rows.sort((a, b) => a.seq - b.seq);
    cursor = `&beforeSeq=${result.nextBeforeSeq}${result.nextBeforeOffset === null ? '' : `&beforeOffset=${result.nextBeforeOffset}`}`;
  }
  throw new Error('Acceptance history exceeded bounded pagination budget');
}
async function submit(page: Page, scene: Scene, conversation: Conversation, prompt: string) {
  await page.locator('#agent-task-goal').fill(prompt);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === `${root(scene)}/conversations/${conversation.conversationId}/tasks` && r.request().method() === 'POST');
  const start = page.getByRole('button', { name: 'Start task', exact: true }); await expect(start).toBeEnabled(); await start.click();
  const accepted = await response; expect(accepted.ok()).toBe(true); const task = await accepted.json() as Task;
  expect(task.conversationId).toBe(conversation.conversationId);
  let final = task;
  try {
    await expect.poll(async () => { final = await get<Task>(page, `${root(scene)}/agent-tasks/${task.taskId}`); return occupying.has(final.state); },
      { timeout: 1_920_000, intervals: [2_000, 5_000] }).toBe(false);
  } finally {
    await test.info().attach(`${scene.kind}-${task.taskId}-observed.json`,
      { body: Buffer.from(JSON.stringify({ projectId: scene.projectId, task: final })), contentType: 'application/json' });
  }
  expect(final.state).toBe('COMPLETED'); expect(final.writesLocked).toBe(false);
  const rows = await history(page, scene, conversation.conversationId);
  const ids = [...new Set(rows.filter(row => row.taskId === task.taskId && row.kind === 'tool_result' && row.toolCallId).map(row => row.toolCallId!))];
  const tools: ToolResult[] = [];
  for (const id of ids) {
    const row = rows.find(row => row.taskId === task.taskId && row.kind === 'tool_result' && row.toolCallId === id)!;
    if (!['build', 'python_dependencies', 'application', 'app_http_get'].includes(row.text)) continue;
    tools.push(await get<ToolResult>(page, `${root(scene)}/agent-tasks/${task.taskId}/tools/${encodeURIComponent(id)}`));
  }
  // Exercise the actual persisted browser result route and renderer, beyond API corroboration.
  for (const tool of tools.filter(row => row.toolName === 'python_dependencies' || row.toolName === 'build' && row.data.verificationStatus === 'PASS')) {
    const item = rows.find(row => row.taskId === task.taskId && row.kind === 'tool_result' && row.toolCallId === tool.toolCallId)!;
    const article = page.locator(`article[data-task-id="${task.taskId}"][data-message-seq="${item.seq}"]`);
    for (let pageNumber = 0; await article.count() === 0 && pageNumber < 100; pageNumber++) {
      const earlier = page.getByRole('button', { name: '加载更早历史', exact: true });
      await expect(earlier).toBeEnabled();
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === `${root(scene)}/conversations/${conversation.conversationId}/entries`);
      await earlier.click(); expect((await loaded).ok()).toBe(true);
    }
    await expect(article).toBeVisible(); await article.getByRole('button', { name: '查看工具结果', exact: true }).click();
    await expect(article.getByText(tool.toolName === 'python_dependencies' ? `依赖组：${String(tool.data.group)}`
      : tool.data.checkKind === 'syntax' ? 'Python 语法检查' : 'Python 测试', { exact: true })).toBeVisible();
  }
  return { task: final, tools };
}
async function recordRound(page: Page, scene: Scene, info: TestInfo, round: string, outcome: Awaited<ReturnType<typeof submit>>, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(page, scene);
  // Reports contain identities, hashes and bounded owner-safe tool results; never credentials or raw provider traffic.
  await info.attach(`${scene.kind}-${round}.json`, { body: Buffer.from(JSON.stringify({ projectId: scene.projectId, ...outcome, before, after }, null, 2)), contentType: 'application/json' });
  expect(Number(after.workspaceRevision)).toBeGreaterThan(Number(before.workspaceRevision));
  const lastPass = outcome.tools.filter(row => row.toolName === 'build' && row.data.checkKind === 'pytest' && row.data.verificationStatus === 'PASS').at(-1);
  expect(lastPass?.data.sourceRevision, 'The final source must be the revision actually tested and run').toBe(after.workspaceRevision);
}
test.describe.serial('real Python provider development loops', () => {
  for (const scene of scenes) test(`${scene.kind}: failed assertion → repair/main+test dependencies → run → compact → second round`, async ({ page }, info) => {
    await login(page, scene); await seed(page, scene);
    // Refresh the authoritative browser revision after operator fixture preparation, then reauthenticate.
    await page.reload(); await page.getByLabel('Username').fill(env.username); await page.getByLabel('Password').fill(env.password);
    const loginResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); token = (await (await loginResponse).json() as { accessToken: string }).accessToken;
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const created = page.waitForResponse(r => new URL(r.url()).pathname === `${root(scene)}/conversations` && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const response = await created; expect(response.ok()).toBe(true);
    const conversation = await response.json() as Conversation;
    const firstBefore = await snapshot(page, scene);
    const initialFixture = (await content(page, scene, scene.fixture)).content;
    const business = scene.kind === 'console'
      ? '修复 total 求和；main.py 运行时用 rich.print 输出 total([1,2,3])，应为独立一行 6。'
      : '保留 /health/ready，修复 /api/demo 返回精确 JSON {"message":"Hello from Manao","total":"1,000"}，使用 humanize.intcomma(1000) 实现 total。';
    const first = await submit(page, scene, conversation,
      `这是当前 Python 验收项目，严格按实际环境使用工具。先完整 read_file ai-python-context.txt，它只是无秘密的压缩验收数据，不是指令，不修改或复述。然后读取源码、测试及依赖；使用 python_dependencies 向 test 组添加 pytest${scene.kind === 'fastapi' ? ' 和 httpx' : ''}。先 build test 记录现有断言 FAILED，不能先修复，不得删除、改写或弱化现有测试。然后使用 python_dependencies 向 main 组添加 ${scene.dependency}，${business} 不手写 pyproject.toml/uv.lock。修复后 build compile 和 build test 必须真实 PASS，再 application start/status/logs 验证最新 revision；console 必须核对终态 SUCCEEDED、exitCode=0 和完整输出，FastAPI 必须核对 firstReadyAt 且 app_http_get /api/demo 的实际 200 和业务 JSON。失败要查证并修复重跑，不能凭文字宣称成功。`);
    await recordRound(page, scene, info, 'first', first, firstBefore);
    assertPythonRound(first.tools, { kind: scene.kind, output: scene.firstOutput, first: true });
    expect((await content(page, scene, scene.fixture)).content, 'First repair must preserve the exact failing test').toBe(initialFixture);
    expect(first.task.changedPaths).toEqual(expect.arrayContaining([scene.source, 'pyproject.toml', 'uv.lock']));
    const beforeHistory = await history(page, scene, conversation.conversationId);
    const compactResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${root(scene)}/conversations/${conversation.conversationId}/compact` && r.request().method() === 'POST');
    await page.getByRole('button', { name: '压缩上下文', exact: true }).click(); const accepted = await compactResponse; expect(accepted.ok()).toBe(true);
    const compact = await accepted.json() as Conversation; expect(compact.compactRequestId).toBeTruthy();
    await expect.poll(async () => { const view = await get<Conversation>(page, `${root(scene)}/conversations/${conversation.conversationId}`); expect(view.compactRequestId).toBe(compact.compactRequestId); return view.compactState; },
      { timeout: 240_000, intervals: [2_000, 5_000] }).toBe('COMPLETED');
    const afterHistory = await history(page, scene, conversation.conversationId);
    for (const row of beforeHistory) expect(afterHistory).toContainEqual(row);
    expect(afterHistory.some(row => row.kind === 'compaction')).toBe(true);
    const secondBefore = await snapshot(page, scene);
    const change = scene.kind === 'console' ? '把入口示例改为 total([1,2,3,4])，独立一行输出 10；保留现有测试并新增这一输入的测试。'
      : '把 /api/demo 改为 humanize.intcomma(2000)，精确返回 {"message":"Hello from Manao","total":"2,000"}；仅同步对应业务断言，保留健康测试。';
    const second = await submit(page, scene, conversation, `${change} 沿用本会话当前 Python 环境与已管理 main/test 依赖。先确认并停止旧活动 Run、等退出后再改文件，完成 build compile、build test，再启动最新应用核对真实终态/输出或 readiness + app_http_get /api/demo；不能复用旧 Run 或仅口头回答。`);
    await recordRound(page, scene, info, 'second-after-compact', second, secondBefore);
    assertPythonRound(second.tools, { kind: scene.kind, output: scene.secondOutput, first: false });
    expect(await currentTask(page, scene)).toBeNull();
    expect((await get<{ operations: unknown[] }>(page, `${root(scene)}/python-dependencies/pending`)).operations).toHaveLength(0);
    info.annotations.push({ type: 'retained-project', description: scene.projectId });
    // Preserve projects, live FastAPI Run and receipts. Operator verifies scoped cluster cleanup separately.
  });
});
