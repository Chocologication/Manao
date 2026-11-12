import { test, expect, type Page } from '@playwright/test';
import type { Turn } from '../../src/features/ai/studio/types';

async function enter(page: Page) {
  await page.goto('/projects/prj-alice-notebook');
  await page.getByLabel('Username', { exact: true }).fill('alice'); await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  const login = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); const token = (await (await login).json() as { accessToken: string }).accessToken;
  await expect(page).toHaveURL(/\/projects\/prj-alice-notebook$/);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Manao AI 对话' })).toBeVisible();
  await expect(page.getByLabel('选择模型')).toHaveValue('c91f47f0-173b-4c54-b7a7-c93b6a4339cc');
  return token;
}
async function send(page: Page, text: string): Promise<Turn> {
  await page.getByLabel('消息输入', { exact: true }).fill(text);
  const response = page.waitForResponse(r => r.url().includes('/assistant/conversations/') && r.url().endsWith('/turns') && r.request().method() === 'POST');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const result = await response; expect(result.ok()).toBeTruthy(); return result.json() as Promise<Turn>;
}
for (const [status, expected] of [
  ['FAILED', '未通过'], ['UNKNOWN', '验证证据不完整'], ['SKIPPED', '全部测试跳过'], ['NO_TESTS', '未发现测试'],
] as const) {
  test(`Python ${status} never displays a passing validation when the process exits zero`, async ({ page }, info) => {
    await enter(page);
    // Substitute only the build evidence; exercise the actual workspace, task and renderer.
    await page.evaluate(verificationStatus => {
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof window.fetch>) => {
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (/\/agent-tasks\/[^/]+\/tools\/[^/]+-build$/.test(url.pathname)) {
          return Response.json({ toolCallId: url.pathname.split('/').at(-1), toolName: 'build', data: {
            goal: 'test', language: 'python', checkKind: 'pytest', verificationStatus,
            exitCode: 0, cleanupConfirmed: true, sourceRevision: '7', filesChecked: null, errors: [],
            testSummary: verificationStatus === 'UNKNOWN' ? null : {
              tests: verificationStatus === 'NO_TESTS' ? 0 : 3, failures: verificationStatus === 'FAILED' ? 1 : 0,
              errors: 0, skipped: verificationStatus === 'SKIPPED' ? 3 : 0, reportComplete: true,
            }, output: '[Controlled browser fixture] Python verification evidence',
          } });
        }
        return fetch(...args);
      };
    }, status);
    await page.getByRole('button', { name: '任务', exact: true }).click();
    const turn = await send(page, '检查 Python 验证结果');
    const article = page.locator(`[data-turn-id="${turn.id}"]`);
    const validation = article.locator('.studio-validation').filter({ hasText: '应用前验证' }).first();
    await expect(validation).toBeVisible();
    await expect(validation.locator('summary > span')).toHaveText(expected);
    await expect(validation).not.toHaveClass(/is-pass/);
    if (status === 'FAILED') {
      await validation.locator('summary').click();
      await expect(validation.getByText('测试：3 · 失败：1 · 错误：0 · 跳过：0')).toBeVisible();
      await page.screenshot({ path: info.outputPath('python-failed-validation.png'), fullPage: true });
    }
  });
}

