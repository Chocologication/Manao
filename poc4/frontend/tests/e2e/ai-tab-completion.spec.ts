import { expect, test, type Page } from '@playwright/test';
import type * as Monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';

const projectId = 'prj-alice-notebook';
const fixture = '// __manao_tab_fixture__\nfunction add(a, b) {\n    return ';
const ghost = (page: Page) => page.locator('.ghost-text-decoration, .ghost-text');
type BrowserMonaco = Window & { monaco: typeof Monaco };

function mappedSources(stack = '') {
  return [...stack.matchAll(/http:\/\/127\.0\.0\.1:4173\/(assets\/[\w.-]+\.js):(\d+):(\d+)/g)].map((match) => {
    const map = new SourceMap(JSON.parse(readFileSync(new URL(`../../dist/${match[1]}.map`, import.meta.url), 'utf8')));
    const entry = map.findEntry(Number(match[2]) - 1, Number(match[3]) - 1);
    return `${entry.originalSource}:${Number(entry.originalLine) + 1}`;
  });
}

function isExistingCanceled(error: { message: string; sources: string[] }) {
  return error.message === 'Canceled'
    && error.sources[0]?.endsWith('/monaco-editor/esm/vs/base/common/async.js:300')
    && error.sources.some((source) => source.endsWith('/base/common/cancellation.js:45'))
    && error.sources.some((source) => source.endsWith('/observableInternal/utils/runOnChange.js:45'));
}

async function expectGhost(page: Page, text: string) {
  // Syntax highlighting splits a suggestion across multiple spans in Java/TS.
  await expect.poll(async () => (await ghost(page).allTextContents()).join('').replace(/\u00a0/g, ' ')).toContain(text);
}

