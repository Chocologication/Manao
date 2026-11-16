import { expect, test, type Page } from '@playwright/test';
import type * as Monaco from 'monaco-editor';
import { readFileSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { basename, join } from 'node:path';

type BrowserMonaco = Window & { monaco: typeof Monaco };
const projectId = process.env.MANAO_TAB_PROJECT_ID!;
const phase = process.env.MANAO_TAB_PHASE!;
const samples = [
  { file: 'TabCompletionSample.java', initial: 'class TabCompletionSample {\n    static int add(int a, int b) {\n        return;\n    }\n}\n', line: 3, column: 15 },
  { file: 'tab_completion_sample.py', initial: 'def add(a, b):\n    return\n', line: 2, column: 11 },
  { file: 'tab_completion_sample.ts', initial: 'function add(a: number, b: number): number {\n    return;\n}\n', line: 2, column: 11 },
];
const normalize = (text: string) => text.replace(/\r\n/g, '\n');
async function value(page: Page) {
  return page.evaluate(() => (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!.getModel()!.getValue());
}
async function openFile(page: Page, name: string) {
  const item = page.getByRole('treeitem', { name, exact: true });
  if (await item.count() === 0) {
    await page.getByRole('button', { name: '新建文件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建文件', exact: true });
    await dialog.getByRole('textbox', { name: '名称' }).fill(name);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
  }
  await item.click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const api = (window as unknown as BrowserMonaco).monaco;
    return api.editor.getEditors()[0]?.getOption(api.editor.EditorOption.readOnly);
  })).toBe(false);
}

