import { expect, test, type Locator, type Page, type Request, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';

const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

type FileResource = 'tree' | 'meta' | 'content';

type FileApiCall = {
  resource: FileResource;
  path: string;
  method: string;
  status?: number;
};

type WriteScenario = 'normal' | 'delayed' | 'locked' | 'conflict' | 'failure';

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

function treeItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function editorTab(page: Page, name: RegExp): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name });
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Save', exact: true });
}

function discardButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Discard', exact: true });
}

function nameField(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Name' });
}

function appAlert(page: Page): Locator {
  return page.locator('p[role="alert"]');
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseProjectFileApi(url: string): { resource: FileResource; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/api\/v1\/projects\/[^/]+\/files\/(tree|meta|content)$/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return {
    resource: match[1] as FileResource,
    path: parsed.searchParams.get('path') ?? '',
  };
}

function isRelativeContentPut(request: Request, path: string): boolean {
  if (request.method() !== 'PUT') {
    return false;
  }
  const parsed = parseProjectFileApi(request.url());
  return parsed !== null && parsed.resource === 'content' && parsed.path === path;
}

function installFileApiObserver(page: Page) {
  const requests: FileApiCall[] = [];
  const responses: FileApiCall[] = [];

  page.on('request', (request) => {
    const parsed = parseProjectFileApi(request.url());
    if (parsed === null) {
      return;
    }
    requests.push({ ...parsed, method: request.method() });
  });

  page.on('response', (response) => {
    const parsed = parseProjectFileApi(response.url());
    if (parsed === null) {
      return;
    }
    responses.push({
      ...parsed,
      method: response.request().method(),
      status: response.status(),
    });
  });

  return {
    requests,
    responses,
    count(resource: FileResource, path: string, method = 'GET'): number {
      return requests.filter(
        (item) => item.resource === resource && item.path === path && item.method === method,
      ).length;
    },
  };
}

function waitForFileApi(
  page: Page,
  resource: FileResource,
  path: string,
  status = 200,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseProjectFileApi(response.url());
    return (
      parsed !== null &&
      parsed.resource === resource &&
      parsed.path === path &&
      response.request().method() === 'GET' &&
      response.status() === status
    );
  });
}

function isForbiddenProductionUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return /\/terminal(?:\?|\/|$)/.test(url);
  }
  if (/\/terminal(?:\/|$)/.test(parsed.pathname)) {
    return true;
  }
  return parsed.port === '4174' && parsed.pathname !== '/health';
}

function installProductionRequestGuard(page: Page) {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (isForbiddenProductionUrl(request.url())) {
      forbidden.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('websocket', (ws) => {
    if (isForbiddenProductionUrl(ws.url()) || ws.url().includes('/terminal')) {
      forbidden.push(`WS ${ws.url()}`);
    }
  });
  return forbidden;
}

async function signIn(
  page: Page,
  credentials: { username: string; password: string },
): Promise<string> {
  const loginResponse = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return pathname === '/api/v1/auth/login' && response.request().method() === 'POST';
  });
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await loginResponse).json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  expect(body.accessToken?.length).toBeGreaterThan(0);
  return body.accessToken as string;
}

