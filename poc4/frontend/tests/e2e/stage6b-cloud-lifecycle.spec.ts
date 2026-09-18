import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Stage 6B: cloud lifecycle acceptance driven purely through the browser against
 * the public ingress (MANAO_6B_BASE_URL). One serial scene covers the 6A MVP
 * lifecycle: login, create, READY, editor save, failed run with compiler
 * feedback, fixed run with success output, edit-after-terminal-state, and
 * persistence across reload plus logout/login.
 *
 * Selector provenance (reused mature page operations, do not re-derive):
 * - login / logout / project card / create: stage1.spec.ts `signIn`,
 *   `createProject`, `projectCard`
 * - tree / editor tabs / Monaco view-lines assertions: stage2.spec.ts
 *   `treeItem`, `editorTab`, `waitForMonacoText`; stage3.spec.ts `saveButton`
 *   and the `p[role="status"][aria-label="Saved"]` save feedback
 * - run tab / Run state / Run logs / run history: stage6-real-backend.spec.ts
 *   test "MVP core loop: failed revision, corrected revision, and persistent
 *   history"
 *
 * API reads are corroboration only (revision change, token) and never replace
 * a UI assertion. Editing goes through the real Monaco editor model (dirty
 * state, Save button, PUT) so the save path stays on the UI. The project is
 * intentionally NOT deleted: Task 5 reuses it for restart persistence
 * verification, so deletion belongs to the Task 5 wrap-up.
 */

const BASE_URL = process.env.MANAO_6B_BASE_URL;
const USERNAME = process.env.MANAO_6B_USERNAME;
const PASSWORD = process.env.MANAO_6B_PASSWORD;

// Load-safe gate: other configs (e.g. the default localhost config, where
// MANAO_6B_BASE_URL is unset) also scan tests/e2e, so this file must never
// throw at module scope. The suite only skips when the 6B gate is entirely
// absent (no BASE_URL). If BASE_URL is set but credentials are missing, the
// tests still run and fail loudly in beforeAll — never a silent green run.
test.skip(
  !BASE_URL,
  'stage6b cloud lifecycle requires MANAO_6B_BASE_URL / MANAO_6B_USERNAME / MANAO_6B_PASSWORD; run via pnpm test:e2e:stage6b',
);

const APP_FILE_NAME = 'App.java';
const APP_FOLDERS = ['src', 'main', 'java', 'com', 'example', 'app'];
const CLASS_DECLARATION = 'public final class App {';
const GREETING_LINE = 'return "Hello from Manao";';
const BROKEN_LINE = 'return missingSymbol;';
const FIRST_EDIT_MARKER = '// stage6b-ui-edit';
const FINAL_EDIT_MARKER = '// stage6b-final-edit';
const SUCCESS_OUTPUT = 'Hello from Manao';
const COMPILE_ERROR_KEYWORDS = ['cannot find symbol', 'missingSymbol'];

function shortTimestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

// Shared scene state across the serial tests (workers: 1 guarantees ordering).
const SCENE = {
  projectName: `stage6b-cloud-${shortTimestamp()}-${randomSuffix()}`,
  projectId: '',
  accessToken: '',
  brokenRunId: '',
  fixedRunId: '',
  finalRevision: '',
};

