import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
const POM_MODEL = `poc4://workspace/${ALICE_SEED_PROJECT_ID}/pom.xml`;
const APP_MODEL = `poc4://workspace/${ALICE_SEED_PROJECT_ID}/src/main/java/demo/App.java`;

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

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

function treeItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function editorTab(page: Page, name: RegExp): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name });
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
    count(resource: FileResource, path: string): number {
      return requests.filter(
        (item) => item.resource === resource && item.path === path && item.method === 'GET',
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

async function openAliceWorkbench(page: Page): Promise<string> {
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await rootTree;
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  return accessToken;
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
  filePath: string,
  options: { content?: boolean } = {},
): Promise<void> {
  const expectContent = options.content !== false;
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  const meta = waitForFileApi(page, 'meta', filePath);
  const content = expectContent ? waitForFileApi(page, 'content', filePath) : null;
  await item.click();
  await meta;
  if (content !== null) {
    await content;
  }
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name }),
  ).toBeVisible();
}

async function waitForMonacoText(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);
}

async function monacoModelUris(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: { editor?: { getModels?: () => Array<{ uri: { toString(): string } }> } };
      }
    ).monaco;
    if (monaco?.editor?.getModels === undefined) {
      throw new Error('window.monaco.editor.getModels is not available');
    }
    return monaco.editor
      .getModels()
      .map((model) => model.uri.toString())
      .filter((uri) => uri.startsWith('poc4://'));
  });
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

test('logs in and opens Alice\'s ready project', async ({ page }) => {
  await openAliceWorkbench(page);
  await expect(page.getByText('READY', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Run' })).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeEnabled();
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible();
});

test('requests only the root tree on first load and shows .gitignore', async ({ page }) => {
  const observer = installFileApiObserver(page);
  await openAliceWorkbench(page);

  await expect(treeItem(page, '.gitignore')).toBeVisible();
  await expect(treeItem(page, 'pom.xml')).toBeVisible();
  await expect(treeItem(page, 'App.java')).toHaveCount(0);
  await expect(treeItem(page, 'main')).toHaveCount(0);

  expect(observer.count('tree', '')).toBeGreaterThanOrEqual(1);
  expect(observer.requests.filter((item) => item.resource === 'tree').every((item) => item.path === '')).toBe(
    true,
  );
  expect(observer.count('tree', 'src')).toBe(0);
  expect(observer.count('tree', 'docs')).toBe(0);
  expect(observer.count('tree', 'assets')).toBe(0);
});

test('expands src -> main -> java -> demo lazily with one request per directory', async ({ page }) => {
  const observer = installFileApiObserver(page);
  await openAliceWorkbench(page);
  await expect(treeItem(page, 'main')).toHaveCount(0);

  await expandToAliceDemo(page);

  await expect(treeItem(page, 'App.java')).toBeVisible();
  await expect(treeItem(page, 'NearLimit.java')).toBeVisible();
  expect(observer.count('tree', '')).toBe(1);
  expect(observer.count('tree', 'src')).toBe(1);
  expect(observer.count('tree', 'src/main')).toBe(1);
  expect(observer.count('tree', 'src/main/java')).toBe(1);
  expect(observer.count('tree', 'src/main/java/demo')).toBe(1);
});

test('opens pom.xml and App.java, switches tabs, and preserves view state', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await expect(editorTab(page, /pom\.xml/)).toHaveAttribute('aria-selected', 'true');

  await expandToAliceDemo(page);
  await openFile(page, 'App.java', 'src/main/java/demo/App.java');
  await waitForMonacoText(page, 'Hello, POC4');
  await expect(editorTab(page, /App\.java/)).toHaveAttribute('aria-selected', 'true');
  await expect(editorTab(page, /pom\.xml/)).toBeVisible();

  await editorTab(page, /pom\.xml/).click();
  await waitForMonacoText(page, 'artifactId');
  await expect(editorTab(page, /pom\.xml/)).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'pom.xml')).toHaveAttribute('aria-selected', 'true');

  await editorTab(page, /App\.java/).click();
  await waitForMonacoText(page, 'Hello, POC4');
  await expect(editorTab(page, /App\.java/)).toHaveAttribute('aria-selected', 'true');

  const uris = await monacoModelUris(page);
  expect(uris.some((uri) => uri.includes('pom.xml'))).toBe(true);
  expect(uris.some((uri) => uri.includes('App.java'))).toBe(true);
});

test('accepts typing in Monaco and marks the tab dirty', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');

  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  const input = page.getByRole('textbox', { name: 'Editor content' });
  await input.focus();
  await page.keyboard.type('STAGE3WRITABLE', { delay: 20 });

  const after = await page.locator('.monaco-editor .view-lines').innerText();
  expect(after).toContain('STAGE3WRITABLE');
  expect(after).toContain('artifactId');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
});

