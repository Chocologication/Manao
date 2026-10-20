import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { assembleOutputHistory, validateAiOutputEnvironment, type OutputHistoryItem } from './ai-output-contract';
import { assertConversationFixtureRead, assertConversationTools } from './ai-context-answer';
import { installOutputAudit, assertOutputAnswerTiming, outputAnswerSelector, type Audit } from './ai-output-observer';

const { projectId } = validateAiOutputEnvironment(process.env);
const root = '/api/v1/projects/' + projectId;
const occupying = new Set(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION']);
type Task = { taskId: string; conversationId: string; state: string; writesLocked: boolean; reasoningEffort: string; failureCode: string | null; changedPaths: string[] };
type View = { conversationId: string; title: string };
type Item = OutputHistoryItem & { toolCallId: string | null };
let token = '';
async function login(page: Page): Promise<void> {
  await page.getByLabel('Username').fill(process.env.MANAO_AI_ACCEPTANCE_USERNAME!);
  await page.getByLabel('Password').fill(process.env.MANAO_AI_ACCEPTANCE_PASSWORD!);
  const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await pending; expect(response.status()).toBe(200);
  token = (await response.json() as { accessToken: string }).accessToken;
  expect(token.length).toBeGreaterThan(0); await expect(page).toHaveURL(new RegExp('/projects/' + projectId + '$'));
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, { headers: { Authorization: 'Bearer ' + token }, maxRedirects: 0, maxRetries: 0 });
  expect(response.ok(), 'owner-scoped read must succeed').toBeTruthy(); return response.json() as Promise<T>;
}
async function history(page: Page, id: string): Promise<Item[]> {
  const items: Item[] = []; const seen = new Set<string>(); let cursor = '';
  for (let count = 0; count < 100; count++) {
    expect(seen.has(cursor), 'history cursor must advance').toBe(false); seen.add(cursor);
    const result = await get<{ items: Item[]; nextBeforeSeq: number | null; nextBeforeOffset: number | null }>(page, root + '/conversations/' + id + '/entries?limit=100' + cursor);
    items.push(...result.items); if (result.nextBeforeSeq === null) return items;
    cursor = '&beforeSeq=' + result.nextBeforeSeq + (result.nextBeforeOffset === null ? '' : '&beforeOffset=' + result.nextBeforeOffset);
  }
  throw new Error('History exceeds bounded acceptance budget');
}
async function observe(page: Page, interrupt: boolean): Promise<void> {
  await page.evaluate(installOutputAudit, { abortOnGeneratingThinking: interrupt });
}

