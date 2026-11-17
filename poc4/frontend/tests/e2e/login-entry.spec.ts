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

test('cinematic intro completes, login retry succeeds and leaving releases the scene', async ({ page }, testInfo) => {
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
  await expect(page.getByRole('button', { name: '跳过动画' })).toBeVisible();
  await expect(page.locator('.entry__console')).toHaveAttribute('inert', '');
  const started = Date.now();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: testInfo.outputPath('intro-scene.png') });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: testInfo.outputPath('intro-brand.png') });
  await expect(page.getByRole('heading', { name: /云端开发实验室/, level: 1 })).toBeVisible();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  expect(Date.now() - started).toBeGreaterThan(3000);
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-version', 'compute-lab');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-renderer', 'canvas');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'flowing');

  const initialField = await sampleSignal(page);
  await page.waitForTimeout(240);
  expect(await sampleSignal(page)).not.toBe(initialField);
  await expect(page.locator('.entry__form')).toHaveCSS('opacity', '1');
  const entryCanvas = await page.locator('.entry__flow-canvas').elementHandle();
  const auroraCanvas = await page.locator('.entry__aurora-canvas').elementHandle();
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

  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  await page.getByLabel('Password').fill('demo-pass');
  await submit.click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect.poll(() => entryCanvas!.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return canvas.width * canvas.height;
  })).toBe(1);
  await expect.poll(() => auroraCanvas!.evaluate((node) => {
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

test('desktop sizes retain the composition with all login actions in view', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/login');
    await page.getByRole('button', { name: '跳过动画' }).click();
    await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const form = await page.locator('.entry__console').boundingBox();
    expect(form).not.toBeNull();
    expect(form!.y + form!.height).toBeLessThanOrEqual(viewport.height);
  }
});

test('reduced motion freezes the canvas and resumes when preference changes', async ({ page }, testInfo) => {
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await expect(scene).toHaveAttribute('data-background-state', 'still');
  const stillFrame = await sampleSignal(page);
  const stillScene = await scene.screenshot();
  await page.waitForTimeout(220);
  expect(await sampleSignal(page)).toBe(stillFrame);
  expect(await scene.screenshot()).toEqual(stillScene);
  await page.screenshot({ path: testInfo.outputPath('login-reduced-motion.png'), fullPage: true });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  const resumedFrame = await sampleSignal(page);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).not.toBe(resumedFrame);
});

test('initial reduced motion and saved preference immediately show a stable form', async ({ browser, baseURL }) => {
  for (const systemReduced of [true, false]) {
    const context = await browser.newContext({ reducedMotion: systemReduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    if (!systemReduced) await page.addInitScript(() => localStorage.setItem('manao.motion.v1', 'off'));
    await page.goto(`${baseURL}/login`);
    await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
    await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
    await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-reduced-motion', 'true');
    await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'still');
    await expect(page.locator('.entry__cursor')).toHaveCount(0);
    await context.close();
  }
});

test('hidden document pauses the canvas and the intro, then resumes', async ({ page }) => {
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-background-state', 'still');
  const pausedFrame = await sampleSignal(page);
  const identity = page.locator('.entry__identity');
  const pausedTransform = await identity.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).toBe(pausedFrame);
  expect(await identity.evaluate((element) => getComputedStyle(element).transform)).toBe(pausedTransform);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-background-state', 'flowing');
  const resumedFrame = await sampleSignal(page);
  await page.waitForTimeout(180);
  expect(await sampleSignal(page)).not.toBe(resumedFrame);
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
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
  expect(await page.locator('.entry__aurora-canvas').evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    return canvas.width * canvas.height;
  })).toBeLessThan(240_000);
  await page.getByRole('button', { name: '跳过动画' }).click();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
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
  await page.getByRole('button', { name: '跳过动画' }).click();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
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
  await expect(page.getByRole('button', { name: '跳过动画' })).toBeFocused();
  await page.keyboard.press('Enter');
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

