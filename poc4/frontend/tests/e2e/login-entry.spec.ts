import { expect, test, type Page } from '@playwright/test';

async function sampleSignal(page: Page) {
  return page.locator('.entry__flow-canvas').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 64) hash = Math.imul(hash ^ pixels[i] ^ pixels[i + 3], 16777619);
    return hash >>> 0;
  });
}

test('desktop execution atlas renders without pointer effects and keeps login usable', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const unauthorizedResponses: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 401) unauthorizedResponses.push(response.url());
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '云端代码实验室' })).toBeVisible();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-motion-ready', 'true');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-version', 'execution-atlas');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-renderer', 'canvas');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'flowing');
  await expect(page.locator('.entry__cursor')).toHaveCount(0);
  await expect(page.locator('.entry__cursor-dot')).toHaveCount(0);

  const initialField = await sampleSignal(page);
  await page.waitForTimeout(240);
  expect(await sampleSignal(page)).not.toBe(initialField);
  await expect(page.locator('.entry__form')).toHaveCSS('opacity', '1');
  const entryCanvas = await page.locator('.entry__flow-canvas').elementHandle();
  const globalClass = await page.locator('html').getAttribute('class');
  await expect(page.getByLabel('Username')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });

  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: '显示密码' }).click();
  await expect(page.getByLabel('Password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码' }).click();
  await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');

  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.hover();
  await expect(submit).toHaveCSS('background-color', 'rgb(25, 71, 183)');
  await expect(submit).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -1)');
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Password')).toHaveAttribute('aria-describedby', 'login-error');

  await page.getByLabel('Password').fill('demo-pass');
  await submit.click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect.poll(() => entryCanvas!.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return canvas.width * canvas.height;
  })).toBe(1);
  await expect(page.locator('.entry__atmosphere')).toHaveCount(0);
  expect(await page.locator('html').getAttribute('class')).toBe(globalClass);
  expect(await page.locator('html').evaluate((node) => getComputedStyle(node).getPropertyValue('--entry-paper'))).toBe('');
  expect(unauthorizedResponses).toHaveLength(1);
  expect(unauthorizedResponses[0]).toContain('/auth/login');
  expect(consoleErrors).toEqual([]);
});

test('desktop sizes retain the atlas composition without overflow', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const form = await page.locator('.entry__form').boundingBox();
    expect(form).not.toBeNull();
    expect(form!.y + form!.height).toBeLessThanOrEqual(viewport.height);
  }
});

test('reduced motion freezes the canvas and resumes when preference changes', async ({ page }, testInfo) => {
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.manao-entry')).not.toHaveAttribute('data-motion-ready', 'true');
  await expect(scene).toHaveAttribute('data-background-state', 'still');
  const stillFrame = await sampleSignal(page);
  await page.waitForTimeout(220);
  expect(await sampleSignal(page)).toBe(stillFrame);
  await page.screenshot({ path: testInfo.outputPath('login-reduced-motion.png'), fullPage: true });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-motion-ready', 'true');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  const resumedFrame = await sampleSignal(page);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).not.toBe(resumedFrame);
});

test('initial reduced motion and saved preference keep the atlas still', async ({ browser }) => {
  for (const systemReduced of [true, false]) {
    const context = await browser.newContext({ reducedMotion: systemReduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    if (!systemReduced) await page.addInitScript(() => localStorage.setItem('manao.motion.v1', 'off'));
    await page.goto('http://127.0.0.1:4184/login');
    await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-reduced-motion', 'true');
    await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'still');
    await expect(page.locator('.entry__cursor')).toHaveCount(0);
    await context.close();
  }
});

test('hidden document pauses the atlas and visibility resumes it', async ({ page }) => {
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-background-state', 'still');
  const pausedFrame = await sampleSignal(page);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).toBe(pausedFrame);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  const resumedFrame = await sampleSignal(page);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).not.toBe(resumedFrame);
});

test('low-power desktop caps canvas resolution and remains interactive', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 2 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 });
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await expect(scene).toHaveAttribute('data-background-quality', 'low');
  const pixels = await page.locator('.entry__flow-canvas').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return canvas.width * canvas.height;
  });
  expect(pixels).toBeLessThan(950_000);
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
});

test('unsupported canvas uses the static fallback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (args[0] === '2d') return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto('/login');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-renderer', 'static');
  await expect(page.locator('.entry__flow-fallback')).toBeVisible();
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect(errors).toEqual([]);
});

test('context loss switches to fallback and restoration resumes rendering', async ({ page }) => {
  await page.goto('/login');
  const canvas = page.locator('.entry__flow-canvas');
  const scene = page.locator('.entry__atmosphere');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  await canvas.evaluate((element) => element.dispatchEvent(new Event('contextlost', { cancelable: true })));
  await expect(scene).toHaveAttribute('data-background-renderer', 'static');
  await expect(scene).toHaveAttribute('data-background-state', 'still');
  await canvas.evaluate((element) => element.dispatchEvent(new Event('contextrestored')));
  await expect(scene).toHaveAttribute('data-background-renderer', 'canvas');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
});

test('keyboard focus and login preserve the page contract', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`${request.url()} ${request.failure()?.errorText}`);
  });
  await page.goto('/login');
  await expect(page.getByRole('link', { name: '码瑙首页' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '码瑙首页' })).toBeFocused();
  await expect(page.getByRole('link', { name: '码瑙首页' })).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Username')).toBeFocused();
  await page.keyboard.type('alice');
  await page.keyboard.press('Tab');
  await page.keyboard.type('demo-pass');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '显示密码' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await expect(page).toHaveURL(/\/projects$/);
  expect(failures).toEqual([]);
});