async function openAliceWorkbench(
  page: Page,
): Promise<{ accessToken: string; workspaceRevision: string }> {
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  const treeResponse = await rootTree;
  const treeBody = (await treeResponse.json()) as { workspaceRevision?: string };
  expect(typeof treeBody.workspaceRevision).toBe('string');
  expect(treeBody.workspaceRevision?.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  return { accessToken, workspaceRevision: treeBody.workspaceRevision as string };
}

async function expandDirectory(page: Page, name: string, directoryPath: string): Promise<void> {
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  if ((await item.getAttribute('aria-expanded')) === 'true') {
    return;
  }
  const treeResponse = waitForFileApi(page, 'tree', directoryPath);
  await item.click();
  await treeResponse;
  await expect(item).toHaveAttribute('aria-expanded', 'true');
}

async function expandToAliceDemo(page: Page): Promise<void> {
  await expandDirectory(page, 'src', 'src');
  await expandDirectory(page, 'main', 'src/main');
  await expandDirectory(page, 'java', 'src/main/java');
  await expandDirectory(page, 'demo', 'src/main/java/demo');
  await expect(treeItem(page, 'App.java')).toBeVisible();
}

async function openFile(
  page: Page,
  name: string,
  _filePath: string,
  options: { content?: boolean } = {},
): Promise<void> {
  const expectContent = options.content !== false;
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  await item.click();
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name }),
  ).toBeVisible();
  if (expectContent) {
    await expect(
      page.locator('.monaco-editor').or(page.getByRole('textbox', { name })),
    ).toBeVisible();
  }
}

async function waitForMonacoText(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);
}

async function monacoValue(page: Page, pathFragment: string): Promise<string> {
  return page.evaluate((fragment) => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor?: { getModels?: () => Array<{ uri: { toString(): string }; getValue(): string }> };
        };
      }
    ).monaco;
    const match = monaco?.editor
      ?.getModels?.()
      .find((model) => model.uri.toString().includes(fragment));
    if (match === undefined) {
      throw new Error(`Monaco model missing: ${fragment}`);
    }
    return match.getValue();
  }, pathFragment);
}

async function appendMonaco(page: Page, pathFragment: string, text: string): Promise<void> {
  await page.evaluate(
    ({ fragment, suffix }) => {
      const monaco = (
        window as unknown as {
          monaco?: {
            editor?: {
              getModels?: () => Array<{
                uri: { toString(): string };
                getLineCount(): number;
                getLineMaxColumn(line: number): number;
                applyEdits(
                  edits: Array<{
                    range: {
                      startLineNumber: number;
                      startColumn: number;
                      endLineNumber: number;
                      endColumn: number;
                    };
                    text: string;
                  }>,
                ): void;
              }>;
            };
          };
        }
      ).monaco;
      const match = monaco?.editor
        ?.getModels?.()
        .find((model) => model.uri.toString().includes(fragment));
      if (match === undefined) {
        throw new Error(`Monaco model missing: ${fragment}`);
      }
      const line = match.getLineCount();
      const column = match.getLineMaxColumn(line);
      match.applyEdits([
        {
          range: {
            startLineNumber: line,
            startColumn: column,
            endLineNumber: line,
            endColumn: column,
          },
          text: suffix,
        },
      ]);
    },
    { fragment: pathFragment, suffix: text },
  );
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
    const visible = await page.locator('.monaco-editor .view-lines').innerText();
    if (visible.includes(text)) {
      return;
    }
    await page.keyboard.type(text, { delay: 20 });
  }
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);
}

async function interceptNextContentPut(page: Page, mode: 'too-large' | 'network'): Promise<void> {
  await page.evaluate((next) => {
    const host = window as unknown as {
      fetch: typeof fetch;
      __e2eOriginalFetch?: typeof fetch;
    };
    if (host.__e2eOriginalFetch === undefined) {
      host.__e2eOriginalFetch = host.fetch.bind(window);
    }
    const original = host.__e2eOriginalFetch;
    host.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'PUT' && url.includes('/files/content')) {
        host.fetch = original;
        delete host.__e2eOriginalFetch;
        if (next === 'network') {
          throw new TypeError('Failed to fetch');
        }
        return new Response(
          JSON.stringify({
            code: 'FILE_TOO_LARGE',
            message: 'File too large',
            traceId: 'e2e-stage3-413',
          }),
          { status: 413, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return original(input, init);
    };
  }, mode);
}

async function setWriteScenario(
  page: Page,
  accessToken: string,
  scenario: WriteScenario,
): Promise<void> {
  const status = await page.evaluate(async ({ token, next }) => {
    const response = await fetch('/api/v1/session/write-scenario', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenario: next }),
    });
    return response.status;
  }, { token: accessToken, next: scenario });
  expect(status).toBe(204);
}