test.describe.serial('stage6b cloud lifecycle', () => {
  // Runtime credential guard: reached only when MANAO_6B_BASE_URL is set
  // (module-level skip keeps the default config load-safe). A missing
  // credential must fail the run loudly, not silently skip to a green exit.
  test.beforeAll(() => {
    if (!USERNAME || !PASSWORD) {
      throw new Error(
        '环境变量 MANAO_6B_USERNAME / MANAO_6B_PASSWORD 未设置：'
          + 'MANAO_6B_BASE_URL 已配置时必须同时提供私有运行环境注入的真实凭据，'
          + 'Stage 6B 云端 E2E 拒绝在凭据缺失时静默跳过。',
      );
    }
  });

  test('login, create the marked project, and wait for READY', async ({ page }, testInfo) => {
    test.setTimeout(900_000); // cloud provisioning from a cold cluster may take minutes
    await signIn(page);
    await createProject(page, SCENE.projectName);
    const card = projectCard(page, SCENE.projectName);
    await expect(card.getByText('READY', { exact: true })).toBeVisible({ timeout: 600_000 });

    const open = card.getByRole('link', { name: 'Open' });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    SCENE.projectId = page.url().split('/').pop() ?? '';
    expect(SCENE.projectId, 'project id must be derivable from the project URL').not.toBe('');

    await expect(page.getByRole('heading', { name: SCENE.projectName })).toBeVisible();
    await expect(treeItem(page, '.gitignore')).toBeVisible();

    const handoff = JSON.stringify({ projectName: SCENE.projectName, projectId: SCENE.projectId });
    await testInfo.attach('stage6b-project.json', {
      body: Buffer.from(handoff),
      contentType: 'application/json',
    });
    console.log(`[stage6b] created project "${SCENE.projectName}" id=${SCENE.projectId}`);
  });

  test('edit App.java in the editor, save explicitly, and observe the revision advance', async ({ page }) => {
    await signIn(page);
    await openProject(page);
    await openAppFile(page);

    const revisionBefore = await workspaceRevision(page);
    await replaceInMonaco(page, CLASS_DECLARATION, `${CLASS_DECLARATION}\n    ${FIRST_EDIT_MARKER}`);
    await expect(monacoViewLines(page)).toContainText(FIRST_EDIT_MARKER);
    await expect(editorTab(page, new RegExp(APP_FILE_NAME))).toContainText('*');

    const saved = page.waitForResponse((response) => isContentPut(response, APP_FILE_PATH) && response.status() === 200);
    await saveButton(page).click();
    await saved;
    await expect(page.locator('p[role="status"][aria-label="Saved"]')).toBeVisible();
    await expect(editorTab(page, new RegExp(APP_FILE_NAME))).not.toContainText('*');

    // Corroboration only: the UI save above is the acceptance path.
    const revisionAfter = await workspaceRevision(page);
    expect(revisionAfter, 'workspace revision must advance after the UI save').not.toBe(revisionBefore);
  });

  test('save a reproducible compile error, run, and observe FAILED with compiler feedback', async ({ page }, testInfo) => {
    test.setTimeout(900_000); // a cloud Maven run may take several minutes from cold start
    await signIn(page);
    await openProject(page);
    await openAppFile(page);

    await replaceInMonaco(page, GREETING_LINE, BROKEN_LINE);
    await expect(monacoViewLines(page)).toContainText(BROKEN_LINE);
    const saved = page.waitForResponse((response) => isContentPut(response, APP_FILE_PATH) && response.status() === 200);
    await saveButton(page).click();
    await saved;
    await expect(page.locator('p[role="status"][aria-label="Saved"]')).toBeVisible();

    const runId = await startRunAndAwaitTerminalState(page, 'FAILED');
    SCENE.brokenRunId = runId;
    const logs = page.getByRole('region', { name: 'Run logs' });
    for (const keyword of COMPILE_ERROR_KEYWORDS) {
      await expect(logs).toContainText(keyword);
    }

    await testInfo.attach('stage6b-broken-run.json', {
      body: Buffer.from(JSON.stringify({ projectId: SCENE.projectId, runId, state: 'FAILED' })),
      contentType: 'application/json',
    });
    console.log(`[stage6b] broken run id=${runId} reached FAILED with compiler feedback`);
  });

  test('fix the code, save, run again, and observe SUCCEEDED with the expected output', async ({ page }, testInfo) => {
    test.setTimeout(900_000); // a cloud Maven run may take several minutes from cold start
    await signIn(page);
    await openProject(page);
    await openAppFile(page);

    await replaceInMonaco(page, BROKEN_LINE, GREETING_LINE);
    await expect(monacoViewLines(page)).toContainText(GREETING_LINE);
    const saved = page.waitForResponse((response) => isContentPut(response, APP_FILE_PATH) && response.status() === 200);
    await saveButton(page).click();
    await saved;
    await expect(page.locator('p[role="status"][aria-label="Saved"]')).toBeVisible();

    const runId = await startRunAndAwaitTerminalState(page, 'SUCCEEDED');
    SCENE.fixedRunId = runId;
    await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SUCCESS_OUTPUT);

    await testInfo.attach('stage6b-fixed-run.json', {
      body: Buffer.from(JSON.stringify({ projectId: SCENE.projectId, runId, state: 'SUCCEEDED' })),
      contentType: 'application/json',
    });
    console.log(`[stage6b] fixed run id=${runId} reached SUCCEEDED with "${SUCCESS_OUTPUT}" output`);
  });

  test('the project remains editable after a terminal run state', async ({ page }) => {
    await signIn(page);
    await openProject(page);
    await openAppFile(page);

    await replaceInMonaco(page, CLASS_DECLARATION, `${CLASS_DECLARATION}\n    ${FINAL_EDIT_MARKER}`);
    await expect(monacoViewLines(page)).toContainText(FINAL_EDIT_MARKER);
    const saved = page.waitForResponse((response) => isContentPut(response, APP_FILE_PATH) && response.status() === 200);
    await saveButton(page).click();
    await saved;
    await expect(page.locator('p[role="status"][aria-label="Saved"]')).toBeVisible();

    // Baseline for the persistence test: the revision after the final save.
    SCENE.finalRevision = await workspaceRevision(page);
  });

  test('reload, logout, and re-login all preserve project, file content, and run history', async ({ page }) => {
    await signIn(page);
    await openProject(page);

    // Reload: project, saved file content, and both terminal runs survive on the
    // server. The access token is deliberately memory-only (authSession never
    // writes localStorage/sessionStorage), so a reload lands on the login page;
    // re-authenticate and re-enter the project — the same reload pattern as the
    // stage4 persistence spec. What must persist is the server-side scene.
    await page.reload();
    await expect(page.getByLabel('Username')).toBeVisible();
    await signIn(page);
    await openProject(page);
    await openAppFile(page);
    await expect(monacoViewLines(page)).toContainText(FINAL_EDIT_MARKER);
    await assertRunHistoryPreserved(page);
    // Corroboration only: the revision stored before reload must still hold.
    expect(await workspaceRevision(page), 'reload must preserve the saved revision').toBe(SCENE.finalRevision);

    // Full session reset: logout, sign back in, and re-verify from the list.
    await page.getByRole('link', { name: 'Back to projects' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByLabel('Username')).toBeVisible();
    await signIn(page);
    await expect(projectCard(page, SCENE.projectName)).toBeVisible();
    await openProject(page);
    await openAppFile(page);
    await expect(monacoViewLines(page)).toContainText(FINAL_EDIT_MARKER);
    await assertRunHistoryPreserved(page);
    // Corroboration only: the revision must survive a full session reset too.
    expect(await workspaceRevision(page), 're-login must preserve the saved revision').toBe(SCENE.finalRevision);

    console.log(
      `[stage6b] persistence verified for project "${SCENE.projectName}" id=${SCENE.projectId}; `
        + `runs: broken=${SCENE.brokenRunId} fixed=${SCENE.fixedRunId}`,
    );
    console.log(
      `[stage6b] 保留项目 ${SCENE.projectName} (id=${SCENE.projectId}) 供 Task 5 持久化验证；`
        + '本测试不删除该项目，删除属于 Task 5 收尾。',
    );
  });
});