test('disposes the closed tab model and keeps the remaining file model', async ({ page }) => {
  await openAliceWorkbench(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await expandToAliceDemo(page);
  await openFile(page, 'App.java', 'src/main/java/demo/App.java');
  await waitForMonacoText(page, 'Hello, POC4');

  await expect.poll(async () => monacoModelUris(page)).toEqual(
    expect.arrayContaining([expect.stringContaining('pom.xml'), expect.stringContaining('App.java')]),
  );

  await page.getByRole('button', { name: 'Close pom.xml' }).click();
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(editorTab(page, /App\.java/)).toBeVisible();
  await waitForMonacoText(page, 'Hello, POC4');

  await expect
    .poll(async () => (await monacoModelUris(page)).some((uri) => uri.includes('pom.xml')))
    .toBe(false);
  const remaining = await monacoModelUris(page);
  expect(remaining.some((uri) => uri.includes('App.java'))).toBe(true);
  expect(remaining.some((uri) => uri === POM_MODEL || uri.endsWith('/pom.xml'))).toBe(false);
  expect(remaining.some((uri) => uri === APP_MODEL || uri.includes('App.java'))).toBe(true);
});

test('opens binary, non-UTF-8 and oversized files without content requests', async ({ page }) => {
  const observer = installFileApiObserver(page);
  await openAliceWorkbench(page);

  await expandDirectory(page, 'assets', 'assets');
  await openFile(page, 'logo.png', 'assets/logo.png', { content: false });
  await expect(page.getByText('This file is binary and cannot be previewed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await expect(page.locator('[aria-label="Editor"] .monaco-editor')).toHaveCount(0);

  await expandDirectory(page, 'docs', 'docs');
  await openFile(page, 'latin1.txt', 'docs/latin1.txt', { content: false });
  await expect(page.getByText('This file is not UTF-8 encoded and cannot be previewed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();

  await openFile(page, 'too-large.md', 'docs/too-large.md', { content: false });
  await expect(page.getByText('This file is too large to preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();

  expect(observer.count('content', 'assets/logo.png')).toBe(0);
  expect(observer.count('content', 'docs/latin1.txt')).toBe(0);
  expect(observer.count('content', 'docs/too-large.md')).toBe(0);
  expect(observer.count('meta', 'assets/logo.png')).toBe(1);
  expect(observer.count('meta', 'docs/latin1.txt')).toBe(1);
  expect(observer.count('meta', 'docs/too-large.md')).toBe(1);
});

test('opens 20–50 MiB Markdown in the plain viewer without Monaco', async ({ page }) => {
  await openAliceWorkbench(page);
  await expandDirectory(page, 'docs', 'docs');
  await openFile(page, 'large-notes.md', 'docs/large-notes.md');

  const textarea = page.getByRole('textbox', { name: 'large-notes.md' });
  await expect(textarea).toBeVisible();
  await expect(textarea).not.toHaveAttribute('readonly');
  await expect(page.getByText('Plain text')).toBeVisible();
  await expect(page.locator('[aria-label="Editor"] .monaco-editor')).toHaveCount(0);
  await expect(textarea).toHaveValue(/# Large notes/);
});

test('does not leak tabs, expanded paths or file cache after logout', async ({ page }) => {
  await openAliceWorkbench(page);
  await expandToAliceDemo(page);
  await openFile(page, 'pom.xml', 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await expect(treeItem(page, 'App.java')).toBeVisible();

  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('tablist', { name: 'Editor tabs' })).toHaveCount(0);
  await expect(treeItem(page, 'App.java')).toHaveCount(0);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByText('Alice Notebook')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Editor tabs' })).toHaveCount(0);

  await signIn(page, BOB);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Bob Lab')).toBeVisible();
  await expect(projectCard(page, 'Alice Notebook')).toHaveCount(0);

  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Bob Lab').getByRole('link', { name: 'Open' }).click();
  await rootTree;
  await expect(page).toHaveURL(new RegExp(`/projects/${BOB_SEED_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Bob Lab' })).toBeVisible();
  await expect(treeItem(page, 'lab-notes.md')).toBeVisible();
  await expect(treeItem(page, '.gitignore')).toHaveCount(0);
  await expect(treeItem(page, 'pom.xml')).toHaveCount(0);
  await expect(treeItem(page, 'App.java')).toHaveCount(0);
  await expect(treeItem(page, 'src')).toHaveCount(0);
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(page.getByText('alice', { exact: true })).toHaveCount(0);

  await openFile(page, 'lab-notes.md', 'lab-notes.md');
  await waitForMonacoText(page, 'Bob Lab');
  await expect(page.getByText('Hello, POC4')).toHaveCount(0);
});

test('forces current-token 401 with an open file and returns to login', async ({ page }) => {
  const accessToken = await openAliceWorkbench(page);
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
  const alerts = page.getByRole('main').getByRole('alert');
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toHaveText(SESSION_EXPIRED);
  await expect(page.getByText('Alice Notebook')).toHaveCount(0);
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(page.getByRole('tree', { name: 'Files' })).toHaveCount(0);
});

test('completes tree, tabs, viewer and Download from the keyboard', async ({ page }) => {
  await openAliceWorkbench(page);

  const skip = page.getByRole('link', { name: 'Skip to editor' });
  await tabUntilFocused(page, skip);
  await assertFocusVisible(skip);

  await tabUntilFocused(page, treeItem(page, 'assets'));
  await assertFocusVisible(treeItem(page, 'assets'));

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(treeItem(page, 'src')).toBeFocused();
  const srcTree = waitForFileApi(page, 'tree', 'src');
  await page.keyboard.press('ArrowRight');
  await srcTree;
  await expect(treeItem(page, 'src')).toHaveAttribute('aria-expanded', 'true');
  await expect(treeItem(page, 'main')).toBeVisible();

  const mainTree = waitForFileApi(page, 'tree', 'src/main');
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'main')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await mainTree;
  await expect(treeItem(page, 'java')).toBeVisible();

  const javaTree = waitForFileApi(page, 'tree', 'src/main/java');
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'java')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await javaTree;
  await expect(treeItem(page, 'demo')).toBeVisible();

  const demoTree = waitForFileApi(page, 'tree', 'src/main/java/demo');
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'demo')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await demoTree;
  await expect(treeItem(page, 'App.java')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'App.java')).toBeFocused();
  const appMeta = waitForFileApi(page, 'meta', 'src/main/java/demo/App.java');
  const appContent = waitForFileApi(page, 'content', 'src/main/java/demo/App.java');
  await page.keyboard.press('Enter');
  await appMeta;
  await appContent;
  await waitForMonacoText(page, 'Hello, POC4');
  await expect(editorTab(page, /App\.java/)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(treeItem(page, 'src')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(treeItem(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(treeItem(page, 'pom.xml')).toBeFocused();
  const pomMeta = waitForFileApi(page, 'meta', 'pom.xml');
  const pomContent = waitForFileApi(page, 'content', 'pom.xml');
  await page.keyboard.press('Enter');
  await pomMeta;
  await pomContent;
  await waitForMonacoText(page, 'artifactId');

  await tabUntilFocused(page, editorTab(page, /App\.java/));
  await assertFocusVisible(editorTab(page, /App\.java/));
  await page.keyboard.press('Enter');
  await waitForMonacoText(page, 'Hello, POC4');

  const closePom = page.getByRole('button', { name: 'Close pom.xml' });
  await tabUntilFocused(page, closePom);
  await assertFocusVisible(closePom);
  await page.keyboard.press('Enter');
  await expect(editorTab(page, /pom\.xml/)).toHaveCount(0);
  await expect(editorTab(page, /App\.java/)).toBeVisible();

  await tabUntilTreeitem(page);
  await arrowUntilFocused(page, treeItem(page, 'assets'), 'ArrowUp');
  await assertFocusVisible(treeItem(page, 'assets'));
  const assetsTree = waitForFileApi(page, 'tree', 'assets');
  await page.keyboard.press('ArrowRight');
  await assetsTree;
  await expect(treeItem(page, 'logo.png')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'logo.png')).toBeFocused();
  const logoMeta = waitForFileApi(page, 'meta', 'assets/logo.png');
  await page.keyboard.press('Enter');
  await logoMeta;
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();

  await tabUntilFocused(page, page.getByRole('button', { name: 'Download' }));
  await assertFocusVisible(page.getByRole('button', { name: 'Download' }));
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  expect((await download).suggestedFilename()).toBe('logo.png');
});

for (const viewport of viewports) {
  test(`captures populated workbench and blocked-binary at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openAliceWorkbench(page);
    await openFile(page, 'pom.xml', 'pom.xml');
    await expandToAliceDemo(page);
    await openFile(page, 'App.java', 'src/main/java/demo/App.java');
    await assertMonacoPainted(page, 'Hello, POC4');

    const appTab = editorTab(page, /App\.java/);
    await expect(appTab).toHaveAttribute('title', 'src/main/java/demo/App.java');
    await expect(appTab.locator('span.truncate, span.flex-1').first()).toHaveClass(/truncate/);

    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertWorkbenchPanelsDoNotOverlap(page);
    await assertReachable(page.getByRole('button', { name: 'Refresh' }));
    await assertReachable(page.getByRole('button', { name: 'Collapse all folders' }));
    await assertReachable(appTab);
    await assertReachable(page.getByRole('button', { name: 'Close App.java' }));

    await captureViewport(
      page,
      `../docs/evidence/stage-2/${testInfo.project.name}-workbench-${viewport.name}.png`,
      viewport,
    );

    await expandDirectory(page, 'assets', 'assets');
    await openFile(page, 'logo.png', 'assets/logo.png', { content: false });
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(page.getByText('This file is binary and cannot be previewed')).toBeVisible();
    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertWorkbenchPanelsDoNotOverlap(page);
    await assertReachable(page.getByRole('button', { name: 'Download' }));
    await assertReachable(page.getByRole('button', { name: 'Refresh' }));
    await assertReachable(editorTab(page, /logo\.png/));
    await assertReachable(page.getByRole('button', { name: 'Close logo.png' }));

    await captureViewport(
      page,
      `../docs/evidence/stage-2/${testInfo.project.name}-blocked-${viewport.name}.png`,
      viewport,
    );
  });
}
