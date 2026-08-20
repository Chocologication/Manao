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
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay: 20 });
}

async function typeInXterm(page: Page, text: string): Promise<void> {
  const textarea = page.getByRole('textbox', { name: 'Terminal input' });
  await expect(textarea).toBeAttached();
  await textarea.focus();
  await page.keyboard.type(text);
}

function trackTerminalSockets(page: Page) {
  const sockets: Array<{ closed: boolean }> = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/terminal')) return;
    const record = { closed: false };
    sockets.push(record);
    ws.on('close', () => {
      record.closed = true;
    });
  });
  return sockets;
}

test('spike workbench workflow', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const sockets = trackTerminalSockets(page);

  await page.goto('/');
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
  await expect.poll(() => sockets.filter((socket) => !socket.closed)).toHaveLength(0);

  await connectButton(page).click();
  await expect(page.getByRole('status')).toHaveText('connected');
  await expect(page.getByTestId('terminal-last-output')).toContainText('POC4 browser terminal ready');
  await expect.poll(() => sockets.filter((socket) => !socket.closed)).toHaveLength(1);

  const echoOnce = 'Q';
  await typeInXterm(page, echoOnce);
  await expect(page.getByTestId('terminal-last-output')).toHaveText(echoOnce);

  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();

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

  expect(consoleErrors).toEqual([]);
});

for (const viewport of viewports) {
  test(`captures ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('artifactId');
    await page.screenshot({
      path: `../docs/evidence/stage-0/${testInfo.project.name}-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
