import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { connect } from 'node:net';
const backend = 'http://127.0.0.1:18991', worker = 'http://127.0.0.1:18990';
const api = backend + '/api/v1/projects/terminal-project';
async function auth(request: APIRequestContext) { return { Authorization: `Bearer ${(await (await request.post(backend + '/__fixture/login')).json()).accessToken}` }; }
async function row(request: APIRequestContext, id: string) { return (await request.get(backend + '/__fixture/rows/' + id)).json(); }
async function stats(request: APIRequestContext) { return (await request.get(worker + '/__control/stats')).json(); }
async function mode(request: APIRequestContext, query: string) { await request.post(worker + '/__control/mode?' + query); }
async function tick(request: APIRequestContext, id: string) { await request.post(backend + '/__fixture/tick/' + id); }
async function restart(port: number) { await new Promise<void>((resolve, reject) => { const s = connect(port, '127.0.0.1'); s.once('connect', () => s.end()); s.once('close', resolve); s.once('error', reject); }); }
async function open(page: Page) { await page.goto('/tests/fixtures/ai-terminal-settlement/index.html'); await page.getByRole('button', { name: '重新登录' }).click(); }
async function begin(page: Page, request: APIRequestContext, query = 'wait=true') {
  await mode(request, query); await open(page); await page.getByRole('button', { name: '新建会话' }).click();
  await expect(page.getByRole('button', { name: 'Start task' })).toBeEnabled();
  await page.getByLabel('Task goal').fill('stage four local work');
  await page.getByRole('button', { name: 'Start task' }).click();
  const headers = await auth(request);
  let task: { taskId: string };
  await expect.poll(async () => { const r = await request.get(api + '/agent-tasks/current', { headers }); if (!r.ok()) return false; task = await r.json(); return true; }).toBe(true);
  await expect.poll(async () => (await row(request, task!.taskId)).calls).toBe(1);
  await expect.poll(async () => (await stats(request)).modelWaiting).toBe(true);
  return task!.taskId;
}
test.afterEach(async ({ request }) => {
  await mode(request, ''); await request.post(worker + '/__control/release');
  await request.post(backend + '/__fixture/reconcile?enabled=true');
  const headers = await auth(request), current = await request.get(api + '/agent-tasks/current', { headers });
  if (current.ok()) { const task = await current.json(); await request.post(api + `/agent-tasks/${task.taskId}/close`, { headers });
    const active = await (await request.get(api + '/runs/active', { headers })).json();
    if (active.run) await request.post(backend + '/__fixture/job-stopped/' + active.run.id);
    await tick(request, task.taskId); }
  await expect.poll(async () => (await request.get(api + '/agent-tasks/current', { headers })).status()).toBe(404);
  await expect.poll(async () => (await stats(request)).activeTaskId).toBeNull();
});
test('A pause, saved edit, same-conversation new task and browser re-entry', async ({ page, request }) => {
  const id = await begin(page, request); const before = await row(request, id);
  await request.post(backend + '/__fixture/reconcile?enabled=false');
  await page.getByRole('button', { name: 'Pause & take over' }).click();
  await expect(page.getByRole('button', { name: 'Continue task' })).toBeDisabled();
  expect((await row(request, id)).close_reason_code).toBe('AI_PAUSED_BY_OWNER');
  await request.post(backend + '/__fixture/reconcile?enabled=true');
  await expect(page.getByRole('button', { name: 'Continue task' })).toBeEnabled();
  await page.getByLabel('Saved fixture file').fill('user saved B ' + id);
  await page.getByRole('button', { name: 'Save fixture file' }).click();
  await expect(page.getByTestId('saved-revision')).not.toHaveText('7');
  const revision = await page.getByTestId('saved-revision').textContent();
  await mode(request, 'readCurrent=true');
  await page.getByRole('button', { name: 'Continue task' }).click();
  let next = '';
  await expect.poll(async () => { next = await page.getByTestId('task-id').textContent() ?? ''; return next && next !== id; }).toBe(true);
  await expect.poll(async () => (await row(request, next)).state).toBe('COMPLETED');
  const after = await row(request, next);
  expect(after.conversation_id).toBe(before.conversation_id); expect(after.workspace_revision).toBe(Number(revision));
  expect(new Date(after.deadline_at).getTime() - new Date(after.created_at).getTime()).toBeCloseTo(1800000, -1);
  expect(JSON.stringify(after.results)).toContain('user saved B ' + id);
  const starts = (await stats(request)).starts; await page.reload();
  await expect(page.getByTestId('task-id')).toHaveText(next); expect((await stats(request)).starts).toBe(starts);
});
test('B backend reconnect and worker replacement require manual continuation', async ({ page, request }) => {
  const id = await begin(page, request); const original = await row(request, id); const starts = (await stats(request)).starts;
  const originalPid = (await (await request.get(backend + '/__fixture/ready')).json()).pid;
  await restart(18993);
  await expect.poll(async () => { try { const r = await request.get(backend + '/__fixture/ready'); return r.ok() && (await r.json()).pid !== originalPid; } catch { return false; } }, { timeout: 45000 }).toBe(true);
  await tick(request, id); expect((await row(request, id)).state).toBe('RUNNING'); expect((await stats(request)).starts).toBe(starts);
  expect((await row(request, id)).deadline_at).toBe(original.deadline_at);
  await request.post(backend + '/__fixture/reconcile?enabled=false'); await mode(request, 'wait=true&unknown=true');
  await tick(request, id); expect((await row(request, id)).close_reason_code).toBeNull();
  await restart(18994);
  await expect.poll(async () => { try { return (await request.get(worker + '/__control/stats')).ok(); } catch { return false; } }, { timeout: 30000 }).toBe(true);
  await tick(request, id); await tick(request, id);
  await expect.poll(async () => (await row(request, id)).state).toBe('FAILED');
  expect((await row(request, id)).close_reason_code).toBe('AI_WORKER_RESTARTED');
  const restarted = (await stats(request)).starts;
  await expect(page.getByRole('button', { name: 'Continue task' })).toBeEnabled();
  expect((await stats(request)).starts).toBe(restarted);
  await mode(request, ''); await request.post(backend + '/__fixture/reconcile?enabled=true');
  await page.getByRole('button', { name: 'Continue task' }).click();
  await expect.poll(async () => (await stats(request)).starts).toBe(restarted + 1);
});
test('C linked mock Run must settle; completed and unrelated ready Runs survive', async ({ page, request }) => {
  const id = await begin(page, request);
  const linked = await (await request.post(backend + '/__fixture/ready-run/' + id)).json();
  await page.getByRole('button', { name: 'Pause & take over' }).click();
  await expect.poll(async () => (await row(request, id)).close_reason_code).toBe('AI_PAUSED_BY_OWNER');
  await tick(request, id); expect((await row(request, id)).state).toBe('NEEDS_ATTENTION');
  await expect(page.getByTestId('browser-write')).toBeDisabled();
  await request.post(backend + '/__fixture/job-stopped/' + linked.runId); await tick(request, id);
  await expect(page.getByRole('button', { name: 'Continue task' })).toBeEnabled();
  await mode(request, 'wait=true'); await page.getByRole('button', { name: 'Continue task' }).click();
  let next = ''; await expect.poll(async () => { next = await page.getByTestId('task-id').textContent() ?? ''; return next && next !== id; }).toBe(true);
  await expect.poll(async () => (await stats(request)).modelWaiting).toBe(true);
  const ready = await (await request.post(backend + '/__fixture/ready-run/' + next)).json();
  await request.post(worker + '/__control/finish-model');
  await expect.poll(async () => (await row(request, next)).state).toBe('COMPLETED');
  expect((await (await request.get(api + '/runs/' + ready.runId, { headers: await auth(request) })).json()).state).toBe('RUNNING');
  await request.post(api + '/runs/' + ready.runId + '/stop', {headers:await auth(request)});
  await request.post(backend + '/__fixture/job-stopped/' + ready.runId);
  await expect.poll(async () => (await (await request.get(api + '/runs/' + ready.runId, {headers:await auth(request)})).json()).state).toBe('CANCELLED');
  const other = await (await request.post(backend + '/__fixture/ready-run/' + next + '?linked=false')).json();
  await expect(page.getByTestId('browser-write')).toBeDisabled();
  expect((await (await request.get(api + '/runs/' + other.runId, { headers: await auth(request) })).json()).state).toBe('RUNNING');
  await request.post(api + '/runs/' + other.runId + '/stop', {headers:await auth(request)});
  await request.post(backend + '/__fixture/job-stopped/' + other.runId);
});