test('pointer interaction moves the scene while the login form stays fixed', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  const form = await page.locator('.entry__console').boundingBox();
  const plane = page.locator('.entry__lab-plane');
  await page.mouse.move(150, 400);
  await page.waitForTimeout(850);
  const firstTransform = await plane.evaluate((element) => getComputedStyle(element).transform);
  await page.mouse.move(700, 600);
  await expect.poll(() => plane.evaluate((element) => getComputedStyle(element).transform)).not.toBe(firstTransform);
  await expect.poll(async () => Number(await page.locator('.entry__atmosphere').getAttribute('data-pointer-light'))).toBeGreaterThan(.9);
  expect(await page.locator('.entry__console').boundingBox()).toEqual(form);
  await page.getByLabel('Username').fill('alice');
  await expect(page.getByLabel('Username')).toHaveValue('alice');
});

test('lab light paths and floating modules continue after entry and respect motion preferences', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  const pulse = page.locator('.entry__lab-pulse').first();
  const card = page.locator('.entry__code-card');
  const form = await page.locator('.entry__console').boundingBox();
  const phase = await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset);
  const position = await card.evaluate(node => getComputedStyle(node).transform);
  await page.waitForTimeout(600);
  expect(await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset)).not.toBe(phase);
  expect(await card.evaluate(node => getComputedStyle(node).transform)).not.toBe(position);
  expect(await page.locator('.entry__console').boundingBox()).toEqual(form);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const paused = await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset);
  const pausedCard = await card.evaluate(node => getComputedStyle(node).transform);
  await page.waitForTimeout(200);
  expect(await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset)).toBe(paused);
  expect(await card.evaluate(node => getComputedStyle(node).transform)).toBe(pausedCard);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => pulse.evaluate(node => getComputedStyle(node).strokeDashoffset)).not.toBe(paused);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'still');
  const still = await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset);
  await page.waitForTimeout(200);
  expect(await pulse.evaluate(node => getComputedStyle(node).strokeDashoffset)).toBe(still);
});

test('after the camera settles, ambient motion keeps its rate and particle count', async ({ page }) => {
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await expect(scene).toHaveAttribute('data-background-camera', '1.0000');
  const count = await scene.getAttribute('data-particle-count');
  const first = await sampleSignal(page);
  const start = Number(await scene.getAttribute('data-background-time'));
  await page.waitForTimeout(3200);
  expect(Number(await scene.getAttribute('data-background-time')) - start).toBeGreaterThan(2.5);
  await expect(scene).toHaveAttribute('data-background-camera', '1.0000');
  await expect(scene).toHaveAttribute('data-particle-count', count!);
  expect(await sampleSignal(page)).not.toBe(first);
});

test('WebGL unavailable keeps an animated Canvas2D fallback and working login', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (args[0] === 'webgl') return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto('/login');
  const scene = page.locator('.entry__atmosphere');
  await expect(scene).toHaveAttribute('data-aurora-renderer', 'canvas');
  await page.getByRole('button', { name: '跳过动画' }).click();
  const first = await sampleSignal(page);
  await page.waitForTimeout(300);
  expect(await sampleSignal(page)).not.toBe(first);
  await expect(page.locator('.entry__aurora-canvas')).toBeHidden();
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('real WebGL context loss and restoration redraw both animated and reduced scenes', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  const scene = page.locator('.entry__atmosphere');
  const canvas = page.locator('.entry__aurora-canvas');
  // No simulated PASS on hosts without WebGL: the unsupported case has its own test.
  test.skip(await scene.getAttribute('data-aurora-renderer') !== 'webgl', 'WebGL is unavailable on this browser host');
  for (const reduced of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await expect(scene).toHaveAttribute('data-background-state', reduced ? 'still' : 'flowing');
    const beforeLoss = reduced ? await scene.screenshot() : null;
    const extension = await canvas.evaluateHandle(node => {
      const gl = (node as HTMLCanvasElement).getContext('webgl')!;
      return gl.getExtension('WEBGL_lose_context');
    });
    expect(await extension.evaluate(value => Boolean(value))).toBe(true);
    await extension.evaluate(value => value!.loseContext());
    await expect(scene).toHaveAttribute('data-aurora-renderer', 'canvas');
    await expect(canvas).toBeHidden();
    await expect(page.getByLabel('Username')).toBeEditable();
    // Extensions cannot be queried while a context is lost; retain the original handle.
    await extension.evaluate(value => value!.restoreContext());
    await expect(scene).toHaveAttribute('data-aurora-renderer', 'webgl');
    await expect(canvas).toBeVisible();
    await expect(scene).toHaveAttribute('data-background-state', reduced ? 'still' : 'flowing');
    if (beforeLoss) expect(await scene.screenshot()).toEqual(beforeLoss);
    await extension.dispose();
  }
});