test('real read-only high → off → low → max with incremental DOM and restored history', async ({ page, context }, testInfo) => {
  const marker = randomUUID().slice(0, 8); const tasks: Task[] = [];
  await page.goto('/projects/' + projectId); await login(page); await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const fixture = await get<{ path: string; content: string; workspaceRevision: string }>(page, root + '/files/content?path=README.md');
  expect(Buffer.byteLength(fixture.content, 'utf8'), 'operator must prepare an existing small secret-free README.md').toBeLessThanOrEqual(16 * 1024);
  const creating = page.waitForResponse(r => new URL(r.url()).pathname === root + '/conversations' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); const created = await creating;
  expect(created.ok()).toBeTruthy(); const conversation = await created.json() as View; let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === root + '/conversations/' + conversation.conversationId + '/tasks') posts++; });
  let liveResponses = 0;
  let reconnectTaskCheck: Promise<{ taskId: string; state: string; observedAtUtc: string }> | null = null;
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.ok() && path.startsWith(root + '/agent-tasks/') && path.endsWith('/live-output') && ++liveResponses === 2) {
      reconnectTaskCheck = get<Task>(page, path.slice(0, -'/live-output'.length)).then(value => ({ taskId: value.taskId, state: value.state, observedAtUtc: new Date().toISOString() }));
    }
  });
  for (const effort of ['high', 'off', 'low', 'max']) {
    liveResponses = 0; reconnectTaskCheck = null;
    await page.getByRole('button', { name: /推理强度/ }).click();
    const slider = page.getByRole('slider', { name: '推理强度' });
    const index = ['off', 'low', 'high', 'max'].indexOf(effort);
    await slider.focus(); await slider.press('Home');
    for (let step = 0; step < index; step++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue(String(index));
    await expect(slider).toHaveAttribute('aria-valuetext', ['关闭', '低', '高', '最高'][index]);
    await slider.press('Escape'); await observe(page, effort === 'high');
    const prompt = marker + ' ' + effort + ': Short read-only answer. ' + (effort === 'high' ? 'Call read_file exactly once with path README.md (the operator prepared this existing safe small file). No other tools.' : 'Use no tools.') + ' Never modify files, install dependencies, run shell/build/application, create or delete anything. Return under 250 words of Markdown with a heading, two bullets, a two-row table and a fenced code example; expose no secrets.';
    await page.locator('#agent-task-goal').fill(prompt);
    const accepting = page.waitForResponse(r => new URL(r.url()).pathname === root + '/conversations/' + conversation.conversationId + '/tasks' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start task', exact: true }).click(); const accepted = await accepting; expect(accepted.ok()).toBeTruthy();
    let task = await accepted.json() as Task; expect(task.reasoningEffort).toBe(effort); expect(task.conversationId).toBe(conversation.conversationId);
    const acceptedAtUtc = new Date().toISOString();
    await expect.poll(async () => { task = await get<Task>(page, root + '/agent-tasks/' + task.taskId); return occupying.has(task.state); }, { timeout: 420_000, intervals: [1000] }).toBe(false);
    const terminalObservedAtUtc = new Date().toISOString();
    expect(task.reasoningEffort).toBe(effort); expect(task.writesLocked).toBe(false); expect(task.changedPaths).toEqual([]);
    if (task.state === 'FAILED') { expect(task.failureCode).toBe('AI_LENGTH_LIMIT'); expect(effort).toBe('max'); } else expect(task.state).toBe('COMPLETED');
    const rows = await history(page, conversation.conversationId); const readId = assertConversationTools(rows, task.taskId, effort === 'high' ? 'read_file' : null);
    if (readId) {
      const read = await get<{ toolCallId: string; toolName: string; data: { path: string; content: string; sha256: string; truncated?: boolean } }>(page, root + '/agent-tasks/' + task.taskId + '/tools/' + encodeURIComponent(readId));
      assertConversationFixtureRead(fixture, read, 'README.md', readId);
    }
    const blocks = assembleOutputHistory(rows, task.taskId); expect(blocks.some(block => block.kind === 'assistant')).toBe(true);
    if (task.failureCode === 'AI_LENGTH_LIMIT') expect(blocks.some(block => block.modelTruncated)).toBe(true);
    const answerSeq = blocks.filter(block => block.kind === 'assistant').at(-1)!.seq;
    const nativeGroups = [...new Set(rows.filter(row => row.taskId === task.taskId && ['assistant', 'thinking', 'tool_call'].includes(row.kind)).map(row => row.seq))].sort((a, b) => a - b);
    const answerOrdinal = nativeGroups.indexOf(answerSeq) + 1;
    await expect.poll(() => page.evaluate(({ taskId, ordinal }) => (window as unknown as { outputAudit: Audit }).outputAudit.messages.some(message => message.taskId === taskId && message.messageOrdinal === ordinal && message.endedAt !== null), { taskId: task.taskId, ordinal: answerOrdinal }), { timeout: 15_000 }).toBe(true);
    const timing = await page.evaluate(() => (window as unknown as { outputAudit: Audit }).outputAudit);
    const reconnectTask = await (reconnectTaskCheck as Promise<{ taskId: string; state: string; observedAtUtc: string }> | null);
    await testInfo.attach('sanitized-' + effort + '-timing', { body: JSON.stringify({ effort, taskId: task.taskId, answerOrdinal, answerSeq, state: task.state, failureCode: task.failureCode, acceptedAtUtc, terminalObservedAtUtc, reconnectTask, ...timing }), contentType: 'application/json' });
    if (effort === 'high') {
      expect(timing.reconnect?.taskId, 'UNVERIFIED: no generating API/DOM thinking fetch abort').toBe(task.taskId);
      expect(timing.liveGets, 'UNVERIFIED: no second actual live GET before terminal reconciliation').toBeGreaterThanOrEqual(2);
      expect(timing.connections[1]?.taskId).toBe(task.taskId);
      expect(reconnectTask?.taskId).toBe(task.taskId);
      expect(reconnectTask?.state, 'UNVERIFIED: reconnect was not observed while task RUNNING').toBe('RUNNING');
    }
    assertOutputAnswerTiming(timing, task.taskId, answerOrdinal, effort !== 'off');
    const answer = page.locator(outputAnswerSelector(task.taskId, answerSeq));
    await expect(answer.locator('.ai-markdown h1, .ai-markdown h2').first()).toBeVisible(); await expect(answer.locator('.ai-markdown ul').first()).toBeVisible();
    await expect(answer.locator('.ai-markdown table').first()).toBeVisible(); await expect(answer.locator('.ai-markdown pre code').first()).toBeVisible(); tasks.push(task);
    if (effort === 'high') {
      const thinking = page.locator(outputAnswerSelector(task.taskId, blocks.find(block => block.kind === 'thinking')!.seq));
      const summary = thinking.locator('details summary').filter({ hasText: '思考过程' }).first();
      await summary.click(); await expect(summary.locator('..').locator('pre')).toBeVisible(); await summary.click(); await expect(summary.locator('..').locator('pre')).toBeHidden();
    }
    await context.setOffline(true); await page.waitForTimeout(500); await context.setOffline(false);
    expect(assembleOutputHistory(await history(page, conversation.conversationId), task.taskId)).toEqual(blocks);
    const current = await get<View>(page, root + '/conversations/' + conversation.conversationId);
    const markdownBeforeReload = await answer.locator('.ai-markdown').allTextContents();
    await page.reload(); await login(page); await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: current.title, exact: true }).click();
    expect(assembleOutputHistory(await history(page, conversation.conversationId), task.taskId)).toEqual(blocks);
    await expect.poll(() => answer.locator('.ai-markdown').allTextContents()).toEqual(markdownBeforeReload);
    await page.getByRole('button', { name: /推理强度/ }).click();
    const restoredSlider = page.getByRole('slider', { name: '推理强度' });
    await expect(restoredSlider).toHaveValue(String(index));
    await expect(restoredSlider).toHaveAttribute('aria-valuetext', ['关闭', '低', '高', '最高'][index]);
    await restoredSlider.press('Escape'); expect(posts, 'reconnect/reload must not resubmit').toBe(tasks.length);
    expect(task.state, task.failureCode === 'AI_LENGTH_LIMIT' ? 'FAILED/AI_LENGTH_LIMIT: max must remain a failed acceptance result' : 'task must complete').toBe('COMPLETED');
  }
  expect(tasks.map(task => task.reasoningEffort)).toEqual(['high', 'off', 'low', 'max']);
  await testInfo.attach('provider-wire-status', { body: JSON.stringify({ status: 'NOT_CAPTURED_BY_BROWSER', operatorWhitelist: ['thinking', 'reasoning_effort', 'stream', 'max_tokens'], evidence: 'controlled installed SDK local tests; real wire requires operator evidence' }), contentType: 'application/json' });
});
