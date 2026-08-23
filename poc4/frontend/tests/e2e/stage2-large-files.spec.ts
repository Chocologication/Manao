import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const NEAR_LIMIT_BYTES = 20 * 1024 * 1024 - 1;
const LARGE_NOTES_BYTES = 20 * 1024 * 1024 + 1;
const NEAR_LIMIT_PATH = 'src/main/java/demo/NearLimit.java';
const LARGE_NOTES_PATH = 'docs/large-notes.md';

test.describe.configure({ timeout: 120_000 });

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

async function openAliceWorkbench(page: Page): Promise<string> {
  await page.goto('/login');
  const accessToken = await signIn(page);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await rootTree;
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
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
  return { consoleErrors, pageErrors };
}

async function recordMeasurement(
  title: string,
  measurement: Record<string, unknown>,
): Promise<void> {
  const payload = { title, ...measurement };
  console.log(`LARGE_FILE_MEASUREMENT ${JSON.stringify(payload)}`);
  await test.info().attach('large-file-measurement', {
    body: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
}

test('loads a real 20 MiB - 1 Java file into writable Monaco', async ({ page }) => {
  const issues = collectPageIssues(page);
  const accessToken = await openAliceWorkbench(page);
  await enableLargeFileBodies(page, accessToken);
  await expandDirectory(page, 'src', 'src');
  await expandDirectory(page, 'main', 'src/main');
  await expandDirectory(page, 'java', 'src/main/java');
  await expandDirectory(page, 'demo', 'src/main/java/demo');

  const contentResponse = waitForFileApi(page, 'content', NEAR_LIMIT_PATH);
  const started = Date.now();
  await treeItem(page, 'NearLimit.java').click();
  const response = await contentResponse;
  const responseBytes = Number(response.headers()['content-length'] ?? 0);
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('NearLimit', {
    timeout: 90_000,
  });
  const viewerReadyMs = Date.now() - started;

  const model = await page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor?: {
            getModels?: () => Array<{
              uri: { toString(): string };
              getValueLength(): number;
              getLineContent(line: number): string;
            }>;
          };
        };
      }
    ).monaco;
    const match = monaco?.editor
      ?.getModels?.()
      .find((item) => item.uri.toString().includes('NearLimit.java'));
    if (match === undefined) {
      throw new Error('NearLimit.java model is missing');
    }
    return {
      length: match.getValueLength(),
      line1: match.getLineContent(1),
    };
  });
  expect(model.length).toBe(NEAR_LIMIT_BYTES);
  expect(model.line1).toContain('package demo');

  await editor.click();
  await page.getByRole('textbox', { name: 'Editor content' }).focus();
  await page.keyboard.type('X');
  const afterType = await page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor?: {
            getModels?: () => Array<{
              uri: { toString(): string };
              getValueLength(): number;
              getLineContent(line: number): string;
            }>;
          };
        };
      }
    ).monaco;
    const match = monaco?.editor
      ?.getModels?.()
      .find((item) => item.uri.toString().includes('NearLimit.java'));
    if (match === undefined) {
      throw new Error('NearLimit.java model is missing after type');
    }
    return {
      length: match.getValueLength(),
      line1: match.getLineContent(1),
    };
  });
  expect(afterType.length).toBe(NEAR_LIMIT_BYTES + 1);
  expect(afterType.length).toBeGreaterThan(model.length);
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name: /NearLimit\.java/ }),
  ).toContainText('*');

  await recordMeasurement('NearLimit.java', {
    path: NEAR_LIMIT_PATH,
    renderer: 'monaco',
    responseBytes,
    expectedContentBytes: NEAR_LIMIT_BYTES,
    viewerReadyMs,
    modelBytes: model.length,
    pageClosed: page.isClosed(),
    consoleErrors: issues.consoleErrors,
    pageErrors: issues.pageErrors,
  });
  expect(responseBytes).toBeGreaterThanOrEqual(NEAR_LIMIT_BYTES);
  expect(page.isClosed()).toBe(false);
});

test('loads a real 20 MiB + 1 Markdown file into the writable plain-text editor', async ({ page }) => {
  const issues = collectPageIssues(page);
  const accessToken = await openAliceWorkbench(page);
  await enableLargeFileBodies(page, accessToken);
  await expandDirectory(page, 'docs', 'docs');

  const contentResponse = waitForFileApi(page, 'content', LARGE_NOTES_PATH);
  const started = Date.now();
  await treeItem(page, 'large-notes.md').click();
  const response = await contentResponse;
  const responseBytes = Number(response.headers()['content-length'] ?? 0);
  const textarea = page.getByRole('textbox', { name: 'large-notes.md' });
  await expect(textarea).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Plain text')).toBeVisible();
  await expect(page.locator('[aria-label="Editor"] .monaco-editor')).toHaveCount(0);
  const snapshot = await textarea.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('plain viewer is not a textarea');
    }
    return {
      length: element.value.length,
      prefix: element.value.slice(0, 13),
      readOnly: element.readOnly,
    };
  });
  const viewerReadyMs = Date.now() - started;
  expect(snapshot.readOnly).toBe(false);
  expect(snapshot.length).toBe(LARGE_NOTES_BYTES);
  expect(snapshot.prefix).toBe('# Large notes');

  await textarea.focus();
  await page.keyboard.type('X');
  const afterType = await textarea.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('plain viewer is not a textarea');
    }
    return {
      length: element.value.length,
      prefix: element.value.slice(0, 13),
    };
  });
  expect(afterType.length).toBe(LARGE_NOTES_BYTES + 1);
  expect(afterType.prefix).not.toBe(snapshot.prefix);
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name: /large-notes\.md/ }),
  ).toContainText('*');

  await recordMeasurement('large-notes.md', {
    path: LARGE_NOTES_PATH,
    renderer: 'plain-text',
    responseBytes,
    expectedContentBytes: LARGE_NOTES_BYTES,
    viewerReadyMs,
    textareaBytes: snapshot.length,
    pageClosed: page.isClosed(),
    consoleErrors: issues.consoleErrors,
    pageErrors: issues.pageErrors,
  });
  expect(responseBytes).toBeGreaterThanOrEqual(LARGE_NOTES_BYTES);
  expect(page.isClosed()).toBe(false);
});