test('real Java and DeepSeek: automatic completion, accept, undo, save, reopen and file switch', async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  const errors: { message: string; stack?: string; sources?: string[] }[] = [];
  const calls: { path: string; started: number; prefix: string; suffix: string }[] = [];
  page.on('pageerror', (error) => errors.push({ message: error.message, stack: error.stack }));
  page.on('request', (request) => {
    if (request.url().endsWith('/code-completions')) calls.push({ path: new URL(request.url()).pathname,
      started: Date.now(), ...request.postDataJSON() });
  });
  try {
    await page.goto('/login');
    await page.getByLabel('Username').fill(process.env.MANAO_TAB_USERNAME!);
    await page.getByLabel('Password').fill(process.env.MANAO_TAB_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.locator(`a[href="/projects/${projectId}"]`).click();
    await expect(page.getByRole('treeitem', { name: '.gitignore', exact: true })).toBeVisible();
    for (const sample of samples) {
      await openFile(page, sample.file);
      await expect(page.locator('.ghost-text-decoration, .ghost-text')).toHaveCount(0);
      await page.evaluate(({ initial, line, column }) => {
        const editor = (window as unknown as BrowserMonaco).monaco.editor.getEditors()[0]!;
        editor.getModel()!.setValue(initial); editor.setPosition({ lineNumber: line, column }); editor.focus();
      }, sample);
      const start = Date.now();
      const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/projects/${projectId}/code-completions`));
      await page.keyboard.type(' ');
      const response = await responsePromise;
      const requestMillis = Date.now() - start;
      expect(response.status()).toBe(200);
      const result = await response.json() as { completion: string | null };
      expect(result.completion).toBeTruthy();
      await expect.poll(async () => (await page.locator('.ghost-text-decoration, .ghost-text').allTextContents()).join('').replace(/\u00a0/g, ' '))
        .toMatch(/a\s*\+\s*b/);
      const ghostMillis = Date.now() - start;
      const before = await value(page);
      const requestsBeforeAccept = calls.length;
      await page.keyboard.press('Tab');
      await expect.poll(async () => normalize(await value(page))).toMatch(/return a\s*\+\s*b/);
      const accepted = await value(page);
      expect(accepted).not.toBe(before);
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
      await expect.poll(() => calls.length).toBeGreaterThan(requestsBeforeAccept);
      await page.keyboard.press('Control+z');
      await expect.poll(() => value(page)).toBe(before);
      await page.keyboard.press('Control+y');
      await expect.poll(() => value(page)).toBe(accepted);
      const savedPromise = page.waitForResponse((r) => r.url().includes('/files/content') && r.request().method() === 'PUT');
      await page.keyboard.press('Control+s');
      const saved = await savedPromise; expect(saved.status()).toBe(200);
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: `关闭 ${sample.file}` }).click();
      await openFile(page, sample.file);
      await expect.poll(() => value(page)).toBe(accepted);
      const persisted = await page.evaluate(async ({ id, file, authorization }) => {
        const readback = await fetch(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent(file)}`,
          { headers: { Authorization: authorization! } });
        if (!readback.ok) throw new Error(`Readback failed ${readback.status}`);
        return readback.json();
      }, { id: projectId, file: sample.file, authorization: saved.request().headers().authorization });
      expect(persisted.content).toBe(accepted);
      rows.push({ file: sample.file, status: 'PASS', requestMillis, ghostMillis, completion: result.completion,
        accepted: normalize(accepted), persisted: true, followUpObserved: true });
      console.info(`${phase} ${sample.file}: PASS, idle-to-ghost ${ghostMillis} ms`);
    }
  } finally {
    const maps = new Map<string, SourceMap>();
    for (const error of errors) {
      error.sources = [];
      for (const match of (error.stack ?? '').matchAll(/(https?:\/\/[^ )]+\.js(?:\?[^ ):]+)?):(\d+):(\d+)/g)) {
        if (match[1]!.includes('/assets/')) {
          if (!maps.has(match[1]!)) {
            const mapUrl = new URL(match[1]!); mapUrl.pathname += '.map';
            if (process.env.MANAO_TAB_SOURCE_MAP_ROOT) {
              // The operator supplies maps extracted from the same immutable
              // frontend image; diagnostics need no additional public request.
              const file = join(process.env.MANAO_TAB_SOURCE_MAP_ROOT, 'assets', basename(mapUrl.pathname));
              maps.set(match[1]!, new SourceMap(JSON.parse(readFileSync(file, 'utf8'))));
            } else {
              const response = await fetch(mapUrl, { signal: AbortSignal.timeout(10_000) });
              if (response.ok) maps.set(match[1]!, new SourceMap(await response.json()));
            }
          }
          const map = maps.get(match[1]!);
          if (map) {
            const source = map.findEntry(Number(match[2]) - 1, Number(match[3]) - 1);
            error.sources.push(`${source.originalSource}:${Number(source.originalLine) + 1}`);
          }
        }
      }
    }
    const unexpected = errors.filter((error) => !(error.message === 'Canceled'
      && ((error.stack?.includes('/base/common/async.js') && error.stack.includes('/runOnChange.js'))
        || error.sources?.some((source) => source.endsWith('/base/common/async.js:300'))
          && error.sources.some((source) => source.endsWith('/observableInternal/utils/runOnChange.js:45'))
        || error.sources?.[0]?.endsWith('/base/common/async.js:251')
          && error.sources.some((source) => source.endsWith('/wordHighlighter/browser/wordHighlighter.js:652')))));
    const evidence = { phase, origin: new URL(page.url()).origin, projectId, model: 'deepseek-flash',
      modelEvidence: 'Configured/requested model; product endpoint does not forward upstream model metadata',
      rows, requests: calls, pageErrors: errors, unexpectedPageErrors: unexpected.length,
      status: rows.length === samples.length && unexpected.length === 0 ? 'PASS' : 'FAILED' };
    if (process.env.MANAO_TAB_EVIDENCE_FILE) writeFileSync(process.env.MANAO_TAB_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    await test.info().attach('real-completion-evidence.json', { body: JSON.stringify(evidence), contentType: 'application/json' });
    expect(unexpected).toEqual([]);
  }
});