async function submitCreateBasename(page: Page, name: string): Promise<void> {
  const input = nameField(page);
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByRole('dialog', { name: 'New file' }).or(page.getByRole('dialog', { name: 'New folder' })).getByRole('button', { name: 'Create' }).click();
}

async function submitRenameBasename(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Rename' });
  const input = nameField(page);
  await expect(input).toBeVisible();
  await input.fill(name);
  await dialog.getByRole('button', { name: 'Rename' }).click();
}

async function prepareVisualCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.head.querySelector('style[data-e2e-visual]')) {
      return;
    }
    const style = document.createElement('style');
    style.setAttribute('data-e2e-visual', '');
    style.textContent = [
      '*, *::before, *::after {',
      '  animation: none !important;',
      '  animation-duration: 0s !important;',
      '  transition: none !important;',
      '  caret-color: transparent !important;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      root: root.scrollWidth > root.clientWidth + 1,
      body: body.scrollWidth > body.clientWidth + 1,
    };
  });
  expect(overflow.root).toBe(false);
  expect(overflow.body).toBe(false);
}

async function assertWorkbenchPanelsDoNotOverlap(page: Page): Promise<void> {
  const headerBox = await page.locator('.workbench-shell > header').boundingBox();
  const sidebarBox = await page.getByRole('complementary', { name: 'Project files' }).boundingBox();
  const editorBox = await page.getByLabel('Editor', { exact: true }).boundingBox();
  expect(headerBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  if (headerBox === null || sidebarBox === null || editorBox === null) {
    return;
  }
  expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(sidebarBox.y + 1);
  expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(editorBox.x + 2);
}

async function assertReachable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  const viewport = locator.page().viewportSize();
  expect(viewport).not.toBeNull();
  if (viewport === null) {
    return;
  }
  expect(box.x).toBeLessThan(viewport.width);
  expect(box.y).toBeLessThan(viewport.height);
  expect(box.x + box.width).toBeGreaterThan(0);
  expect(box.y + box.height).toBeGreaterThan(0);
}

async function assertInsideViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = locator.page().viewportSize();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function assertMonacoPainted(page: Page, sourceText: string): Promise<void> {
  await waitForMonacoText(page, sourceText);
  const painted = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.monaco-editor canvas')].filter(
      (node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement,
    );
    for (const canvas of canvases) {
      if (canvas.width < 2 || canvas.height < 2) {
        continue;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) {
        continue;
      }
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let first: string | null = null;
      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3];
        if (alpha === undefined || alpha === 0) {
          continue;
        }
        const key = `${data[index]},${data[index + 1]},${data[index + 2]},${alpha}`;
        if (first === null) {
          first = key;
        } else if (key !== first) {
          return true;
        }
      }
    }
    return false;
  });
  expect(painted).toBe(true);
}

async function captureViewport(
  page: Page,
  filePath: string,
  viewport: { width: number; height: number },
): Promise<void> {
  const bytes = await page.screenshot({
    path: filePath,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  expect(pngSize(bytes)).toEqual({ width: viewport.width, height: viewport.height });
}

async function assertFocusVisible(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      return locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const opacity = Number(style.opacity);
        if (style.visibility === 'hidden' || !(opacity > 0)) {
          return false;
        }
        const inViewport =
          rect.width > 1 &&
          rect.height > 1 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        if (!inViewport) {
          return false;
        }
        const outlineWidth = Number.parseFloat(style.outlineWidth);
        const hasOutline =
          style.outlineStyle !== 'none' &&
          style.outlineStyle !== '' &&
          Number.isFinite(outlineWidth) &&
          outlineWidth > 0;
        const shadow = style.boxShadow.trim();
        const hasRing = shadow !== '' && shadow !== 'none';
        return hasOutline || hasRing;
      });
    })
    .toBe(true);
}