test('slow frames trigger adaptive quality without changing camera or login availability', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 8 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => original(timestamp => {
      const start = performance.now();
      while (performance.now() - start < 38) { /* Simulate a busy main thread. */ }
      callback(timestamp);
    });
  });
  await page.goto('/login');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-quality', 'low');
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-camera', '1.0000');
  await page.getByLabel('Username').fill('alice');
  await expect(page.getByLabel('Username')).toHaveValue('alice');
});

test('account routes share the same scene, while full reload replays the intro', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  const canvas = await page.locator('.entry__flow-canvas').elementHandle();
  await page.getByRole('link', { name: /创建账号/ }).click();
  await expect(page.getByRole('heading', { name: '注册账号', exact: true })).toBeVisible();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeEditable();
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  expect(await canvas!.evaluate((element) => element === document.querySelector('.entry__flow-canvas'))).toBe(true);
  await page.getByRole('link', { name: '返回登录' }).click();
  await page.getByRole('link', { name: '忘记密码' }).click();
  await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeEditable();
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  expect(await canvas!.evaluate((element) => element === document.querySelector('.entry__flow-canvas'))).toBe(true);
  await page.getByRole('link', { name: '返回登录' }).click();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'ready');
  await page.reload();
  await expect(page.getByRole('button', { name: '跳过动画' })).toBeVisible();
  await expect(page.locator('.manao-entry')).toHaveAttribute('data-entry-phase', 'intro');
});

test('code previews cycle through all languages without duplicate visible cards', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  for (const language of ['Java', 'JavaScript', 'TypeScript', 'Python']) {
    await expect.poll(() => page.locator('.entry__code-example').evaluateAll((cards) =>
      cards.filter((card) => Number(getComputedStyle(card).opacity) > .99)
        .map((card) => card.querySelector('.entry__code-heading > span')?.textContent),
    ), { timeout: 6500 }).toEqual([language]);
  }
});

test('mock registration and password recovery return to the same login scene', async ({ page }, testInfo) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '跳过动画' }).click();
  await page.getByRole('link', { name: /创建账号/ }).click();
  const username = 'entry_' + Date.now();
  const email = username + '@example.test';
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill('Entry-pass-123');
  await page.getByLabel('确认密码', { exact: true }).fill('Entry-pass-123');
  await page.getByLabel('图形验证码', { exact: true }).fill('demo');
  await page.screenshot({ path: testInfo.outputPath('register-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '发送邮箱验证码', exact: true }).click();
  await page.getByLabel('邮箱验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('注册成功');
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  await page.getByRole('link', { name: '忘记密码' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('图形验证码', { exact: true }).fill('demo');
  await page.getByRole('button', { name: '发送找回验证码', exact: true }).click();
  await page.getByLabel('邮箱验证码', { exact: true }).fill('123456');
  await page.getByLabel('新密码', { exact: true }).fill('Entry-new-456');
  await page.getByLabel('确认新密码', { exact: true }).fill('Entry-new-456');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('密码已重置');
  await expect(page.getByRole('button', { name: '跳过动画' })).toHaveCount(0);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Entry-new-456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});
