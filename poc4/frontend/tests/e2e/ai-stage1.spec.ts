import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * AI stage one: real coding-and-repair-loop acceptance, driven through the browser
 * against the dedicated acceptance deployment (pi-stage1 plan Task 6; run via
 * pnpm test:e2e:ai-stage1).
 *
 * The scene is authored for the REAL loop and never substitutes mocks for it:
 * a dedicated project was bootstrapped with a locateable compile error in
 * DemoController and the verbatim acceptance fixture test; the operator started the
 * acceptance backend with MANAO_AI_PROJECT_ID=<bootstrap id> and a REAL provider
 * configuration on the worker. This spec submits the agreed natural-language goal,
 * watches the task settle, and asserts the browser-observable evidence:
 *   - ordinary writes and Run starts are refused while the task occupies (409
 *     AI_TASK_ACTIVE), and writes work again after it settles;
 *   - a full reload mid-task keeps the SAME task id (no duplicate task);
 *   - the settled task reports a final revision past the initial one, changedPaths
 *     include the repaired controller, the file really carries the target message,
 *     and the fixture test file is byte-identical (sha256 unchanged - Pi weakened
 *     or deleted nothing);
 *   - the observed tool sequence has the repair-loop shape (a build ran before the
 *     first write - the failing confirmation; a build ran after the last write -
 *     the verification) WITHOUT hardcoding tool call ids or any fixed tool order:
 *     Pi decides how it works;
 *   - the editor really shows the repaired source.
 *
 * Evidence boundary (deliberate): build exit codes, development Job/Pod cleanup
 * confirmations and the successful build's Surefire XML live in the backend's
 * durable tool ledger and logs, behind the internal token chain a browser JWT can
 * never cross. This spec asserts everything the browser can see and ATTACHES it,
 * but the acceptance verdict additionally REQUIRES two operator-run verification
 * steps against the same taskId (they are part of the round, not optional
 * corroboration — deploy README section 7 steps 4–5):
 *   - scripts/ai-stage1-verify-ledger.mjs: read-only DB check of the durable
 *     ledger — first build real non-zero exit, receipted DemoController write,
 *     later goal=test build exit 0 with cleanupConfirmed and Job identity, and
 *     the acceptance test's Surefire report tests>=1 / failures=errors=skipped=0
 *     (missing report or reportsDropped fails; COMPLETED alone proves nothing
 *     about test success);
 *   - scripts/ai-stage1-independent-reverify.mjs: the independent acceptance
 *     build over the SAVED source through the same read-only-copy executor path
 *     (manao-dev-build copy + operator pom overlay on the scratch + run test
 *     with no /source mount), asserting the Surefire report from the fixed
 *     log-tail markers.
 *
 * Selector provenance (reused mature page operations, do not re-derive):
 * - login: java-runtime-lifecycle.spec.ts signIn (token from the login response,
 *   because page.request does not attach localStorage tokens)
 * - file tree / editor: stage2.spec.ts treeitem click + .monaco-editor .view-lines
 * - AI panel: AgentTaskPanel.tsx ("Task goal" textarea, "Start task" button,
 *   disabled while occupying) behind the WorkbenchShell "AI" tab (VITE_ENABLE_AI)
 */

const BASE_URL = process.env.MANAO_AI_ACCEPTANCE_BASE_URL;
const USERNAME = process.env.MANAO_AI_ACCEPTANCE_USERNAME;
const PASSWORD = process.env.MANAO_AI_ACCEPTANCE_PASSWORD;
const PROJECT_ID = process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID;

// The exact goal the acceptance round agreed on (pi-stage1 plan Task 6, verbatim).
const TASK_PROMPT =
  '先执行测试确认当前错误；修复项目，并让 /api/demo 的 message 为 Hello from Pi；'
  + '保留现有验收测试，重新运行测试并报告结果。';