async function tabUntilTreeitem(page: Page): Promise<void> {
  const focusedIsTreeitem = async () =>
    page.evaluate(() => document.activeElement?.getAttribute('role') === 'treeitem');
  if (await focusedIsTreeitem()) {
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await focusedIsTreeitem()) {
      return;
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.keyboard.press('Shift+Tab');
    if (await focusedIsTreeitem()) {
      return;
    }
  }
  await page.getByRole('treeitem').first().focus();
  if (await focusedIsTreeitem()) {
    return;
  }
  throw new Error('Did not focus a treeitem');
}

async function arrowUntilFocused(
  page: Page,
  locator: Locator,
  key: 'ArrowUp' | 'ArrowDown',
  max = 20,
): Promise<void> {
  for (let attempt = 0; attempt < max; attempt += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press(key);
  }
  await expect(locator).toBeFocused();
}

async function tabUntilFocused(page: Page, locator: Locator, maxTabs = 50): Promise<void> {
  if (await locator.evaluate((element) => element === document.activeElement)) {
    return;
  }
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await page.keyboard.press('Shift+Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  await expect(locator).toBeFocused();
}

async function triggerSessionRefetch(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

test('preserves a dirty Monaco buffer across tab switch and return', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3DIRTY');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3DIRTY');

  await openFile(page, 'README.md', 'README.md');
  await waitForMonacoText(page, 'Alice Notebook');
  await expect(editorTab(page, /README\.md/)).toHaveAttribute('aria-selected', 'true');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3DIRTY');

  await editorTab(page, /pom\.xml/).click();
  await expect(editorTab(page, /pom\.xml/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('STAGE3DIRTY');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3DIRTY');
});

test('saves with Ctrl+S using a relative PUT, Bearer token and expected revision', async ({
  page,
}) => {
  const { accessToken, workspaceRevision } = await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3SAVE');
  await expect(saveButton(page)).toBeEnabled();

  const putRequest = page.waitForRequest((request) => isRelativeContentPut(request, 'pom.xml'));
  const putResponse = page.waitForResponse((response) => {
    return isRelativeContentPut(response.request(), 'pom.xml') && response.status() === 200;
  });
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.getByRole('textbox', { name: 'Editor content' }).focus();
  await page.keyboard.press('Control+s');

  const request = await putRequest;
  const url = new URL(request.url());
  expect(url.origin).toBe('http://127.0.0.1:4173');
  expect(url.pathname).toBe(`/api/v1/projects/${ALICE_SEED_PROJECT_ID}/files/content`);
  expect(url.searchParams.get('path')).toBe('pom.xml');
  expect(request.headers()['authorization']).toBe(`Bearer ${accessToken}`);
  const body = JSON.parse(request.postData() ?? '{}') as {
    content?: string;
    expectedWorkspaceRevision?: string;
  };
  expect(body.expectedWorkspaceRevision).toBe(workspaceRevision);
  expect(body.content).toContain('STAGE3SAVE');

  const response = await putResponse;
  const payload = (await response.json()) as { workspaceRevision?: string };
  expect(typeof payload.workspaceRevision).toBe('string');
  expect(payload.workspaceRevision).not.toBe(workspaceRevision);
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible();
  await expect(editorTab(page, /pom\.xml/)).not.toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3SAVE');
});

test('keeps a newer edit dirty after a delayed first-snapshot save', async ({ page }) => {
  const { accessToken } = await openAliceWorkbench(page);
  await setWriteScenario(page, accessToken, 'delayed');
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3FIRST');
  await expect(saveButton(page)).toBeEnabled();

  const putRequest = page.waitForRequest((request) => isRelativeContentPut(request, 'pom.xml'));
  const putResponse = page.waitForResponse((response) => {
    return isRelativeContentPut(response.request(), 'pom.xml') && response.status() === 200;
  });
  await saveButton(page).click();
  await appendMonaco(page, 'pom.xml', 'STAGE3LATER');
  const request = await putRequest;
  const body = JSON.parse(request.postData() ?? '{}') as { content?: string };
  expect(body.content).toContain('STAGE3FIRST');
  expect(body.content).not.toContain('STAGE3LATER');
  expect((await putResponse).status()).toBe(200);
  await expect
    .poll(async () => monacoValue(page, 'pom.xml'))
    .toContain('STAGE3LATER');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3LATER');
  await setWriteScenario(page, accessToken, 'normal');
});

test('preserves dirty content after network, locked, conflict and 413 save failures', async ({
  page,
}) => {
  const { accessToken } = await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3KEEP');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await setWriteScenario(page, accessToken, 'locked');
  await saveButton(page).click();
  await expect(appAlert(page)).toHaveText(/project is locked/i);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3KEEP');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await setWriteScenario(page, accessToken, 'conflict');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(appAlert(page)).toHaveText(/workspace revision conflict/i);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3KEEP');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await setWriteScenario(page, accessToken, 'normal');
  await interceptNextContentPut(page, 'too-large');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(appAlert(page)).toHaveText(/file is too large/i);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3KEEP');

  await interceptNextContentPut(page, 'network');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(appAlert(page)).toHaveText(/network request failed/i);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3KEEP');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
});

test('dirty close supports Cancel, Discard and Save-and-close', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3CLOSE');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await page.getByRole('button', { name: 'Close pom.xml' }).click();
  const closeDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(closeDialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(closeDialog).toHaveCount(0);
  await expect(editorTab(page, /pom\.xml/)).toBeVisible();
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3CLOSE');

  await page.getByRole('button', { name: 'Close pom.xml' }).click();
  await expect(closeDialog).toBeVisible();
  await discardButton(page).click();
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(closeDialog).toHaveCount(0);

  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  expect(await monacoValue(page, 'pom.xml')).not.toContain('STAGE3CLOSE');
  await typeInMonaco(page, 'STAGE3SAVEDCLOSE');
  await page.getByRole('button', { name: 'Close pom.xml' }).click();
  await expect(closeDialog).toBeVisible();
  const putResponse = page.waitForResponse((response) => {
    return isRelativeContentPut(response.request(), 'pom.xml') && response.status() === 200;
  });
  await page.getByRole('button', { name: 'Save and close' }).click();
  await putResponse;
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(closeDialog).toHaveCount(0);

  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'STAGE3SAVEDCLOSE');
  await expect(editorTab(page, /pom\.xml/)).not.toContainText('*');
});