// ---------------------------------------------------------------------------
// Page operations reused from existing mature specs (see file header).
// ---------------------------------------------------------------------------

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

function monacoViewLines(page: Page): Locator {
  return page.locator('.monaco-editor .view-lines');
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(USERNAME!);
  await page.getByLabel('Password').fill(PASSWORD!);
  const loginResponse = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return pathname === '/api/v1/auth/login' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await loginResponse).json()) as { accessToken?: string };
  expect(typeof body.accessToken, 'login must issue an access token').toBe('string');
  SCENE.accessToken = body.accessToken!;
  await expect(page).toHaveURL(/\/projects$/);
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(projectCard(page, name)).toBeVisible();
}

async function openProject(page: Page): Promise<void> {
  const card = projectCard(page, SCENE.projectName);
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${SCENE.projectId}$`));
  await expect(page.getByRole('heading', { name: SCENE.projectName })).toBeVisible();
}

async function expandFolder(page: Page, name: string): Promise<void> {
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  if ((await item.getAttribute('aria-expanded')) !== 'true') {
    await item.click();
  }
}

async function openAppFile(page: Page): Promise<void> {
  for (const folder of APP_FOLDERS) {
    await expandFolder(page, folder);
  }
  const item = treeItem(page, APP_FILE_NAME);
  await expect(item).toBeVisible();
  await item.click();
  await expect(editorTab(page, new RegExp(APP_FILE_NAME))).toBeVisible();
  await expect(monacoViewLines(page)).toContainText('class App');
}

/**
 * Edits through the real Monaco editor model so the dirty tab, Save button,
 * and save-status feedback stay on the UI path (stage2/3 spec pattern).
 */
async function replaceInMonaco(page: Page, oldFragment: string, newFragment: string): Promise<void> {
  await page.evaluate(({ oldFragment, newFragment }) => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor?: {
            getModels?: () => Array<{ getValue: () => string; setValue: (value: string) => void }>;
          };
        };
      }
    ).monaco;
    const model = monaco?.editor?.getModels?.().find((candidate) => candidate.getValue().includes(oldFragment));
    if (model === undefined) {
      throw new Error('no open Monaco model contains the target fragment; open App.java first');
    }
    const next = model.getValue().replace(oldFragment, newFragment);
    if (next === model.getValue()) {
      throw new Error('Monaco replace produced no change; check the target fragment');
    }
    model.setValue(next);
  }, { oldFragment, newFragment });
}

async function startRunAndAwaitTerminalState(
  page: Page,
  expectedState: 'FAILED' | 'SUCCEEDED',
): Promise<string> {
  await page.getByRole('tab', { name: 'Run' }).click();
  const start = page.getByRole('button', { name: 'Start run' });
  await expect(start).toBeEnabled();
  await start.click();
  const runState = page.getByRole('status', { name: 'Run state' });
  await expect(runState).toBeVisible();
  await expect(runState).toContainText(expectedState, { timeout: 780_000 });

  // Latest history entry carries the id of the run that just finished.
  const latest = page.locator('aside[aria-label="Recent runs"] ul button[data-run-id]').first();
  await expect(latest).toBeVisible();
  const runId = await latest.getAttribute('data-run-id');
  expect(runId, 'run history must expose the finished run id').toBeTruthy();
  return runId!;
}

async function assertRunHistoryPreserved(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click();
  const history = page.locator('aside[aria-label="Recent runs"] ul button[data-run-id]');
  await expect(history).toHaveCount(2);
  const ids = await history.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-run-id')));
  expect(ids).toContain(SCENE.brokenRunId);
  expect(ids).toContain(SCENE.fixedRunId);
  const fixedEntry = page.locator(`aside[aria-label="Recent runs"] ul button[data-run-id="${SCENE.fixedRunId}"]`);
  await fixedEntry.click();
  await expect(page.getByRole('status', { name: 'Run state' })).toContainText('SUCCEEDED');
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SUCCESS_OUTPUT);
}

// ---------------------------------------------------------------------------
// API corroboration helpers (never replace a UI assertion).
// ---------------------------------------------------------------------------

const APP_FILE_PATH = 'src/main/java/com/example/app/App.java';

function isContentPut(
  response: { request(): { method(): string; url(): string } },
  path: string,
): boolean {
  if (response.request().method() !== 'PUT') {
    return false;
  }
  const url = new URL(response.request().url());
  return (
    url.pathname === `/api/v1/projects/${SCENE.projectId}/files/content`
    && url.searchParams.get('path') === path
  );
}

async function workspaceRevision(page: Page): Promise<string> {
  const response = await page.request.get(`/api/v1/projects/${SCENE.projectId}/files/tree?path=`, {
    headers: { Authorization: `Bearer ${SCENE.accessToken}` },
  });
  expect(response.ok(), 'workspace revision corroboration must succeed').toBeTruthy();
  const body = (await response.json()) as { workspaceRevision?: string };
  expect(typeof body.workspaceRevision).toBe('string');
  return body.workspaceRevision!;
}