const TARGET_MESSAGE = 'Hello from Pi';
const SEEDED_ERROR = 'Instant.nwo()';
const DEMO_FILE = 'src/main/java/com/example/app/DemoController.java';
const FIXTURE_FILE = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';
// Recorded digest of the committed fixture (Task 6 evidence; .gitattributes keeps
// the checkout byte-identical). The spec refuses to run against drifted bytes.
const RECORDED_FIXTURE_SHA256 = '78ffdfc166210ca204e0e1a2e23d36b9148f293fdc134ce4c6791ab57714bf84';
// The committed fixture is the single source of truth for the expected bytes; it is
// read once here because it ships with this spec in the same commit.
const FIXTURE_BYTES = readFileSync(
  fileURLToPath(new URL('../fixtures/ai-stage1/DemoControllerAcceptanceTest.java', import.meta.url)),
);
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE_BYTES).digest('hex');
const FIXTURE_CONTENT = FIXTURE_BYTES.toString('utf8');
// Stage task wall-clock budget is 1800s; the settle wait adds collection slack.
const SETTLE_TIMEOUT = 2_400_000;
const SETTLE_POLL_MS = 15_000;
// Occupying states, mirroring AgentTaskSnapshot.isAgentTaskOccupying.
const OCCUPYING = new Set(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION']);

// Load-safe gate: other configs (e.g. the default localhost config, where
// MANAO_AI_ACCEPTANCE_BASE_URL is unset) also scan tests/e2e, so this file must
// never throw at module scope for missing environment. The ai-stage1 config itself
// throws on a missing base URL (fail fast), so the skip below only ever fires for
// other configs' collection - the acceptance run itself can never skip silently.
test.skip(
  !BASE_URL,
  'AI stage-one acceptance requires MANAO_AI_ACCEPTANCE_BASE_URL plus credentials and the '
    + 'bootstrap-recorded project id; run via pnpm test:e2e:ai-stage1',
);

type TaskSnapshotLike = {
  taskId: string;
  state: string;
  workspaceRevision: string;
  writesLocked: boolean;
  progress: Array<{ seq: number; kind: string; text: string; truncated: boolean }>;
  changedPaths: string[];
  summary: string | null;
  failureCode: string | null;
};

// Shared scene state across the serial tests (workers: 1 guarantees ordering).
const SCENE = {
  projectId: '',
  accessToken: '',
  taskId: '',
  initialRevision: '',
  initialDemoContent: '',
  submitAt: '',
  settledAt: '',
};

test.describe.serial('AI stage one coding and repair loop', () => {
  // Runtime configuration guard: reached only when BASE_URL is set. Missing
  // credentials, the project id, or a drifted fixture must fail the run loudly,
  // never silently skip to a green exit.
  test.beforeAll(() => {
    if (!USERNAME || !PASSWORD || !PROJECT_ID) {
      throw new Error(
        '环境变量 MANAO_AI_ACCEPTANCE_USERNAME / MANAO_AI_ACCEPTANCE_PASSWORD / '
          + 'MANAO_AI_ACCEPTANCE_PROJECT_ID 未设置：BASE_URL 已配置时必须同时提供真实'
          + '凭据和 bootstrap 记录的专用项目 ID，验收拒绝在配置缺失时静默跳过。',
      );
    }
    if (FIXTURE_SHA256 !== RECORDED_FIXTURE_SHA256) {
      throw new Error(
        `验收 fixture 的本地 sha256 (${FIXTURE_SHA256}) 与记录值 (${RECORDED_FIXTURE_SHA256}) `
          + '不一致：检出内容发生了漂移，拒绝在未知 fixture 上运行验收。',
      );
    }
    SCENE.projectId = PROJECT_ID;
    SCENE.submitAt = new Date().toISOString();
    console.log(
      `[ai-stage1] entry=${BASE_URL} project=${SCENE.projectId} fixture=${FIXTURE_SHA256.slice(0, 12)}`,
    );
  });

  test('accept the bootstrapped project and verify the AI workbench', async ({ page }) => {
    await openProject(page);

    // The workbench loaded: the repaired controller's tree entry is visible, and the
    // deployment was built with the AI stage on (VITE_ENABLE_AI=true). A missing AI
    // tab means this entry is not the prepared acceptance deployment - refuse loudly.
    await revealInTree(page, DEMO_FILE);
    const aiTab = page.getByRole('tab', { name: 'AI' });
    if (!(await aiTab.isVisible())) {
      throw new Error(
        '工作台没有 AI 标签页：验收前端必须以 VITE_ENABLE_AI=true 构建，'
          + '当前入口不是 AI 验收部署，拒绝继续。',
      );
    }

    // Owner/READY/no-Run corroboration through the same-origin API: the project is
    // readable by this owner, no task occupies it, and no run is active.
    expect(await currentTaskOrNull(page), 'the project must not be occupied at acceptance start')
      .toBeNull();
    const activeRun = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/runs/active`);
    expect(activeRun.ok(), 'active-run check must succeed').toBeTruthy();
    expect(((await activeRun.json()) as { run: unknown }).run, 'no run may be active').toBeNull();

    // Inputs sanity: the bootstrap really seeded the broken controller and the
    // verbatim fixture, and the initial revision is captured for the final compare.
    const tree = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/files/tree`);
    expect(tree.ok(), 'workspace tree must be readable').toBeTruthy();
    SCENE.initialRevision =
      ((await tree.json()) as { workspaceRevision: string }).workspaceRevision;
    expect(SCENE.initialRevision, 'initial revision must be present').not.toBe('');
    SCENE.initialDemoContent = (await fileContent(page, DEMO_FILE)).content;
    expect(
      SCENE.initialDemoContent.includes(SEEDED_ERROR),
      'bootstrap must have seeded the locateable compile error in DemoController',
    ).toBe(true);
    expect(
      SCENE.initialDemoContent.includes(TARGET_MESSAGE),
      'the broken source must not already carry the target message',
    ).toBe(false);
    const seededFixture = (await fileContent(page, FIXTURE_FILE)).content;
    expect(seededFixture, 'the fixture must be seeded byte-for-byte').toBe(FIXTURE_CONTENT);
    console.log(`[ai-stage1] initialRevision=${SCENE.initialRevision} inputs verified`);
  });

  test('submit the stage-one goal; the task locks ordinary writes and Run', async ({ page }) => {
    await openProject(page);
    await page.getByRole('tab', { name: 'AI' }).click();

    const submitResponse = page.waitForResponse((response) => {
      const { pathname } = new URL(response.url());
      return pathname === `/api/v1/projects/${SCENE.projectId}/agent-tasks`
        && response.request().method() === 'POST';
    });
    await page.locator('#agent-task-goal').fill(TASK_PROMPT);
    await page.getByRole('button', { name: 'Start task' }).click();
    const submitted = (await (await submitResponse).json()) as TaskSnapshotLike;
    expect(OCCUPYING.has(submitted.state), 'the submitted task must occupy the project').toBe(true);
    SCENE.taskId = submitted.taskId;
    expect(submitted.writesLocked, 'the task snapshot must lock writes').toBe(true);

    // Occupancy is authoritative on the backend, not a UI impression: an ordinary
    // file write and a Run start are both refused with 409 AI_TASK_ACTIVE. The
    // agent may legitimately bump the revision between our read and the probe,
    // so a stale-revision probe is retried until the occupancy refusal lands.
    await expect(async () => {
      const revision = (await fileContent(page, DEMO_FILE)).workspaceRevision;
      const save = await authedPut(
        page,
        `/api/v1/projects/${SCENE.projectId}/files/content?path=${encodeURIComponent(DEMO_FILE)}`,
        { content: SCENE.initialDemoContent, expectedWorkspaceRevision: revision },
      );
      expect(save.status(), 'an ordinary write must be refused while the task owns the project')
        .toBe(409);
      expect(((await save.json()) as { code: string }).code, 'refusal code must be AI_TASK_ACTIVE')
        .toBe('AI_TASK_ACTIVE');
    }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });

    await expect(async () => {
      const revision = (await fileContent(page, DEMO_FILE)).workspaceRevision;
      const start = await authedPost(page, `/api/v1/projects/${SCENE.projectId}/runs`, {
        expectedWorkspaceRevision: revision,
      });
      expect(start.status(), 'a Run start must be refused while the task owns the project')
        .toBe(409);
      expect(((await start.json()) as { code: string }).code, 'refusal code must be AI_TASK_ACTIVE')
        .toBe('AI_TASK_ACTIVE');
    }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });

    // UI mirror: the goal textarea is disabled while the task occupies.
    await expect(page.locator('#agent-task-goal')).toBeDisabled();

    // A full reload must land back in the SAME task - never a second one. The
    // reload drops the memory-only token, so sign in again on the way back;
    // RequireAuth's router state returns the workbench, same task, same lock.
    await page.reload();
    await signIn(page);
    await page.getByRole('tab', { name: 'AI' }).click();
    const current = await taskById(page, SCENE.taskId);
    expect(OCCUPYING.has(current.state), 'the same task must still occupy after a reload').toBe(true);
    await expect(page.locator('#agent-task-goal')).toBeDisabled();
    console.log(`[ai-stage1] task=${SCENE.taskId} occupies the project; write/Run refusals verified`);
  });

  test('the task settles through the real model loop', async ({ page }, testInfo) => {
    test.setTimeout(SETTLE_TIMEOUT + 120_000);
    await signIn(page); // fresh page; the task belongs to the project, not the tab

    const final = await waitForSettledTask(page);
    SCENE.settledAt = new Date().toISOString();
    // COMPLETED is the only passing verdict: it means the model finished AND every
    // registered tool settled (builds cleaned up, file receipts verified) on the
    // backend. FAILED or NEEDS_ATTENTION is a real acceptance failure.
    expect(final.state, `the task must complete; failureCode=${final.failureCode}`).toBe('COMPLETED');
    expect(final.failureCode, 'a completed task carries no failure code').toBeNull();
    await testInfo.attach('ai-stage1-settled-task.json', {
      body: Buffer.from(JSON.stringify({
        taskId: SCENE.taskId,
        state: final.state,
        initialRevision: SCENE.initialRevision,
        finalRevision: final.workspaceRevision,
        changedPaths: final.changedPaths,
        summary: final.summary,
        submitAt: SCENE.submitAt,
        settledAt: SCENE.settledAt,
        progress: final.progress,
      }, null, 2)),
      contentType: 'application/json',
    });
    console.log(
      `[ai-stage1] task=${SCENE.taskId} settled COMPLETED revision `
        + `${SCENE.initialRevision} -> ${final.workspaceRevision}`,
    );
  });

  test('the repaired source, the untouched fixture and the loop shape', async ({ page }, testInfo) => {
    await signIn(page);
    const final = await taskById(page, SCENE.taskId); // settled tasks stay queryable
    expect(final.state).toBe('COMPLETED');

    // Initial -> final revision moved forward under the task.
    expect(
      Number.parseInt(final.workspaceRevision, 10),
      'the final revision must be past the initial one',
    ).toBeGreaterThan(Number.parseInt(SCENE.initialRevision, 10));

    // The real file carries the target message and the compile error is gone.
    const demo = await fileContent(page, DEMO_FILE);
    expect(demo.content.includes(TARGET_MESSAGE), 'DemoController must serve the target message')
      .toBe(true);
    expect(demo.content.includes(SEEDED_ERROR), 'the seeded compile error must be repaired').toBe(false);
    expect(final.changedPaths, 'the changed paths must include the repaired controller')
      .toContain(DEMO_FILE);

    // The acceptance fixture is byte-identical: Pi preserved, not weakened, the test.
    const fixtureAfter = await fileContent(page, FIXTURE_FILE);
    const fixtureSha = createHash('sha256').update(fixtureAfter.content, 'utf8').digest('hex');
    expect(fixtureAfter.content, 'the fixture file must survive byte-for-byte').toBe(FIXTURE_CONTENT);
    expect(fixtureSha, 'the fixture sha256 must equal the recorded digest')
      .toBe(RECORDED_FIXTURE_SHA256);

    // Observed loop shape from the durable progress stream (tool_end texts are
    // "<toolName> <toolCallId>"): at least one build ran before the first write and
    // a build ran after the last write. Tool call ids stay Pi's own - no fixed order.
    const toolEnds = final.progress.filter((item) => item.kind === 'tool_end')
      .map((item) => item.text.split(' ')[0]);
    const writeIndexes = toolEnds.flatMap((name, index) => (name === 'write_file' ? [index] : []));
    const buildIndexes = toolEnds.flatMap((name, index) => (name === 'build' ? [index] : []));
    expect(writeIndexes.length, 'the loop must include at least one real write').toBeGreaterThan(0);
    expect(buildIndexes.length, 'the loop must include at least two real builds').toBeGreaterThan(1);
    expect(buildIndexes[0], 'the first build must precede the first write (the failing run)')
      .toBeLessThan(writeIndexes[0]);
    expect(buildIndexes.at(-1), 'the last build must follow the last write (the verification run)')
      .toBeGreaterThan(writeIndexes.at(-1)!);
    await testInfo.attach('ai-stage1-verification.json', {
      body: Buffer.from(JSON.stringify({
        taskId: SCENE.taskId,
        initialRevision: SCENE.initialRevision,
        finalRevision: final.workspaceRevision,
        changedPaths: final.changedPaths,
        demoSha256: createHash('sha256').update(demo.content, 'utf8').digest('hex'),
        fixtureSha256: fixtureSha,
        toolEndSequence: toolEnds,
      }, null, 2)),
      contentType: 'application/json',
    });
  });

  test('the editor shows the repaired source', async ({ page }) => {
    await openProject(page);
    await revealInTree(page, DEMO_FILE);
    await treeItemByPath(page, DEMO_FILE).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(TARGET_MESSAGE, {
      timeout: 60_000,
    });
  });

  test('ordinary writes work again after the task ends', async ({ page }) => {
    await signIn(page);
    const demo = await fileContent(page, DEMO_FILE);
    // A content-identical save round-trips: the project's writes are released.
    const saved = await authedPut(
      page,
      `/api/v1/projects/${SCENE.projectId}/files/content?path=${encodeURIComponent(DEMO_FILE)}`,
      { content: demo.content, expectedWorkspaceRevision: demo.workspaceRevision },
    );
    expect(saved.ok(), 'an ordinary save must succeed after the task settled').toBeTruthy();
    const releasedRevision = ((await saved.json()) as { workspaceRevision: string })
      .workspaceRevision;
    expect(releasedRevision, 'the released save bumps the revision').not.toBe(demo.workspaceRevision);
    console.log(`[ai-stage1] writes released; post-run revision=${releasedRevision}`);
  });
});

