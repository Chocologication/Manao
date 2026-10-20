import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const screenshots = resolve('..', 'docs/evidence/ai-ui/screenshots');
async function openAI(page: Page, theme = 'lab') {
  await page.addInitScript(t => localStorage.setItem('manao.appearance.v1', t), theme);
  await page.goto('/login');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('article', { name: 'Alice Notebook' }).getByRole('link', { name: 'Open', exact: true }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: '书籍接口与阅读排版', exact: true })).toBeVisible();
  await expect(page.locator('[data-message-seq]')).toHaveCount(18);
  await expect(page.getByLabel('Task goal')).toBeEnabled();
}
async function capture(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, name), fullPage: true });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroll = page.locator('.manao-ai-scroll');
  expect(await scroll.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeInViewport();
}

for (const theme of ['lab', 'graphite', 'light']) test(`reading layout ${theme} 1440x900`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAI(page, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuetext', /2,633/);
  await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeEnabled();
  await page.getByText('思考过程', { exact: true }).click();
  await page.getByRole('button', { name: '查看工具结果', exact: true }).first().click();
  await expect(page.getByText('# Fixed UI fixture', { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.locator('[data-message-seq="13"]').scrollIntoViewIfNeeded();
  await capture(page, `${theme}-1440x900.png`);
  const localScroll = await page.locator('.ai-markdown pre, .ai-markdown-table').evaluateAll(es => es.map(e => ({ width: e.clientWidth, scroll: e.scrollWidth })));
  expect(localScroll.some(e => e.scroll > e.width)).toBe(true);
});

test('native effort keyboard ticks drag focus and retained UI state', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openAI(page);
  const goal = page.getByLabel('Task goal');
  await goal.fill('保留这段未发送输入');
  let trigger = page.getByRole('button', { name: /推理强度 ·/ });
  await trigger.click();
  const slider = page.getByRole('slider', { name: '推理强度', exact: true });
  await slider.focus();
  for (const [key, value, label] of [['Home', '0', '关闭'], ['ArrowRight', '1', '低'], ['ArrowRight', '2', '高'], ['End', '3', '最高']] as const) {
    await slider.press(key); await expect(slider).toHaveValue(value); await expect(slider).toHaveAttribute('aria-valuetext', label);
    const capsule = await page.locator('.manao-ai-effort-capsule').boundingBox();
    const popup = await page.locator('.manao-ai-effort-popup').boundingBox();
    expect(capsule!.x).toBeGreaterThanOrEqual(popup!.x);
    expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(popup!.x + popup!.width);
  }
  await page.getByRole('button', { name: '低', exact: true }).click();
  await expect(slider).toHaveValue('1');
  const box = await slider.boundingBox();
  await page.mouse.move(box!.x + 32, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width - 32, box!.y + box!.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(slider).toHaveValue('3');
  await slider.press('Escape'); await expect(slider).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByRole('heading', { name: 'Alice Notebook', exact: true }).click(); await expect(slider).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByRole('tab', { name: 'File', exact: true }).click();
  await expect(slider).toBeHidden(); await expect(page.getByRole('navigation', { name: '会话列表' })).toBeHidden();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(goal).toHaveValue('保留这段未发送输入');
  await page.getByRole('button', { name: '切换对话历史', exact: true }).click();
  await page.getByRole('button', { name: '切换对话历史', exact: true }).click();
  await expect(goal).toHaveValue('保留这段未发送输入');
  await expect(page.getByRole('heading', { name: '书籍接口与阅读排版', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '书籍接口与阅读排版', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const scroll = page.locator('.manao-ai-scroll');
  await scroll.evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
  await page.getByText('思考过程', { exact: true }).evaluate(e => (e as HTMLElement).click());
  expect(await scroll.evaluate(e => e.scrollTop)).toBe(0);
  const ancestors = await page.getByRole('region', { name: '会话历史', exact: true }).evaluate(e => {
    let count = 0; let p = e.parentElement;
    while (p && p.getAttribute('role') !== 'tabpanel') { if (['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) count++; p = p.parentElement; }
    return count;
  });
  expect(ancestors).toBe(1);
  await noOverflow(page); await capture(page, 'lab-1024x768.png');
});

test('history pagination empty create and original Run navigation', async ({ page }) => {
  await openAI(page);
  const taskPosts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/tasks$|\/agent-tasks$/.test(new URL(r.url()).pathname)) taskPosts.push(r.url()); });
  await page.getByRole('button', { name: '更多会话', exact: true }).click();
  await page.getByRole('button', { name: '下一轮项目讨论', exact: true }).click();
  await expect(page.locator('[data-message-seq]')).toHaveCount(0);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建空会话', exact: true })).toBeVisible();
  expect(taskPosts).toEqual([]);
  await page.getByRole('button', { name: '书籍接口与阅读排版', exact: true }).click();
  await page.getByRole('button', { name: '查看工具结果', exact: true }).last().click();
  await page.getByRole('button', { name: 'View run', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '切换项目洞察', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeHidden();
  await expect(page.getByRole('tabpanel', { name: 'Run', exact: true }).getByText('run-000001', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '运行洞察', exact: true })).toBeVisible();
});

for (const width of [1023, 390]) test(`history drawer and composer ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
  await openAI(page);
  const toggle = page.getByRole('button', { name: '切换对话历史', exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  await toggle.click();
  const drawer = page.getByRole('dialog', { name: '对话历史', exact: true });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 6; i++) { await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab'); expect(await drawer.evaluate(e => e.contains(document.activeElement))).toBe(true); }
  await capture(page, `lab-${width}-history.png`);
  await page.keyboard.press('Escape'); await expect(drawer).toBeHidden(); await expect(toggle).toBeFocused();
  const goal = page.getByLabel('Task goal'); await goal.fill('窄屏输入保持可见');
  await goal.evaluate(e => { e.style.height = '220px'; });
  await noOverflow(page);
  await page.getByRole('button', { name: /推理强度 ·/ }).click();
  await expect(page.getByRole('slider', { name: '推理强度', exact: true })).toBeInViewport();
  await capture(page, `lab-${width}-slider-input.png`);
});
