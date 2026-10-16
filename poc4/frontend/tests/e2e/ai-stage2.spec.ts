import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { buildToolCallId } from '../../src/contracts/agentTask';
import { collectToolResults, verifyMissingToolResults } from '../../scripts/ai-stage2-tool-results.ts';

// Real deployment/model only. Node's operator subprocess receives DB/kubectl
// environment; those credentials are never injected into the page or attachments.
const PROJECT = process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID;
const R0 = process.env.MANAO_AI_ACCEPTANCE_R0_ID;
const INITIAL = process.env.MANAO_AI_ACCEPTANCE_INITIAL_REVISION;
const USERNAME = process.env.MANAO_AI_ACCEPTANCE_USERNAME;
const PASSWORD = process.env.MANAO_AI_ACCEPTANCE_PASSWORD;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!UUID.test(PROJECT ?? '') || !UUID.test(R0 ?? '') || !/^(0|[1-9][0-9]*)$/.test(INITIAL ?? '') || !USERNAME || !PASSWORD) {
  throw new Error('Stage 2 requires bootstrap PROJECT_ID, R0_ID, INITIAL_REVISION and owner credentials.');
}
const ROOT = `/api/v1/projects/${PROJECT}`;
const DEMO = 'src/main/java/com/example/app/DemoController.java';
const FIXTURE = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';
const FIXTURE_BYTES = readFileSync(new URL('../fixtures/ai-stage2/DemoControllerAcceptanceTest.java', import.meta.url));
const FIXTURE_SHA = createHash('sha256').update(FIXTURE_BYTES).digest('hex');
const RECORDED_FIXTURE_SHA = 'a7663e44983b9487ffe196ea5601b6aabe5d0e6f32a6488946ec2cea3296bf2c';
const PROMPT = '先停止当前应用并确认退出。在不改源码的情况下执行现有测试并创建一次新 Run，实际 GET /api/demo?name=Pi，记录第一次 HTTP 结果及对应应用日志。然后修复这个接口，使同一请求返回 HTTP 200 和 JSON message="Hello Pi"；保留 guest 行为。固定验收测试 src/test/java/com/example/app/DemoControllerAcceptanceTest.java 必须逐字保留，不得修改、删除或追加任何内容；如需补充测试，可以另建其他测试文件。需要改代码或构建时先停应用并确认退出，测试通过后创建新 Run 再实际验证。完成后保持最终应用运行，报告修改路径、测试、Run 和 HTTP 结果。';
const OCCUPYING = new Set(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
type Run = { id: string; state: string; firstReadyAt: string | null; finishedAt: string | null; requestedWorkspaceRevision: string };
type Task = { taskId: string; state: string; workspaceRevision: string; changedPaths: string[];
  writesLocked: boolean; progress: Array<{ kind: string; text: string }> };
let token = '', mainTaskId = '', finalRunId = '';

async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  return page.request.fetch(path, { method, data, headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0, maxRetries: 0 });
}
async function json<T>(page: Page, path: string): Promise<T> {
  const response = await api(page, path);
  expect(response.ok(), 'owner-scoped API must succeed').toBeTruthy();
  return response.json() as Promise<T>;
}
async function login(page: Page) {
  await page.goto(`/projects/${PROJECT}`);
  await page.getByLabel('Username').fill(USERNAME!);
  await page.getByLabel('Password').fill(PASSWORD!);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  token = ((await (await response).json()) as { accessToken: string }).accessToken;
  expect(typeof token).toBe('string');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`));
}
async function reveal(page: Page, path: string) {
  await page.getByRole('tab', { name: 'File', exact: true }).click();
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const item = page.getByRole('treeitem', { name: parts[depth - 1], exact: true });
    await expect(item).toBeVisible();
    if (await item.getAttribute('aria-expanded') !== 'true') await item.click();
  }
  await page.getByRole('treeitem', { name: parts.at(-1), exact: true }).click();
}
async function submit(page: Page, prompt: string): Promise<Task> {
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.locator('#agent-task-goal').fill(prompt);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === `${ROOT}/agent-tasks` && r.request().method() === 'POST');
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  const accepted = await response;
  expect(accepted.ok()).toBeTruthy();
  const task = await accepted.json() as Task;
  expect(UUID.test(task.taskId)).toBeTruthy();
  return task;
}
async function settled(page: Page, taskId: string, timeout: number): Promise<Task> {
  let result: Task | undefined;
  await expect.poll(async () => {
    result = await json<Task>(page, `${ROOT}/agent-tasks/${taskId}`);
    return OCCUPYING.has(result.state);
  }, { timeout, intervals: [2000] }).toBe(false);
  return result!;
}
async function fixtureUnchanged(page: Page) {
  const fixture = await json<{ content: string }>(page, `${ROOT}/files/content?path=${encodeURIComponent(FIXTURE)}`);
  expect(fixture.content).toBe(FIXTURE_BYTES.toString('utf8'));
  expect(createHash('sha256').update(fixture.content).digest('hex')).toBe(RECORDED_FIXTURE_SHA);
}
async function tools(page: Page, task: Task) {
  const ids = task.progress.filter((entry) => entry.kind === 'tool_end')
    .map((entry) => buildToolCallId(entry.text))
    .filter((id): id is string => id !== null);
  return collectToolResults(ids, (id) => api(page, `${ROOT}/agent-tasks/${task.taskId}/tools/${encodeURIComponent(id)}`));
}
async function operatorVerdict(taskId: string): Promise<Record<string, unknown>> {
  const script = fileURLToPath(new URL('../../scripts/ai-stage2-verify-ledger.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--task-id', taskId], { shell: false, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Operator verifier timed out')); }, 300_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Operator verifier unavailable')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const verdict = JSON.parse(output) as Record<string, unknown>;
        if (code !== 0 || verdict.verdict !== 'PASS') reject(new Error(`Operator evidence rejected: ${JSON.stringify(verdict.failures ?? [])}`));
        else resolve(verdict);
      } catch { reject(new Error('Operator verifier did not return a passing sanitized verdict')); }
    });
  });
}

test.describe.serial('Stage 2 real application feedback acceptance', () => {
  test('R0 → real R1 HTTP500/logs → receipted repair/test → new R2 HTTP200', async ({ page }, info) => {
    test.setTimeout(2_700_000);
    expect(FIXTURE_SHA).toBe(RECORDED_FIXTURE_SHA);
    await login(page);
    const initial = await json<{ run: Run | null }>(page, `${ROOT}/runs/active`);
    expect(initial.run?.id).toBe(R0);
    expect(initial.run?.state).toBe('RUNNING');
    expect(initial.run?.firstReadyAt).not.toBeNull();
    expect(initial.run?.requestedWorkspaceRevision).toBe(INITIAL);
    await fixtureUnchanged(page);
    await reveal(page, DEMO); // Seed the actual editor/revision cache before the Agent writes.
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('stage2-seeded-handler-failure');
    const accepted = await submit(page, PROMPT);
    mainTaskId = accepted.taskId;
    await info.attach('task-identity', { body: JSON.stringify({ projectId: PROJECT, taskId: mainTaskId, r0Id: R0, initialRevision: INITIAL, testFixtureSha256: FIXTURE_SHA }), contentType: 'application/json' });
    expect(OCCUPYING.has(accepted.state)).toBeTruthy();
    const denied = await api(page, `${ROOT}/runs`, 'POST', { expectedWorkspaceRevision: INITIAL });
    expect(denied.status()).toBe(409);
    expect((await denied.json() as { code: string }).code).toBe('AI_TASK_ACTIVE');
    await page.reload();
    await login(page);
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    expect((await json<Task>(page, `${ROOT}/agent-tasks/${mainTaskId}`)).taskId).toBe(mainTaskId);
    const final = await settled(page, mainTaskId, 2_400_000);
    expect(final.state).toBe('COMPLETED');
    expect(final.changedPaths).toContain(DEMO);
    await fixtureUnchanged(page);
    const active = await json<{ run: Run | null }>(page, `${ROOT}/runs/active`);
    expect(active.run?.state).toBe('RUNNING');
    expect(active.run?.firstReadyAt).not.toBeNull();
    expect(active.run?.id).not.toBe(R0);
    expect(active.run?.requestedWorkspaceRevision).toBe(final.workspaceRevision);
    finalRunId = active.run!.id;
    const { results, missingIds } = await tools(page, final);
    await info.attach('tool-details-unavailable', { body: JSON.stringify({ taskId: mainTaskId, missingIds, count: missingIds.length }), contentType: 'application/json' });
    expect(results.some((entry) => entry.toolName === 'app_http_get' && entry.data.statusCode === 500)).toBeTruthy();
    expect(results.some((entry) => entry.toolName === 'app_http_get' && entry.data.statusCode === 200 && entry.data.runId === finalRunId)).toBeTruthy();
    // Actual result UI, including safe text rendering and the existing Run navigation.
    await page.getByRole('button', { name: 'View HTTP result', exact: true }).last().click();
    const agent = page.getByRole('region', { name: 'AI task', exact: true });
    await expect(agent).toContainText('Status: 200');
    await expect(agent).toContainText('Hello Pi');
    await agent.getByRole('button', { name: 'View run', exact: true }).last().click();
    await expect(page.getByRole('region', { name: 'Run', exact: true })).toContainText('Accessible');
    // The operator process independently reads ledger/route and issues the public GET
    // while R2 is still active. A missing operator environment fails, never skips.
    const verdict = await operatorVerdict(mainTaskId);
    verifyMissingToolResults(missingIds, verdict.toolCallIds);
    await info.attach('independent-operator-verdict', { body: JSON.stringify(verdict, null, 2), contentType: 'application/json' });
    const source = await json<{ content: string; workspaceRevision: string }>(page, `${ROOT}/files/content?path=${encodeURIComponent(DEMO)}`);
    expect(source.workspaceRevision).toBe(final.workspaceRevision);
    await reveal(page, 'src/main/java/com/example/app/App.java');
    await reveal(page, DEMO);
    await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('stage2-seeded-handler-failure');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello');
    // A real attempted buffer edit must remain blocked while the final Run lives.
    const lockedEditor = page.locator('.monaco-editor textarea').first();
    await lockedEditor.focus();
    await lockedEditor.press('Control+End');
    await lockedEditor.press('Enter');
    await lockedEditor.type('//stage2-readonly-check');
    await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('stage2-readonly-check');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const writeDenied = await api(page, `${ROOT}/files/content?path=${encodeURIComponent(DEMO)}`, 'PUT', { content: source.content, expectedWorkspaceRevision: source.workspaceRevision });
    expect(writeDenied.status()).toBe(409);
    expect((await writeDenied.json() as { code: string }).code).toBe('PROJECT_LOCKED');
    // Normal owner stop, then prove the editor really permits a harmless buffer edit.
    await page.getByRole('tab', { name: 'Run', exact: true }).click();
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await page.getByRole('dialog', { name: 'Stop run', exact: true }).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => {
      const run = await json<Run>(page, `${ROOT}/runs/${finalRunId}`);
      return TERMINAL.has(run.state) && run.finishedAt !== null;
    }, { timeout: 180_000, intervals: [2000] }).toBe(true);
    await expect.poll(async () => (await json<{ run: Run | null }>(page, `${ROOT}/runs/active`)).run, { timeout: 60_000 }).toBeNull();
    await reveal(page, DEMO);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const editor = page.locator('.monaco-editor textarea').first();
    await editor.focus();
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.press('Slash');
    await editor.press('Slash');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    // Reload discards only this unsaved characterization; no source mutation is sent.
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await login(page);
    await fixtureUnchanged(page);
    await info.attach('success-lifecycle', { body: JSON.stringify({ taskId: mainTaskId, r2Id: finalRunId, finalRunStopped: true, editorEditable: true, projectCleanup: 'RETAINED' }), contentType: 'application/json' });
  });

  test('owner close stops only the new task Run and releases occupancy', async ({ page }, info) => {
    test.setTimeout(600_000);
    await login(page);
    expect((await json<{ run: Run | null }>(page, `${ROOT}/runs/active`)).run).toBeNull();
    const oldRun = await json<Run>(page, `${ROOT}/runs/${finalRunId}`);
    const task = await submit(page, '不修改任何文件。启动当前应用，确认 ready 后持续读取该 Run 日志和状态，不要自行停止应用；我会点击 End task 结束这项收尾验收。');
    let taskRun: Run | null = null;
    await expect.poll(async () => {
      const current = await json<Task>(page, `${ROOT}/agent-tasks/${task.taskId}`);
      expect(OCCUPYING.has(current.state), 'close scene must reach a live task Run before completion').toBeTruthy();
      taskRun = (await json<{ run: Run | null }>(page, `${ROOT}/runs/active`)).run;
      return taskRun?.state === 'RUNNING' && taskRun.firstReadyAt !== null;
    }, { timeout: 420_000, intervals: [2000] }).toBe(true);
    const startedId = taskRun!.id;
    expect(startedId).not.toBe(finalRunId);
    const live = await json<Task>(page, `${ROOT}/agent-tasks/${task.taskId}`);
    const liveTools = await tools(page, live);
    await info.attach('close-live-tool-details-unavailable', { body: JSON.stringify({ taskId: task.taskId, missingIds: liveTools.missingIds, count: liveTools.missingIds.length, ledgerReview: 'OPERATOR_REQUIRED' }), contentType: 'application/json' });
    const starts = liveTools.results.filter((entry) => entry.toolName === 'application' && entry.data.action === 'start');
    expect(starts.some((entry) => (entry.data.run as { id?: string } | null)?.id === startedId)).toBeTruthy();
    await page.getByRole('button', { name: 'End task', exact: true }).click();
    const final = await settled(page, task.taskId, 180_000);
    expect(final.state).toBe('FAILED');
    expect(final.writesLocked).toBe(false);
    const stopped = await json<Run>(page, `${ROOT}/runs/${startedId}`);
    expect(TERMINAL.has(stopped.state)).toBeTruthy();
    expect(stopped.finishedAt).not.toBeNull();
    expect((await json<{ run: Run | null }>(page, `${ROOT}/runs/active`)).run).toBeNull();
    // Include completed start calls as well as the last active Run in cleanup proof.
    const finalTools = await tools(page, final);
    await info.attach('close-final-tool-details-unavailable', { body: JSON.stringify({ taskId: task.taskId, missingIds: finalTools.missingIds, count: finalTools.missingIds.length, ledgerReview: 'OPERATOR_REQUIRED' }), contentType: 'application/json' });
    const completedStarts = finalTools.results.filter((entry) => entry.toolName === 'application' && entry.data.action === 'start');
    const createdIds = completedStarts.map((entry) => (entry.data.run as { id: string }).id);
    expect(createdIds).toContain(startedId);
    for (const runId of createdIds) {
      const run = await json<Run>(page, `${ROOT}/runs/${runId}`);
      expect(TERMINAL.has(run.state)).toBeTruthy();
      expect(run.finishedAt).not.toBeNull();
    }
    expect(await json<Run>(page, `${ROOT}/runs/${finalRunId}`)).toEqual(oldRun);
    await fixtureUnchanged(page);
    await info.attach('close-lifecycle', { body: JSON.stringify({ taskId: task.taskId, stoppedRunIds: createdIds, untouchedHistoricalRunId: finalRunId, projectCleanup: 'RETAINED', resourceInventory: 'OPERATOR_REQUIRED' }), contentType: 'application/json' });
  });
});