test('back and logout guards support Cancel and Discard', async ({ page }) => {
  test.setTimeout(90_000);
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3LEAVE');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');

  await page.getByRole('link', { name: 'Back to projects' }).click();
  const leaveDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(leaveDialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard and leave' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(leaveDialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3LEAVE');

  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(leaveDialog).toBeVisible();
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();

  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  expect(await monacoValue(page, 'pom.xml')).not.toContain('STAGE3LEAVE');
  await typeInMonaco(page, 'STAGE3LOGOUT');

  await page.getByRole('button', { name: 'Log out' }).click();
  const logoutDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(logoutDialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(logoutDialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3LOGOUT');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(logoutDialog).toBeVisible();
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByText('Alice Notebook')).toHaveCount(0);
});

test('creates root and nested files and directories with lazy tree counts', async ({ page }) => {
  const observer = installFileApiObserver(page);
  await openAliceWorkbench(page);
  const rootBefore = observer.count('tree', '');
  expect(observer.count('tree', 'src')).toBe(0);
  expect(observer.count('tree', 'docs')).toBe(0);

  await page.getByRole('button', { name: 'New file' }).click();
  await submitCreateBasename(page, 'notes.md');
  await expect(treeItem(page, 'notes.md')).toBeVisible();
  await expect(editorTab(page, /notes\.md/)).toBeVisible();
  await expect.poll(() => observer.count('tree', '')).toBe(rootBefore + 1);
  expect(observer.count('tree', 'src')).toBe(0);
  expect(observer.count('tree', 'docs')).toBe(0);

  await treeItem(page, 'src').click();
  await expect(treeItem(page, 'src')).toHaveAttribute('aria-selected', 'true');
  const srcBeforeCreate = observer.count('tree', 'src');
  await page.getByRole('button', { name: 'New folder' }).click();
  await submitCreateBasename(page, 'lib');
  await expect(treeItem(page, 'lib')).toBeVisible();
  await expect.poll(() => observer.count('tree', 'src')).toBeGreaterThan(srcBeforeCreate);
  expect(observer.count('tree', 'docs')).toBe(0);

  await expandToAliceDemo(page);
  await treeItem(page, 'App.java').click();
  const demoBefore = observer.count('tree', 'src/main/java/demo');
  await page.getByRole('button', { name: 'New file' }).click();
  await submitCreateBasename(page, 'extra.java');
  await expect(treeItem(page, 'extra.java')).toBeVisible();
  await expect(editorTab(page, /extra\.java/)).toBeVisible();
  await expect.poll(() => observer.count('tree', 'src/main/java/demo')).toBeGreaterThan(demoBefore);
});