test('chat streams incrementally, keeps draft through both layouts and renders markdown', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await enter(page);
  await page.getByLabel('消息输入').fill('切换布局时保留的草稿');
  await page.getByRole('button', { name: '切换到右侧面板' }).click();
  await expect(page.getByLabel('消息输入')).toHaveValue('切换布局时保留的草稿');
  await expect(page.getByRole('tabpanel', { name: '代码编辑器' })).toBeVisible();
  await expect(page.getByRole('separator', { name: '调整 AI 面板宽度' })).toBeVisible();
  await page.getByRole('separator', { name: '调整 AI 面板宽度' }).focus(); await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: '切换到主区域' }).click();
  await expect(page.getByLabel('消息输入')).toHaveValue('切换布局时保留的草稿');
  const turn = await send(page, '帮我了解项目结构'); const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await expect(article.getByText('正在处理', { exact: true })).toBeVisible();
  await expect(article.locator('.studio-markdown')).toContainText('我会结合当前项目');
  await expect(article.locator('.studio-assistant-meta').getByText('已完成', { exact: true })).toBeVisible();
  await expect(article.getByRole('heading', { name: '项目概览' })).toBeVisible();
  await expect(article.getByRole('button', { name: '复制代码' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('studio-main.png'), fullPage: true });
  await page.getByRole('button', { name: '切换到右侧面板' }).click();
  await expect(article).toBeVisible(); await page.screenshot({ path: info.outputPath('studio-side.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('review accepts and rejects separate hunks in one file and verifies accepted source', async ({ page }) => {
  const token = await enter(page); await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByLabel('变更应用方式')).toHaveValue('REVIEW');
  const turn = await send(page, '更新项目说明并运行测试'); const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await expect(article.getByRole('region', { name: '代码审阅' })).toBeVisible();
  const original = await page.evaluate(async token => (await (await fetch('/api/v1/projects/prj-alice-notebook/files/content?path=README.md', { headers: { Authorization: `Bearer ${token}` } })).json()) as { content: string }, token);
  expect(original.content).not.toContain('# Manao 项目说明');
  await expect(article.getByLabel('代码块 1 diff')).toBeHidden();
  await expect(article.getByRole('button', { name: '接受代码块 1', exact: true })).toHaveCount(0);
  await article.getByRole('button', { name: '查看 README.md 的修改', exact: true }).click();
  await expect(article.getByLabel('代码块 1 diff')).toBeVisible();
  await expect(article.getByRole('button', { name: '接受代码块 1', exact: true })).toHaveCount(0);
  await article.getByRole('button', { name: '按代码块审阅', exact: true }).click();
  // Diff lines must stack vertically; inline spans inside pre used to hide additions offscreen.
  const firstHunk = article.locator('.studio-hunk').first();
  const removed = await firstHunk.locator('.studio-diff-remove').boundingBox();
  const added = await firstHunk.locator('.studio-diff-add').boundingBox();
  expect(removed).not.toBeNull(); expect(added).not.toBeNull();
  expect(added!.y).toBeGreaterThanOrEqual(removed!.y + removed!.height - 1);
  expect(Math.abs(added!.x - removed!.x)).toBeLessThan(1);
  // Capture application selection at the HTTP boundary, including stable UUID/revision.
  await article.getByRole('button', { name: '接受代码块 1', exact: true }).click();
  await article.getByRole('button', { name: '拒绝代码块 2', exact: true }).click();
  const applied = page.waitForResponse(r => r.url().endsWith(`/turns/${turn.id}/apply`) && r.request().method() === 'POST');
  await expect(article.locator('.studio-file-name')).toContainText('部分接受');
  await article.getByRole('button', { name: '应用所选变更', exact: true }).click();
  const response = await applied; expect(response.ok()).toBeTruthy(); expect(response.request().postDataJSON().hunkIds).toHaveLength(1);
  await expect(article.getByText('变更已应用 · 验证通过')).toBeVisible();
  await expect(article.locator('.studio-validation').filter({ hasText: '应用后验证' })).toBeVisible();
  const actual = await page.evaluate(async token => (await (await fetch('/api/v1/projects/prj-alice-notebook/files/content?path=README.md', { headers: { Authorization: `Bearer ${token}` } })).json()) as { content: string }, token);
  expect(actual.content).toContain('# Manao 项目说明'); expect(actual.content).not.toContain('运行 mvn test 检查项目。');
});

test('file review applies all file changes while diff stays collapsed in the side panel', async ({ page }, info) => {
  const token = await enter(page);
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const turn = await send(page, '更新项目说明并运行测试');
  const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await expect(article.getByRole('region', { name: '代码审阅' })).toBeVisible();
  await expect(article.getByLabel('代码块 1 diff')).toBeHidden();
  await page.screenshot({ path: info.outputPath('studio-file-review.png'), fullPage: true });
  await page.getByRole('button', { name: '切换到右侧面板', exact: true }).click();
  await expect(article.getByRole('button', { name: '查看 README.md 的修改', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await article.getByRole('button', { name: '接受文件 README.md', exact: true }).click();
  await expect(article.getByRole('button', { name: '接受文件 README.md', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(article.locator('.studio-review-toolbar')).toContainText('已审阅 1/1 个文件');
  await page.screenshot({ path: info.outputPath('studio-file-review-side.png'), fullPage: true });
  const applied = page.waitForResponse(r => r.url().endsWith(`/turns/${turn.id}/apply`) && r.request().method() === 'POST');
  await article.getByRole('button', { name: '应用所选变更', exact: true }).click();
  const response = await applied;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().hunkIds).toHaveLength(2);
  await expect(article.getByText('变更已应用 · 验证通过')).toBeVisible();
  const actual = await page.evaluate(async token => (await (await fetch('/api/v1/projects/prj-alice-notebook/files/content?path=README.md', { headers: { Authorization: `Bearer ${token}` } })).json()) as { content: string }, token);
  expect(actual.content).toContain('# Manao 项目说明');
  expect(actual.content).toContain('运行 mvn test 检查项目。');
});

test('rejecting a file overrides earlier block choices and leaves its source unchanged', async ({ page }) => {
  const token = await enter(page);
  const source = () => page.evaluate(async token => (await (await fetch('/api/v1/projects/prj-alice-notebook/files/content?path=README.md', { headers: { Authorization: `Bearer ${token}` } })).json()) as { content: string }, token);
  const original = await source();
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const turn = await send(page, '更新项目说明并运行测试');
  const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await expect(article.getByRole('region', { name: '代码审阅' })).toBeVisible();
  await article.getByRole('button', { name: '查看 README.md 的修改', exact: true }).click();
  await article.getByRole('button', { name: '按代码块审阅', exact: true }).click();
  await article.getByRole('button', { name: '接受代码块 1', exact: true }).click();
  await expect(article.locator('.studio-file-name')).toContainText('部分接受');
  await article.getByRole('button', { name: '拒绝文件 README.md', exact: true }).click();
  await expect(article.getByRole('button', { name: '接受代码块 1', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const applied = page.waitForResponse(r => r.url().endsWith(`/turns/${turn.id}/apply`) && r.request().method() === 'POST');
  await article.getByRole('button', { name: '确认全部拒绝', exact: true }).click();
  const response = await applied;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().hunkIds).toEqual([]);
  await expect(article.getByText('已拒绝全部修改，项目文件未改动。')).toBeVisible();
  expect((await source()).content).toBe(original.content);
});
test('stop retains partial content and does not resume after switching layouts', async ({ page }) => {
  await enter(page); const turn = await send(page, '[slow] 详细解释当前项目');
  const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await expect(article.locator('.studio-markdown')).toContainText('我会');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(article.getByText('已停止', { exact: true })).toBeVisible();
  const content = await article.locator('.studio-markdown').innerText();
  await page.getByRole('button', { name: '切换到右侧面板' }).click();
  await expect(article.locator('.studio-markdown')).toHaveText(content);
});
test('model settings keep keys out of responses and attachment chips reach the turn', async ({ page }) => {
  await enter(page); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置' });
  await dialog.getByRole('button', { name: '添加模型', exact: true }).click();
  await dialog.getByLabel('显示名称', { exact: true }).fill('本地测试模型'); await dialog.getByLabel('API 密钥', { exact: true }).fill('test-only-not-a-real-key');
  const saved = page.waitForResponse(r => r.url().endsWith('/assistant/models') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '保存配置' }).click(); expect(await (await saved).text()).not.toContain('test-only-not-a-real-key');
  await expect(dialog).not.toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'debug.log', mimeType: 'text/plain', buffer: Buffer.from('sample log line') });
  await expect(page.getByRole('button', { name: '移除附件 debug.log' })).toBeVisible();
  await page.getByRole('button', { name: '添加代码引用' }).click(); await page.getByLabel('引用内容').fill('const x = 1;'); await page.getByRole('button', { name: '添加引用', exact: true }).click();
  const turn = await send(page, '结合附件和代码分析'); expect(turn.attachmentIds).toHaveLength(1); expect(turn.references).toHaveLength(1);
  expect(turn.references[0]?.text).toBe('const x = 1;');
});

test('automatic application writes the project and continues chat in the same conversation', async ({ page }) => {
  const token = await enter(page);
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await page.getByLabel('变更应用方式').selectOption('AUTO');
  const task = await send(page, '自动更新项目说明并运行验证');
  const taskArticle = page.locator(`[data-turn-id="${task.id}"]`);
  await expect(taskArticle.getByRole('region', { name: '代码变更' })).toBeVisible();
  await expect(taskArticle.locator('.studio-assistant-meta').getByText('已完成', { exact: true })).toBeVisible();
  const actual = await page.evaluate(async token => (await (await fetch('/api/v1/projects/prj-alice-notebook/files/content?path=README.md', { headers: { Authorization: `Bearer ${token}` } })).json()) as { content: string }, token);
  expect(actual.content).toContain('# Manao 项目说明');
  expect(actual.content).toContain('运行 mvn test 检查项目。');
  await page.getByRole('button', { name: '聊天', exact: true }).click();
  const chat = await send(page, '解释刚才的改动');
  expect(chat.id).not.toBe(task.id);
  expect(chat.conversationId).toBe(task.conversationId);
  await expect(page.locator(`[data-turn-id="${chat.id}"]`).getByRole('heading', { name: '项目概览' })).toBeVisible();
  await expect(page.locator('.studio-turn')).toHaveCount(2);
});