async function value(page: Page) {
  const text = await page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.getModel()!.getValue());
  return text.replace(/\r\n/g, '\n');
}
async function typeContext(page: Page, context = fixture) {
  const input = page.getByRole('textbox', { name: '编辑器内容', exact: true });
  await input.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(context.slice(0, -1));
  await page.keyboard.type(context.slice(-1));
}
async function createFile(page: Page, name: string) {
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建文件', exact: true });
  await dialog.getByRole('textbox', { name: '名称' }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  // Monaco's native EditContext is a zero-sized focus target in Chromium.
  await expect(page.getByRole('textbox', { name: '编辑器内容', exact: true })).toBeAttached();
}
async function save(page: Page) {
  const saved = page.waitForResponse((response) => response.url().includes('/files/content')
    && response.request().method() === 'PUT' && response.status() === 200);
  await page.getByRole('textbox', { name: '编辑器内容', exact: true }).focus();
  await page.keyboard.press('Control+s');
  const response = await saved;
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  return response;
}

test.beforeEach(async ({ page }) => {
  const errors: { message: string; stack?: string }[] = [];
  page.on('pageerror', (error) => errors.push({ message: error.message, stack: error.stack }));
  // Retain the precise pre-existing Canceled stack; every other page error fails.
  test.info().annotations.push({ type: 'pageerrors', description: 'Captured in pageerrors.json, including existing Canceled' });
  (page as Page & { completionErrors?: typeof errors }).completionErrors = errors;
  await page.goto('/login');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('article', { name: 'Alice Notebook' }).getByRole('link', { name: '进入工作台' }).click();
  await expect(page.getByRole('treeitem', { name: '.gitignore', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const errors = (page as Page & { completionErrors?: { message: string; stack?: string }[] }).completionErrors ?? [];
  const mapped = errors.map((error) => ({ ...error, sources: mappedSources(error.stack) }));
  await test.info().attach('pageerrors.json', { body: JSON.stringify(mapped, null, 2), contentType: 'application/json' });
  // No production error handler is changed. Only this previously recorded,
  // non-blocking cancellation path is classified separately by the test.
  expect(mapped.filter((error) => !isExistingCanceled(error))).toEqual([]);
});

for (const [name, context] of [
  ['Add.java', '// __manao_tab_fixture__\nclass Add { int add(int a, int b) { return '],
  ['add.py', '# __manao_tab_fixture__\ndef add(a, b):\n    return '],
  ['add.ts', fixture],
]) {
  test(`${name}: automatic idle suggestion, Tab, Undo, dirty, save and reopen`, async ({ page }) => {
    await createFile(page, name!);
    const requests: { prefix: string; suffix: string }[] = [];
    page.on('request', (request) => { if (request.url().endsWith('/code-completions')) requests.push(request.postDataJSON()); });
    await typeContext(page, context);
    await expectGhost(page, 'a + b');
    expect(requests.some((request) => request.prefix.replace(/\r\n/g, '\n') === context && request.suffix === '')).toBe(true);
    await page.keyboard.press('Tab');
    await expect.poll(() => value(page)).toBe(context + 'a + b');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expect.poll(() => requests.some((request) => request.prefix.endsWith('a + b'))).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(() => value(page)).toBe(context);
    // Re-type the final space to obtain a new automatic suggestion after Undo.
    await page.keyboard.press('Backspace'); await page.keyboard.type(' ');
    await expectGhost(page, 'a + b'); await page.keyboard.press('Tab');
    const saved = await save(page);
    await page.getByRole('button', { name: `关闭 ${name}` }).click();
    await page.getByRole('treeitem', { name, exact: true }).click();
    await expect.poll(() => value(page)).toBe(context + 'a + b');
    const persisted = await page.evaluate(async ({ id, path, authorization }) => {
      const response = await fetch(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent(path!)}`,
        { headers: { Authorization: authorization! } });
      if (!response.ok) throw new Error(`Readback failed: ${response.status}`);
      return response.json();
    }, { id: projectId, path: name, authorization: saved.request().headers().authorization });
    expect(persisted.content.replace(/\r\n/g, '\n')).toBe(context + 'a + b');
  });
}

test('Esc cancels displayed and in-flight suggestions; typing, Tab indentation and saving still work', async ({ page }) => {
  await createFile(page, 'escape.py');
  await typeContext(page, '# __manao_tab_fixture__\ndef add(a,b):\n    return ');
  await expectGhost(page, 'a + b');
  const before = await value(page); await page.keyboard.press('Escape');
  await expect(ghost(page)).toHaveCount(0); expect(await value(page)).toBe(before);
  const request = page.waitForRequest((r) => r.url().endsWith('/code-completions') && r.postData()?.includes('__manao_tab_slow__') === true);
  await typeContext(page, '# __manao_tab_slow__\ndef add(a,b):\n    return '); await request;
  await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
  await expect(ghost(page)).toHaveCount(0); expect(await value(page)).toContain('return ');
  await typeContext(page, '# __manao_tab_error__\ndef add(a,b):\n    return ');
  await page.waitForTimeout(1200); await expect(ghost(page)).toHaveCount(0);
  await typeContext(page, '# no suggestion\n'); await page.keyboard.press('Tab');
  expect(await value(page)).toMatch(/# no suggestion\n\s+$/);
  await save(page);
});

test('late responses cannot cross file/language switches and writable restoration works', async ({ page }) => {
  await createFile(page, 'old.py');
  const request = page.waitForRequest((r) => r.url().endsWith('/code-completions') && r.postData()?.includes('__manao_tab_slow__') === true);
  await typeContext(page, '# __manao_tab_slow__\ndef add(a,b):\n    return '); await request;
  await createFile(page, 'new.ts'); await page.waitForTimeout(1000);
  await expect(ghost(page)).toHaveCount(0); expect(await value(page)).toBe('');
  await typeContext(page); await expectGhost(page, 'a + b');
  await page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.updateOptions({ readOnly: true }));
  await expect(ghost(page)).toHaveCount(0);
  await page.waitForTimeout(700); await expect(ghost(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.updateOptions({ readOnly: false }));
  const pending = page.waitForRequest((r) => r.url().endsWith('/code-completions') && r.postData()?.includes('__manao_tab_slow__') === true);
  await typeContext(page, '// __manao_tab_slow__\nfunction add(a,b) {\n    return '); await pending;
  await page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.updateOptions({ readOnly: true }));
  await page.waitForTimeout(1000); await expect(ghost(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.updateOptions({ readOnly: false }));
  await typeContext(page); await expectGhost(page, 'a + b');
  await page.keyboard.press('Tab'); await save(page);
});

test('keeps valid multiline suggestions and coexists with the local suggestions menu', async ({ page }) => {
  await createFile(page, 'multi.ts');
  await typeContext(page, '// __manao_tab_multiline__\nfunction add(a,b) {\n ');
  await expectGhost(page, 'const total');
  await page.keyboard.press('Tab'); expect(await value(page)).toContain('return total;');
  await typeContext(page, 'const localVariable = 1;\nlocalVariabl ');
  await page.keyboard.press('Backspace'); await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget.visible')).toBeVisible();
  await page.keyboard.press('Escape'); await save(page);
});

test('logout disposes pending completion and leaves no suggestion on the login page', async ({ page }) => {
  await createFile(page, 'logout.py');
  await typeContext(page, '# __manao_tab_slow__\ndef add(a,b):\n    return ');
  await save(page);
  const request = page.waitForRequest((r) => r.url().endsWith('/code-completions'));
  await page.keyboard.press('Backspace'); await page.keyboard.type(' '); await request;
  await page.getByRole('button', { name: '退出登录' }).click();
  const dialog = page.getByRole('dialog', { name: '有未保存的修改' });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '放弃修改' }).click();
  await expect(page).toHaveURL(/\/login$/); await page.waitForTimeout(1000);
  await expect(ghost(page)).toHaveCount(0);
});

test('the same prefix in another project makes a new scoped request without a cached suggestion', async ({ page }) => {
  await createFile(page, 'cross.py');
  const context = '# __manao_tab_slow__\ndef add(a,b):\n    return ';
  await typeContext(page, context); const saved = await save(page);
  const secondId = await page.evaluate(async (authorization) => {
    const headers = { Authorization: authorization!, 'Content-Type': 'application/json' };
    const created = await fetch('/api/v1/projects', { method: 'POST', headers,
      body: JSON.stringify({ name: 'Completion Other Project', templateId: 'python-console' }) });
    if (created.status !== 201) throw new Error(`Project fixture failed: ${created.status}`);
    const project = await created.json();
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`/api/v1/projects/${project.id}`, { headers });
      if (!response.ok) throw new Error('Project fixture lookup failed');
    }
    return project.id as string;
  }, saved.request().headers().authorization);
  const old = page.waitForRequest((r) => r.url().endsWith('/code-completions'));
  await page.keyboard.press('Home'); await page.keyboard.press('End'); await old;
  await page.getByRole('link', { name: '返回项目列表' }).click();
  await page.getByRole('article', { name: 'Completion Other Project' }).getByRole('link', { name: '进入工作台' }).click();
  await createFile(page, 'cross.py');
  await expect(ghost(page)).toHaveCount(0); expect(await value(page)).toBe('');
  const scoped = page.waitForRequest((r) => r.url().endsWith(`/projects/${secondId}/code-completions`));
  await typeContext(page, context);
  const request = await scoped;
  expect(request.postDataJSON().prefix.replace(/\r\n/g, '\n')).toBe(context);
  await expectGhost(page, 'a + b'); await page.keyboard.press('Tab');
  expect(await value(page)).toBe(context + 'a + b'); await save(page);
});