test('renames an open file and directory descendants without stale old paths', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await expandToAliceDemo(page);
  await openFile(page, 'App.java', 'src/main/java/demo/App.java');
  await waitForMonacoText(page, 'Hello, POC4');

  await treeItem(page, 'pom.xml').click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await submitRenameBasename(page, 'project.xml');
  await expect(treeItem(page, 'project.xml')).toBeVisible();
  await expect(treeItem(page, 'pom.xml')).toHaveCount(0);
  await expect(editorTab(page, /project\.xml/)).toBeVisible();
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(editorTab(page, /project\.xml/)).toHaveAttribute('title', 'project.xml');

  await treeItem(page, 'src').click();
  await expect(treeItem(page, 'src')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await submitRenameBasename(page, 'source');
  await expect(treeItem(page, 'source')).toBeVisible();
  await expect(treeItem(page, 'src')).toHaveCount(0);
  await expect(editorTab(page, /App\.java/)).toBeVisible();
  await expect(editorTab(page, /App\.java/)).toHaveAttribute(
    'title',
    'source/main/java/demo/App.java',
  );
  await expect(page.locator('[title="src/main/java/demo/App.java"]')).toHaveCount(0);
  await expect(page.getByText('src/main/java/demo/App.java')).toHaveCount(0);
});

