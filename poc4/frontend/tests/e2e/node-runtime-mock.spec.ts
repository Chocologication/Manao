import { test, expect } from '@playwright/test';
import { openCloudProjectCreation } from '../support/cloudWorkbench';

for (const language of ['javascript', 'typescript']) for (const kind of ['console', 'web']) {
  const templateId = `node-${language}-${kind}`;
  test(`${templateId}: create, inspect files, run snapshot and stop (mock)`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill('alice');
    await page.getByLabel('Password', { exact: true }).fill('demo-pass');
    const login = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const token = (await (await login).json() as { accessToken: string }).accessToken;
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('.lab-summary-note')).toContainText('Node.js');
    await openCloudProjectCreation(page);
    await page.getByLabel('Project name', { exact: true }).fill(templateId);
    await page.getByLabel('Template', { exact: true }).selectOption(templateId);
    if (kind === 'web') {
      await page.getByLabel('Public access', { exact: true }).check();
      await expect(page.getByLabel('Container port 1')).toHaveValue('3000');
      await page.getByLabel('Public port 1').fill('29999');
      await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
      await page.getByLabel('Public port 1').fill('30091');
    } else await expect(page.getByLabel('MySQL', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('node-templates.png'), fullPage: true });
    const creation = page.waitForResponse(response => response.url().endsWith('/api/v1/projects') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const project = await (await creation).json() as { id: string; runtime: { templateId: string } };
    expect(project.runtime.templateId).toBe(templateId);
    const card = page.getByRole('article', { name: templateId, exact: true });
    await card.getByRole('link', { name: '进入工作台', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
    await expect(page.locator('.lab-workbench-status')).toContainText('Node.js 24');
    const files = await page.evaluate(async ({ token, project }) => {
      const headers = { Authorization: `Bearer ${token}` };
      const paths = ['package.json', 'pnpm-lock.yaml', project.templateId.includes('typescript') ? 'src/main.ts' : 'src/main.js'];
      return Promise.all(paths.map(async path => {
        const response = await fetch(`/api/v1/projects/${project.id}/files/content?path=${encodeURIComponent(path)}`, { headers });
        return { status: response.status, body: await response.json() as { content: string } };
      }));
    }, { token, project: { id: project.id, templateId } });
    expect(files.every(file => file.status === 200)).toBe(true);
    expect(files[0].body.content).toContain('pnpm@10.33.0');
    await page.evaluate(async token => {
      const response = await fetch('/api/v1/session/run-scenario', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'disconnect' }) });
      if (response.status !== 204) throw new Error('Cannot set mock lifecycle');
    }, token);
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await expect(page.getByText('pnpm start', { exact: true })).toBeVisible();
    const start = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/runs`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '启动运行', exact: true }).click();
    const run = await (await start).json() as { policy: { runtime: { language: string }; command: string; templateId: string } };
    expect(run.policy.runtime.language).toBe(language); expect(run.policy.templateId).toBe(templateId);
    expect(run.policy.command).toBe('pnpm start');
    await expect(page.getByLabel('运行状态', { exact: true })).toContainText('正在执行');
    await expect(page.getByRole('toolbar', { name: '运行控制', exact: true }).getByText(/Node\.js 24/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('node-running.png'), fullPage: true });
    await page.getByRole('button', { name: '停止运行', exact: true }).click();
    await page.getByRole('dialog', { name: '停止运行', exact: true }).getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByLabel('运行状态', { exact: true })).toContainText('已停止');
    if (language === 'typescript' && kind === 'web') {
      await page.getByRole('tab', { name: 'AI', exact: true }).click();
      await expect(page.getByLabel('选择模型')).toHaveValue('c91f47f0-173b-4c54-b7a7-c93b6a4339cc');
      await page.getByLabel('消息输入', { exact: true }).fill('说明这个 Node.js 项目如何构建');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.locator('.studio-markdown')).toContainText('pnpm run build');
      await expect(page.locator('.studio-assistant-meta').getByText('已完成', { exact: true })).toBeVisible();
      await expect(page.locator('.studio-markdown')).not.toContainText('Maven');
    }
    expect(errors).toEqual([]);
  });
}
