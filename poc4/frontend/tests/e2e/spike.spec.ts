import { expect, test, type Locator, type Page } from '@playwright/test';

const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

function workbenchTabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Workbench panels' }).getByRole('tab');
}

function editorTab(page: Page, name: RegExp): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name });
}

function connectButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Connect terminal', exact: true });
}

function disconnectButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Disconnect terminal', exact: true });
}

async function typeInMonaco(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Editor content' });
  await expect(input).toBeAttached();
  await editor.click();
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+End');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const visible = await page.locator('.view-lines').innerText();
    if (visible.includes(text)) {
      return;
    }
    await page.keyboard.type(text, { delay: 50 });
  }

  await expect(page.locator('.view-lines')).toContainText(text);
}

async function typeInXterm(page: Page, text: string): Promise<void> {
  const textarea = page.getByRole('textbox', { name: 'Terminal input' });
  await expect(textarea).toBeAttached();
  await textarea.focus();
  await page.keyboard.type(text);
}

function framePayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'payload' in payload) {
    const inner = (payload as { payload: unknown }).payload;
    if (typeof inner === 'string') return inner;
    if (inner instanceof Uint8Array) return new TextDecoder().decode(inner);
  }
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  return String(payload);
}

function trackTerminalSockets(page: Page) {
  const sockets: Array<{ closed: boolean; sent: string[] }> = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/terminal')) return;
    const record = { closed: false, sent: [] as string[] };
    sockets.push(record);
    ws.on('framesent', (payload) => {
      record.sent.push(framePayloadText(payload));
    });
    ws.on('close', () => {
      record.closed = true;
    });
  });
  return sockets;
}

function openSockets(sockets: Array<{ closed: boolean }>) {
  return sockets.filter((socket) => !socket.closed);
}

function isBrowserChrome404(pathname: string): boolean {
  return (
    pathname === '/favicon.ico' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/apple-touch-icon-precomposed.png'
  );
}

function sentResizeFrames(sockets: Array<{ sent: string[] }>) {
  const frames: Array<{ cols: number; rows: number }> = [];
  for (const socket of sockets) {
    for (const payload of socket.sent) {
      try {
        const parsed = JSON.parse(payload) as { type?: unknown; cols?: unknown; rows?: unknown };
        if (
          parsed.type === 'terminal.resize' &&
          typeof parsed.cols === 'number' &&
          typeof parsed.rows === 'number'
        ) {
          frames.push({ cols: parsed.cols, rows: parsed.rows });
        }
      } catch {
        // Binary terminal input is not JSON.
      }
    }
  }
  return frames;
}

test('spike workbench workflow', async ({ page }) => {
  const consoleErrors: string[] = [];
  const notFoundPaths: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 404) {
      notFoundPaths.push(new URL(response.url()).pathname);
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('Failed to load resource') && text.includes('404')) return;
    consoleErrors.push(text);
  });
  const sockets = trackTerminalSockets(page);

  await page.goto('/stage0.html');
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor')).toBeVisible();

  await expect(workbenchTabs(page)).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'File' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Run' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Agent|Git|VSC|Worktree/i })).toHaveCount(0);

  await expect(page.locator('.view-lines')).toContainText('artifactId');

  const dirtyMarker = 'SPIKEDIRTY';
  await typeInMonaco(page, dirtyMarker);
  await expect(page.locator('.view-lines')).toContainText(dirtyMarker);
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await editorTab(page, /App\.java/).click();
  await expect(page.locator('.view-lines')).toContainText('Hello, POC4');

  await editorTab(page, /pom\.xml/).click();
  await expect(page.locator('.view-lines')).toContainText(dirtyMarker);
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await connectButton(page).click();
  await expect(page.getByRole('status')).toHaveText('connected');
  await expect(page.getByTestId('terminal-last-output')).toContainText('POC4 browser terminal ready');

  await typeInXterm(page, 'K');
  await expect(page.getByTestId('terminal-last-output')).toHaveText('K');

  await disconnectButton(page).click();
  await expect(page.getByRole('status')).toHaveText('disconnected');
  await expect.poll(() => openSockets(sockets)).toHaveLength(0);

  await connectButton(page).click();
  await expect(page.getByRole('status')).toHaveText('connected');
  await expect(page.getByTestId('terminal-last-output')).toContainText('POC4 browser terminal ready');
  await expect.poll(() => openSockets(sockets)).toHaveLength(1);

  const echoOnce = 'Q';
  await typeInXterm(page, echoOnce);
  await expect(page.getByTestId('terminal-last-output')).toHaveText(echoOnce);

  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText(dirtyMarker);
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  const scrollOverflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      root: root.scrollWidth > root.clientWidth,
      body: body.scrollWidth > body.clientWidth,
    };
  });
  expect(scrollOverflow.root).toBe(false);
  expect(scrollOverflow.body).toBe(false);

  const asideBox = await page.locator('aside').boundingBox();
  const mainBox = await page.locator('main').boundingBox();
  expect(asideBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  if (asideBox && mainBox) {
    expect(asideBox.x + asideBox.width).toBeLessThanOrEqual(mainBox.x + 1);
  }

  expect(notFoundPaths.filter((pathname) => !isBrowserChrome404(pathname))).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('keeps dirty editor buffer when switching workbench panels', async ({ page }) => {
  await page.goto('/stage0.html');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText('artifactId');

  const dirtyMarker = 'SPIKEDIRTY';
  await typeInMonaco(page, dirtyMarker);
  await expect(page.locator('.view-lines')).toContainText(dirtyMarker);
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-spike-panel')).toBeVisible();

  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText(dirtyMarker);
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
});

test('keeps terminal session when switching workbench panels', async ({ page }) => {
  const sockets = trackTerminalSockets(page);

  await page.goto('/stage0.html');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await connectButton(page).click();
  await expect(page.getByRole('status')).toHaveText('connected');
  await expect(page.getByTestId('terminal-last-output')).toContainText('POC4 browser terminal ready');
  await expect.poll(() => sentResizeFrames(sockets).length).toBeGreaterThan(0);
  const resize = sentResizeFrames(sockets)[0];
  expect(resize.cols).toBeGreaterThan(0);
  expect(resize.rows).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => openSockets(sockets)).toHaveLength(1);

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('status')).toHaveText('connected');
  await expect.poll(() => openSockets(sockets)).toHaveLength(1);

  await typeInXterm(page, 'K');
  await expect(page.getByTestId('terminal-last-output')).toHaveText('K');
});

test('inactive terminal does not intercept Ctrl+F from the File panel', async ({ page }) => {
  await page.goto('/stage0.html');
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor')).toBeVisible();

  const dispatched = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });

  expect(dispatched.defaultPrevented).toBe(false);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByPlaceholder('Search...')).toHaveCount(0);
});

for (const viewport of viewports) {
  test(`captures ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));
    await page.setViewportSize(viewport);
    await page.goto('/stage0.html');
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('artifactId');
    await page.screenshot({
      path: `../docs/evidence/stage-0/${testInfo.project.name}-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