test('delete cancel, non-empty rejection and confirmed cleanup', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'README.md', 'README.md');
  await waitForMonacoText(page, 'Alice Notebook');

  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('README.md');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(treeItem(page, 'README.md')).toBeVisible();
  await expect(editorTab(page, /README\.md/)).toBeVisible();

  await treeItem(page, 'src').click();
  await expect(treeItem(page, 'src')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('src');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.locator('p[role="alert"]')).toHaveText('Directory is not empty');
  await expect(dialog).toBeVisible();
  await expect(treeItem(page, 'src')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'New folder' }).click();
  await submitCreateBasename(page, 'tmp');
  await expect(treeItem(page, 'tmp')).toBeVisible();
  await treeItem(page, 'tmp').click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(treeItem(page, 'tmp')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

test('refresh while dirty does not replace the editor buffer', async ({ page }) => {
  const observer = installFileApiObserver(page);
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3REFRESH');
  const contentGets = observer.count('content', 'pom.xml');
  const treeGets = observer.count('tree', '');

  const treeRefresh = waitForFileApi(page, 'tree', '');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await treeRefresh;
  await expect.poll(() => observer.count('tree', '')).toBeGreaterThan(treeGets);
  expect(observer.count('content', 'pom.xml')).toBe(contentGets);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE3REFRESH');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('STAGE3REFRESH');
});

test('blocked files stay at zero content GETs and reject content PUT bypass', async ({ page }) => {
  const observer = installFileApiObserver(page);
  const { accessToken, workspaceRevision } = await openAliceWorkbench(page);
  await expandDirectory(page, 'assets', 'assets');
  await openFile(page, 'logo.png', 'assets/logo.png', { content: false });
  await expect(page.getByText('This file is binary and cannot be previewed')).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  expect(observer.count('content', 'assets/logo.png')).toBe(0);
  expect(observer.count('content', 'assets/logo.png', 'PUT')).toBe(0);

  const bypass = await page.evaluate(
    async ({ token, projectId, revision }) => {
      const response = await fetch(
        `/api/v1/projects/${projectId}/files/content?path=assets/logo.png`,
        {
          method: 'PUT',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: 'not-a-png',
            expectedWorkspaceRevision: revision,
          }),
        },
      );
      const body = (await response.json()) as { code?: string };
      return { status: response.status, code: body.code ?? null };
    },
    {
      token: accessToken,
      projectId: ALICE_SEED_PROJECT_ID,
      revision: workspaceRevision,
    },
  );
  expect(bypass.status).toBe(415);
  expect(bypass.code).toBe('BINARY_FILE');
  expect(observer.count('content', 'assets/logo.png')).toBe(0);
});

