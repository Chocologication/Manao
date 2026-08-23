import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const LARGE_NOTES_BYTES = 20 * 1024 * 1024 + 1;
const LARGE_NOTES_PATH = 'docs/large-notes.md';
const SUFFIX = '\nE2E_LARGE_WRITE\n';

test.describe.configure({ timeout: 180_000 });

type FileResource = 'tree' | 'meta' | 'content';

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

function treeItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
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

function waitForFileApi(page: Page, resource: FileResource, path: string, status = 200): Promise<Response> {
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

async function signIn(page: Page): Promise<string> {
  const loginResponse = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return pathname === '/api/v1/auth/login' && response.request().method() === 'POST';
  });
  await page.getByLabel('Username').fill(ALICE.username);
  await page.getByLabel('Password').fill(ALICE.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await loginResponse).json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  expect(body.accessToken?.length).toBeGreaterThan(0);
  return body.accessToken as string;
}

async function openAliceWorkbench(page: Page): Promise<{ accessToken: string; workspaceRevision: string }> {
  await page.goto('/login');
  const accessToken = await signIn(page);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  const treeResponse = await rootTree;
  const treeBody = (await treeResponse.json()) as { workspaceRevision?: string };
  expect(typeof treeBody.workspaceRevision).toBe('string');
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
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

async function enableLargeFileBodies(page: Page, accessToken: string): Promise<void> {
  const status = await page.evaluate(async (token) => {
    const response = await fetch('/api/v1/session/large-files', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    return response.status;
  }, accessToken);
  expect(status).toBe(204);
}

function collectPageIssues(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('crash', () => {
    pageErrors.push('page crashed');
  });
  return { consoleErrors, pageErrors };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function appendPlainTextSuffix(page: Page, suffix: string): Promise<void> {
  const textarea = page.getByRole('textbox', { name: 'large-notes.md' });
  await textarea.evaluate((element, next) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('plain viewer is not a textarea');
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (descriptor?.set === undefined) {
      throw new Error('textarea value setter is missing');
    }
    descriptor.set.call(element, `${element.value}${next}`);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, suffix);
}

async function recordMeasurement(
  title: string,
  measurement: Record<string, unknown>,
): Promise<void> {
  const payload = { title, ...measurement };
  console.log(`LARGE_WRITE_MEASUREMENT ${JSON.stringify(payload)}`);
  await test.info().attach('large-write-measurement', {
    body: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
}

test('writes a real 20 MiB + 1 Markdown file through the plain-text editor', async ({ page }) => {
  const issues = collectPageIssues(page);
  const { accessToken, workspaceRevision } = await openAliceWorkbench(page);
  await enableLargeFileBodies(page, accessToken);
  await expandDirectory(page, 'docs', 'docs');

  const contentResponse = waitForFileApi(page, 'content', LARGE_NOTES_PATH);
  const clickStarted = Date.now();
  await treeItem(page, 'large-notes.md').click();
  const getResponse = await contentResponse;
  const getBytes = Number(getResponse.headers()['content-length'] ?? 0);
  const textarea = page.getByRole('textbox', { name: 'large-notes.md' });
  await expect(textarea).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Plain text')).toBeVisible();
  await expect(page.locator('[aria-label="Editor"] .monaco-editor')).toHaveCount(0);
  const opened = await textarea.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('plain viewer is not a textarea');
    }
    return {
      length: element.value.length,
      prefix: element.value.slice(0, 13),
      readOnly: element.readOnly,
    };
  });
  const clickToReadyMs = Date.now() - clickStarted;
  expect(opened.readOnly).toBe(false);
  expect(opened.length).toBe(LARGE_NOTES_BYTES);
  expect(opened.prefix).toBe('# Large notes');
  expect(getBytes).toBeGreaterThanOrEqual(LARGE_NOTES_BYTES);

  await appendPlainTextSuffix(page, SUFFIX);
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name: /large-notes\.md/ }),
  ).toContainText('*');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await page.getByRole('treeitem', { name: 'pom.xml', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name: /large-notes\.md/ }).click();
  await expect(textarea).toBeVisible({ timeout: 90_000 });
  const afterSwitch = await textarea.evaluate((element, suffix) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('plain viewer is not a textarea');
    }
    return {
      length: element.value.length,
      suffix: element.value.slice(-suffix.length),
    };
  }, SUFFIX);
  expect(afterSwitch.length).toBe(LARGE_NOTES_BYTES + SUFFIX.length);
  expect(afterSwitch.suffix).toBe(SUFFIX);

  const expectedContentBytes = LARGE_NOTES_BYTES + utf8ByteLength(SUFFIX);
  await page.evaluate(() => {
    const host = window as unknown as {
      fetch: typeof fetch;
      __e2ePut?: {
        requestUtf8Bytes: number;
        contentUtf8Bytes: number;
        expectedWorkspaceRevision: string | null;
        suffix: string;
      };
    };
    const original = host.fetch.bind(window);
    host.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'PUT' && url.includes('/files/content') && typeof init?.body === 'string') {
        const body = init.body;
        const parsed = JSON.parse(body) as {
          content?: string;
          expectedWorkspaceRevision?: string;
        };
        const content = typeof parsed.content === 'string' ? parsed.content : '';
        host.__e2ePut = {
          requestUtf8Bytes: new TextEncoder().encode(body).byteLength,
          contentUtf8Bytes: new TextEncoder().encode(content).byteLength,
          expectedWorkspaceRevision: parsed.expectedWorkspaceRevision ?? null,
          suffix: content.slice(-17),
        };
      }
      return original(input, init);
    };
  });
  const putRequest = page.waitForRequest((request) => {
    const parsed = parseProjectFileApi(request.url());
    return (
      request.method() === 'PUT' &&
      parsed !== null &&
      parsed.resource === 'content' &&
      parsed.path === LARGE_NOTES_PATH
    );
  });
  const putResponse = page.waitForResponse((response) => {
    const parsed = parseProjectFileApi(response.url());
    return (
      response.request().method() === 'PUT' &&
      parsed !== null &&
      parsed.resource === 'content' &&
      parsed.path === LARGE_NOTES_PATH
    );
  });
  const saveStarted = Date.now();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const request = await putRequest;
  const response = await putResponse;
  const saveStartToResponseMs = Date.now() - saveStarted;
  expect(page.isClosed()).toBe(false);
  expect(response.status()).toBe(200);
  const putProbe = await page.evaluate(() => {
    return (
      (window as unknown as {
        __e2ePut?: {
          requestUtf8Bytes: number;
          contentUtf8Bytes: number;
          expectedWorkspaceRevision: string | null;
          suffix: string;
        };
      }).__e2ePut ?? null
    );
  });
  expect(putProbe).not.toBeNull();
  expect(putProbe?.expectedWorkspaceRevision).toBe(workspaceRevision);
  expect(putProbe?.suffix).toBe(SUFFIX);
  expect(putProbe?.contentUtf8Bytes).toBe(expectedContentBytes);
  expect(putProbe?.requestUtf8Bytes).toBeGreaterThan(expectedContentBytes);
  const requestUtf8Bytes = putProbe?.requestUtf8Bytes ?? 0;

  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name: /large-notes\.md/ }),
  ).not.toContainText('*');

  const persisted = await page.evaluate(
    async ({ token, projectId, path, suffix }) => {
      const refetch = await fetch(`/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = (await refetch.json()) as { content?: string; workspaceRevision?: string };
      return {
        status: refetch.status,
        length: typeof body.content === 'string' ? body.content.length : -1,
        suffix: typeof body.content === 'string' ? body.content.slice(-suffix.length) : '',
        workspaceRevision: body.workspaceRevision ?? null,
      };
    },
    { token: accessToken, projectId: ALICE_SEED_PROJECT_ID, path: LARGE_NOTES_PATH, suffix: SUFFIX },
  );
  expect(persisted.status).toBe(200);
  expect(persisted.length).toBe(LARGE_NOTES_BYTES + SUFFIX.length);
  expect(persisted.suffix).toBe(SUFFIX);
  expect(typeof persisted.workspaceRevision).toBe('string');
  expect(persisted.workspaceRevision).not.toBe(workspaceRevision);
  expect((persisted.workspaceRevision ?? '').length).toBeGreaterThan(0);

  await recordMeasurement('large-notes.md write', {
    path: LARGE_NOTES_PATH,
    renderer: 'plain-text',
    getResponseBytes: getBytes,
    expectedContentBytes,
    requestUtf8Bytes,
    contentUtf8Bytes: expectedContentBytes,
    clickToReadyMs,
    saveStartToResponseMs,
    pageClosed: page.isClosed(),
    consoleErrors: issues.consoleErrors,
    pageErrors: issues.pageErrors,
  });
  expect(page.isClosed()).toBe(false);
  expect(issues.pageErrors).toEqual([]);
});