// ---------------------------------------------------------------------------
// Page operations reused from existing mature specs (see file header).
// ---------------------------------------------------------------------------

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
  // Login normally lands on the list; after an unauthenticated reload the app
  // returns to the pre-reload deep link, so both /projects and /projects/{id} hold.
  await expect(page).toHaveURL(/\/projects(\/[0-9a-f-]+)?$/);
}

/**
 * The app keeps the access token in memory only (a deliberate 6A security choice:
 * never in localStorage/sessionStorage/URL), so ANY page.goto after signing in
 * drops the session and RequireAuth redirects back to /login. The workbench is
 * therefore reached by deep-linking FIRST and signing in SECOND - RequireAuth
 * records the requested path in router state and LoginPage returns to it.
 */
async function openProject(page: Page): Promise<void> {
  await page.goto(`/projects/${SCENE.projectId}`);
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${SCENE.projectId}$`));
}

/**
 * The file tree renders collapsed roots and each tree item's children load on
 * expansion, so a deep path (src/main/java/com/example/app) is only visible
 * after every ancestor is expanded in order. Clicking a directory item toggles
 * it (FileTreeNode onClick) - the same interaction a workbench user performs.
 */
async function revealInTree(page: Page, path: string): Promise<void> {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join('/');
    await expect(treeItemByPath(page, prefix)).toBeVisible();
    const isExpanded = await treeItemByPath(page, prefix).getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await treeItemByPath(page, prefix).click();
    }
  }
  await expect(treeItemByPath(page, path)).toBeVisible();
}

function treeItemByPath(page: Page, path: string): Locator {
  const name = path.split('/').pop()!;
  return page.getByRole('treeitem', { name, exact: true });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls the durable task until it leaves the occupying states (bounded). */
async function waitForSettledTask(page: Page): Promise<TaskSnapshotLike> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  for (;;) {
    const snapshot = await taskById(page, SCENE.taskId);
    if (!OCCUPYING.has(snapshot.state)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `任务 ${SCENE.taskId} 在 ${SETTLE_TIMEOUT}ms 内未结算：真实模型链路可能未完成，`
          + '验收按失败处理，不延长等待。',
      );
    }
    await sleep(SETTLE_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// API corroboration (never replaces a UI assertion). page.request does not attach
// localStorage tokens, so every call carries the login-issued bearer explicitly.
// ---------------------------------------------------------------------------

function authedGet(page: Page, path: string) {
  return page.request.get(path, {
    headers: { Authorization: `Bearer ${SCENE.accessToken}` },
  });
}

function authedPost(page: Page, path: string, body: unknown) {
  return page.request.post(path, {
    headers: { Authorization: `Bearer ${SCENE.accessToken}` },
    data: body,
  });
}

function authedPut(page: Page, path: string, body: unknown) {
  return page.request.put(path, {
    headers: { Authorization: `Bearer ${SCENE.accessToken}` },
    data: body,
  });
}

/** The occupying task through the current-task route, or null when the project is free. */
async function currentTaskOrNull(page: Page): Promise<TaskSnapshotLike | null> {
  const response = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/agent-tasks/current`);
  if (response.status() === 404) {
    return null;
  }
  expect(response.ok(), 'the current-task check must succeed').toBeTruthy();
  return (await response.json()) as TaskSnapshotLike;
}

/** One task by id; settled tasks stay queryable for the same owner. */
async function taskById(page: Page, taskId: string): Promise<TaskSnapshotLike> {
  const response = await authedGet(
    page,
    `/api/v1/projects/${SCENE.projectId}/agent-tasks/${taskId}`,
  );
  expect(response.ok(), `task ${taskId} must stay queryable`).toBeTruthy();
  return (await response.json()) as TaskSnapshotLike;
}

/** One file's content and live workspace revision through the read-only file API. */
async function fileContent(
  page: Page,
  path: string,
): Promise<{ content: string; workspaceRevision: string }> {
  const response = await authedGet(
    page,
    `/api/v1/projects/${SCENE.projectId}/files/content?path=${encodeURIComponent(path)}`,
  );
  expect(response.ok(), `file content for ${path} must be readable`).toBeTruthy();
  return (await response.json()) as { content: string; workspaceRevision: string };
}