test('isolates Alice and Bob projects and stale 401 cleanup', async ({ page }) => {
  test.setTimeout(90_000);
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'ALICEONLY');
  await page.getByRole('link', { name: 'Back to projects' }).click();
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, BOB);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Bob Lab')).toBeVisible();
  await expect(projectCard(page, 'Alice Notebook')).toHaveCount(0);
  const bobTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Bob Lab').getByRole('link', { name: 'Open' }).click();
  await bobTree;
  await expect(page).toHaveURL(new RegExp(`/projects/${BOB_SEED_PROJECT_ID}$`));
  await expect(treeItem(page, 'lab-notes.md')).toBeVisible();
  await expect(treeItem(page, 'pom.xml')).toHaveCount(0);
  await expect(page.getByText('ALICEONLY')).toHaveCount(0);
  await expect(page.getByText('alice', { exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByRole('button', { name: 'Log out' }).click();
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
  const aliceTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await aliceTree;
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');

  const unauthorized = page.waitForResponse((response) => {
    const parsed = parseProjectFileApi(response.url());
    const { pathname } = new URL(response.url());
    const isFile = parsed !== null;
    const isProject =
      pathname.replace(/\/$/, '') === `/api/v1/projects/${ALICE_SEED_PROJECT_ID}` ||
      pathname.replace(/\/$/, '') === '/api/v1/projects';
    return (isFile || isProject) && response.status() === 401;
  });
  const expireStatus = await page.evaluate(async (token) => {
    const response = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    return response.status;
  }, accessToken);
  expect(expireStatus).toBe(204);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await triggerSessionRefetch(page);
  expect((await unauthorized).status()).toBe(401);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(SESSION_EXPIRED);
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
});

test('does not send terminal or echo-ws requests before Terminal Open', async ({ page }) => {
  const forbidden = installProductionRequestGuard(page);
  await openAliceWorkbench(page);
  await expect(page.getByRole('tab', { name: 'Run' })).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeEnabled();

  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3NORUN');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('region', { name: 'Job terminal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  await page.getByRole('tab', { name: 'File' }).click();
  await saveButton(page).click();
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test('completes toolbar, dialogs, editor, Save and delete from the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openAliceWorkbench(page);
  expect(
    await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  ).toBe(true);
  await assertNoHorizontalOverflow(page);

  const skip = page.getByRole('link', { name: 'Skip to editor' });
  await tabUntilFocused(page, skip);
  await assertFocusVisible(skip);

  const newFile = page.getByRole('button', { name: 'New file' });
  await tabUntilFocused(page, newFile);
  await assertFocusVisible(newFile);
  await page.keyboard.press('Enter');
  const createDialog = page.getByRole('dialog', { name: 'New file' });
  await expect(createDialog).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(createDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.type('pom.xml');
  await page.keyboard.press('Enter');
  await expect(createDialog.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(createDialog).toHaveCount(0);
  await expect(newFile).toBeFocused();

  await tabUntilTreeitem(page);
  await arrowUntilFocused(page, treeItem(page, 'pom.xml'), 'ArrowDown');
  await page.keyboard.press('Enter');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE3A11Y');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  const tabText = await editorTab(page, /pom\.xml/).innerText();
  expect(tabText).toContain('*');
  expect(tabText).toContain('pom.xml');

  await editorTab(page, /pom\.xml/).focus();
  await tabUntilFocused(page, saveButton(page));
  await assertFocusVisible(saveButton(page));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible();
  await expect(editorTab(page, /pom\.xml/)).not.toContainText('*');

  await typeInMonaco(page, 'STAGE3A11Y2');
  await editorTab(page, /pom\.xml/).focus();
  await tabUntilFocused(page, page.getByRole('button', { name: 'Close pom.xml' }));
  await page.keyboard.press('Enter');
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(unsaved).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(discardButton(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(unsaved).toHaveCount(0);
  await expect(editorTab(page, /pom\.xml/)).toBeVisible();

  await page.getByRole('treeitem').first().focus();
  await arrowUntilFocused(page, treeItem(page, 'README.md'), 'ArrowDown');
  await page.keyboard.press('Enter');
  await treeItem(page, 'README.md').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const deleteDialog = page.getByRole('dialog', { name: 'Delete' });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(deleteDialog.getByRole('button', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toBeFocused();
  await expect(treeItem(page, 'README.md')).toBeVisible();
});

for (const viewport of viewports) {
  test(`captures dirty workbench and delete dialog at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openAliceWorkbench(page);
    await openFile(page, 'pom.xml', 'pom.xml');
    await expandToAliceDemo(page);
    await openFile(page, 'App.java', 'src/main/java/demo/App.java');
    await waitForMonacoText(page, 'Hello, POC4');
    await typeInMonaco(page, 'STAGE3VISUAL');
    await editorTab(page, /App\.java/).click();
    await expect(editorTab(page, /App\.java/)).toContainText('*');
    await assertMonacoPainted(page, 'STAGE3VISUAL');

    const appTab = editorTab(page, /App\.java/);
    await expect(appTab).toHaveAttribute('title', 'src/main/java/demo/App.java');
    await expect(appTab.locator('span.truncate, span.flex-1').first()).toHaveClass(/truncate/);
    await expect(appTab).toContainText('*');

    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertWorkbenchPanelsDoNotOverlap(page);
    await assertReachable(page.getByRole('button', { name: 'Refresh' }));
    await assertReachable(page.getByRole('button', { name: 'New file' }));
    await assertReachable(saveButton(page));
    await assertReachable(appTab);
    await assertReachable(page.getByRole('button', { name: 'Close App.java' }));
    if (viewport.width === 1280) {
      await assertNoHorizontalOverflow(page);
    }

    await captureViewport(
      page,
      `../docs/evidence/stage-3/${testInfo.project.name}-dirty-${viewport.name}.png`,
      viewport,
    );

    await treeItem(page, 'README.md').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete' });
    await expect(dialog).toBeVisible();
    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertInsideViewport(dialog);
    await assertReachable(dialog.getByRole('button', { name: 'Delete' }));
    await assertReachable(dialog.getByRole('button', { name: 'Cancel' }));
    await assertReachable(page.getByRole('button', { name: 'Refresh' }));

    await captureViewport(
      page,
      `../docs/evidence/stage-3/${testInfo.project.name}-delete-dialog-${viewport.name}.png`,
      viewport,
    );
  });
}
