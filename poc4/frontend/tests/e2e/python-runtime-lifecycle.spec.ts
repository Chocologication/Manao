import { expect, test, type Page } from '@playwright/test';

/**
 * Python project runtime: cloud lifecycle acceptance, driven purely through the browser
 * against the public ingress (MANAO_RUNTIME_BASE_URL). One serial scene covers the
 * increment-A run path: login and template entry assertions, a python-console project
 * whose entry point runs to success, is edited into a failure, is fixed and runs again,
 * a python-fastapi-web project with two operator-assigned public ports whose second
 * listener is added through the same workspace file API the editor drives, the FastAPI
 * run serving the demo route through both ports, a UI stop that ends the process and
 * the public access, a second run that serves again, and a UI-scoped deletion of both
 * projects.
 *
 * This spec is authored and typechecked up front (Task 6). It can only execute against
 * a deployed backend that already serves Python projects; until such an environment is
 * authorized the suite stays NOT_REVERIFIED (recorded in the plan/evidence), and the
 * full cloud acceptance evidence is collected separately in Task 11.
 *
 * Selector provenance (reused mature page operations, do not re-derive):
 * - login / project card / create: stage1.spec.ts `signIn`, `createProject`,
 *   `projectCard`
 * - run tab / Run state / Start run / Stop dialog: stage6-real-backend.spec.ts,
 *   stage6b-cloud-lifecycle.spec.ts and the java-runtime-lifecycle.spec.ts operations
 * - create-form runtime controls: CreateProjectForm.tsx (Template select, Public
 *   access checkbox, Container port N / Public port N rows, Create result status)
 * - project card runtime view: ProjectCard.tsx (runtime line, endpoint line)
 * - deletion: DeleteProjectDialog.tsx (alertdialog "Delete project?" -> Delete
 *   permanently), matching the ProjectsPage deletion unit tests
 *
 * Public ports are NEVER scanned or auto-selected: the operator fixes both test
 * NodePorts via MANAO_RUNTIME_PUBLIC_PORT_1 / MANAO_RUNTIME_PUBLIC_PORT_2 before the
 * run, and the suite fails up front when either is missing.
 *
 * The optional MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT (see the config header) arms
 * the FAILED-reconciliation case below. Its value IS the canary package name: the
 * operator arms the backend fault (MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE) with the
 * SAME value, and this spec provisions the FAILED scene itself by adding that
 * package - provisioned for the Task 11 cloud acceptance round only.
 */

const BASE_URL = process.env.MANAO_RUNTIME_BASE_URL;
const USERNAME = process.env.MANAO_RUNTIME_USERNAME;
const PASSWORD = process.env.MANAO_RUNTIME_PASSWORD;
const PUBLIC_PORT_1 = process.env.MANAO_RUNTIME_PUBLIC_PORT_1;
const PUBLIC_PORT_2 = process.env.MANAO_RUNTIME_PUBLIC_PORT_2;

const DEMO_PATH = '/api/demo';
const DEMO_GREETING = 'Hello from Manao';
// Port 1 maps the template's own Uvicorn listener (8000). Port 2 maps 8001, which the
// template app does NOT listen on: the template auto-listens only its primary port, so
// the test adds a real second listener through the workspace file API before the first
// run (design section 4: user code must actually listen on its declared additional
// ports). The public ports stay what the operator assigned.
const FASTAPI_CONTAINER_PORT = '8000';
const SECOND_CONTAINER_PORT = '8001';
const CONSOLE_ENTRY_PATH = 'main.py';
const WEB_ENTRY_PATH = 'app/main.py';
// The template entry point, restored verbatim for the "fix and run again" phase.
const CONSOLE_OK_SOURCE = `"""Manao Python console template entry point."""

print("Hello from Manao")
`;
const CONSOLE_FAIL_SOURCE = `"""Manao Python console acceptance: fail this run."""

import sys

print("about to exit non-zero")
sys.exit(3)
`;
// The template app plus a real second HTTP listener on port 8001, so the second public
// mapping serves traffic exactly like the primary one. Uvicorn stays a single process
// on the primary port; the extra port is served by this handler thread.
const SECOND_LISTENER_SOURCE = `"""Manao FastAPI web template: a demo route and a readiness probe."""

from fastapi import FastAPI

app = FastAPI()


@app.get("/api/demo")
def demo():
    return {"message": "Hello from Manao"}


@app.get("/health/ready")
def ready():
    return {"status": "ready"}


import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class _SecondPortHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"Hello from Manao"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def _serve_second_port():
    HTTPServer(("0.0.0.0", 8001), _SecondPortHandler).serve_forever()


threading.Thread(target=_serve_second_port, daemon=True).start()
`;
// The platform ingress port must stay out of the test range; the backend would
// reject it as reserved, but naming it is the clearer operator error.
const PLATFORM_INGRESS_PORT = '30080';
// The demo app may become reachable a while after RUNNING (readiness is verified
// server-side before the route is armed); this bounds the first successful probe and
// includes the cloud uv dependency preparation that happens inside the run budget.
const FIRST_SERVICE_PROBE_TIMEOUT = 180_000;
// After the UI stop the run settles asynchronously and the gateway withdraws the
// route; bound both waits.
const STOP_SETTLEMENT_TIMEOUT = 180_000;
const WITHDRAWAL_PROBE_TIMEOUT = 90_000;
// Console run budget: cloud image pull and uv preparation happen inside the run.
const CONSOLE_RUN_TIMEOUT = 600_000;
// Web run budget: startup allowance for the first verified readiness.
const WEB_RUN_TIMEOUT = 900_000;

// Load-safe gate: other configs (e.g. the default localhost config, where
// MANAO_RUNTIME_BASE_URL is unset) also scan tests/e2e, so this file must never
// throw at module scope and must not parse configuration eagerly. The python-runtime
// config itself throws on a missing MANAO_RUNTIME_BASE_URL (fail fast), so the skip
// below only ever fires for other configs' collection - the acceptance run itself
// can never skip silently.
test.skip(
  !BASE_URL,
  'python-runtime cloud lifecycle requires MANAO_RUNTIME_BASE_URL plus credentials and ports; '
    + 'run via pnpm test:e2e:python-runtime',
);

// Parsed in beforeAll (never at module scope): missing/invalid values must fail the
// acceptance run loudly at runtime, while other configs still collect this file safely.
let publicPortNumber1 = 0;
let publicPortNumber2 = 0;
let publicOriginValue = '';

type RunSummaryLike = {
  id: string;
  state: string;
  policy: { templateId?: string; executionKind?: string; command?: string };
  firstReadyAt: string | null;
  expiresAt: string | null;
  finishedAt: string | null;
  terminationReason: string | null;
  exitCode: number | null;
};

function parsePort(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(
      `环境变量 ${label} 未设置或不是十进制端口号：两条测试公网端口必须由操作者显式指定，`
        + '本套件不会扫描空闲端口或代为选号。',
    );
  }
  const parsed = Number(value);
  if (parsed < 30000 || parsed > 31000) {
    throw new Error(`环境变量 ${label} 必须在公网 NodePort 范围 30000-31000 内，实际为 ${value}`);
  }
  if (value === PLATFORM_INGRESS_PORT) {
    throw new Error(`环境变量 ${label} 不能是平台入口端口 ${PLATFORM_INGRESS_PORT}`);
  }
  return parsed;
}

function shortTimestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

// Shared scene state across the serial tests (workers: 1 guarantees ordering).
const SCENE = {
  consoleProjectName: `py-console-${shortTimestamp()}-${randomSuffix()}`,
  webProjectName: `py-web-${shortTimestamp()}-${randomSuffix()}`,
  consoleProjectId: '',
  webProjectId: '',
  accessToken: '',
  webRunId: '',
};

test.describe.serial('python runtime cloud lifecycle', () => {
  // Runtime configuration guard: reached only when MANAO_RUNTIME_BASE_URL is set
  // (module-level skip keeps the default config load-safe). Missing credentials or
  // ports must fail the run loudly, never silently skip to a green exit.
  test.beforeAll(() => {
    if (!USERNAME || !PASSWORD) {
      throw new Error(
        '环境变量 MANAO_RUNTIME_USERNAME / MANAO_RUNTIME_PASSWORD 未设置：'
          + 'MANAO_RUNTIME_BASE_URL 已配置时必须同时提供私有运行环境注入的真实凭据，'
          + 'Python 运行时云端 E2E 拒绝在凭据缺失时静默跳过。',
      );
    }
    publicPortNumber1 = parsePort(PUBLIC_PORT_1, 'MANAO_RUNTIME_PUBLIC_PORT_1');
    publicPortNumber2 = parsePort(PUBLIC_PORT_2, 'MANAO_RUNTIME_PUBLIC_PORT_2');
    if (publicPortNumber1 === publicPortNumber2) {
      throw new Error('MANAO_RUNTIME_PUBLIC_PORT_1 与 MANAO_RUNTIME_PUBLIC_PORT_2 不能相同');
    }
    // The public NodePort range lives on the same host as the platform ingress, so
    // the BASE_URL host is the probe target by design.
    const entry = new URL(BASE_URL!);
    publicOriginValue = `${entry.protocol}//${entry.hostname}`;
    console.log(
      `[python-runtime] entry=${BASE_URL} ports=${publicPortNumber1}/${publicPortNumber2}`
        + ` console="${SCENE.consoleProjectName}" web="${SCENE.webProjectName}"`,
    );
  });

  test('login on the public entry and verify the python templates are offered', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/projects$/);

    // The deployed entry must expose the python templates next to the java ones.
    const templateSelect = page.getByLabel('Template');
    await expect(templateSelect).toBeVisible();
    await expect(templateSelect.locator('option', { hasText: 'Python console' })).toHaveCount(1);
    await expect(templateSelect.locator('option', { hasText: 'Python FastAPI web' })).toHaveCount(1);
    console.log(`[python-runtime] login and python templates verified on ${BASE_URL}`);
  });

  test('create the python console project and run it to success', async ({ page }, testInfo) => {
    test.setTimeout(1_200_000); // workspace provisioning plus the first cloud run
    await signIn(page);

    await page.getByLabel('Project name').fill(SCENE.consoleProjectName);
    await page.getByLabel('Template').selectOption({ label: 'Python console' });
    // A console template offers no MySQL/Redis or public-port options at all.
    await expect(page.getByLabel('Public access')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create project' }).click();
    const result = page.locator('p[role="status"][aria-label="Create result"]');
    await expect(result).toContainText(`Created ${SCENE.consoleProjectName}`);
    await expect(result).toContainText('python-console');

    const card = projectCard(page, SCENE.consoleProjectName);
    await expect(card).toBeVisible();
    await expect(card.getByText('READY', { exact: true })).toBeVisible({ timeout: 600_000 });
    await openProject(page, SCENE.consoleProjectName);
    SCENE.consoleProjectId = currentProjectId(page);

    await startRunFromToolbar(page);
    // The toolbar reads the actual run policy: the python console command and toolchain,
    // never the Maven default.
    await expect(page.getByText('python -u main.py')).toBeVisible();
    await expect(page.getByText(/Python 3\.13 · uv/)).toBeVisible();
    const runId = await pollForActiveRunId(page, SCENE.consoleProjectId);
    const finished = await waitForRunState(
      page,
      SCENE.consoleProjectId,
      runId,
      /SUCCEEDED/,
      CONSOLE_RUN_TIMEOUT,
    );
    expect(finished.exitCode, 'the console run must exit 0').toBe(0);
    expect(finished.terminationReason, 'a normal program succeeds on exit 0').toBe('BUILD_SUCCEEDED');

    await testInfo.attach('python-runtime-console-success.json', {
      body: Buffer.from(JSON.stringify({
        projectName: SCENE.consoleProjectName,
        projectId: SCENE.consoleProjectId,
        runId,
        state: finished.state,
        policy: finished.policy,
      })),
      contentType: 'application/json',
    });
    console.log(
      `[python-runtime] console run ${runId} SUCCEEDED with policy ${JSON.stringify(finished.policy)}`,
    );
  });

  test('the edited console entry fails the next run and the fixed entry succeeds again', async ({ page }, testInfo) => {
    test.setTimeout(1_500_000); // two more cloud runs
    await signIn(page);

    // Overwrite the entry through the same workspace file API the editor drives, before
    // the project page loads, so the Start-run revision is current.
    await putFile(page, SCENE.consoleProjectId, CONSOLE_ENTRY_PATH, CONSOLE_FAIL_SOURCE);
    await openProject(page, SCENE.consoleProjectName);
    await startRunFromToolbar(page);
    const failedRunId = await pollForActiveRunId(page, SCENE.consoleProjectId);
    const failed = await waitForRunState(
      page,
      SCENE.consoleProjectId,
      failedRunId,
      /FAILED/,
      CONSOLE_RUN_TIMEOUT,
    );
    expect(failed.exitCode, 'sys.exit(3) must surface as the run exit code').toBe(3);
    expect(failed.terminationReason, 'a non-zero console exit fails the run').toBe('APPLICATION_EXITED');
    console.log(`[python-runtime] edited console run ${failedRunId} FAILED with exit 3 as expected`);

    // Restore the template entry: the fix must genuinely succeed on a new run.
    await putFile(page, SCENE.consoleProjectId, CONSOLE_ENTRY_PATH, CONSOLE_OK_SOURCE);
    await openProject(page, SCENE.consoleProjectName);
    await startRunFromToolbar(page);
    const fixedRunId = await pollForActiveRunId(page, SCENE.consoleProjectId);
    const fixed = await waitForRunState(
      page,
      SCENE.consoleProjectId,
      fixedRunId,
      /SUCCEEDED/,
      CONSOLE_RUN_TIMEOUT,
    );
    expect(fixed.exitCode, 'the fixed console run must exit 0').toBe(0);
    expect(fixedRunId, 'every click starts a new run, never a replay').not.toBe(failedRunId);

    await testInfo.attach('python-runtime-console-cycle.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.consoleProjectId,
        failedRunId,
        fixedRunId,
        finalState: fixed.state,
      })),
      contentType: 'application/json',
    });
    console.log(`[python-runtime] fixed console run ${fixedRunId} SUCCEEDED`);
  });

  test('create the FastAPI project with the two assigned public ports', async ({ page }, testInfo) => {
    test.setTimeout(1_200_000);
    await signIn(page);

    await page.getByLabel('Project name').fill(SCENE.webProjectName);
    await page.getByLabel('Template').selectOption({ label: 'Python FastAPI web' });
    await page.getByLabel('Public access').check();
    // FastAPI defaults to container port 8000 with a blank public port; the operator's
    // two NodePorts map 8000 (template listener) and 8001 (added second listener).
    await page.getByLabel('Container port 1').fill(FASTAPI_CONTAINER_PORT);
    await page.getByLabel('Public port 1').fill(String(publicPortNumber1));
    await page.getByRole('button', { name: 'Add port' }).click();
    await page.getByLabel('Container port 2').fill(SECOND_CONTAINER_PORT);
    await page.getByLabel('Public port 2').fill(String(publicPortNumber2));

    await page.getByRole('button', { name: 'Create project' }).click();
    const result = page.locator('p[role="status"][aria-label="Create result"]');
    await expect(result).toContainText(`Created ${SCENE.webProjectName}`);
    await expect(result).toContainText(String(publicPortNumber1));
    await expect(result).toContainText(String(publicPortNumber2));

    const card = projectCard(page, SCENE.webProjectName);
    await expect(card).toBeVisible();
    await expect(card.getByText('READY', { exact: true })).toBeVisible({ timeout: 600_000 });
    // The exact user-selected NodePorts were provisioned, not substituted.
    await expect(card).toContainText(String(publicPortNumber1));
    await expect(card).toContainText(String(publicPortNumber2));
    await openProject(page, SCENE.webProjectName);
    SCENE.webProjectId = currentProjectId(page);

    await testInfo.attach('python-runtime-web-project.json', {
      body: Buffer.from(JSON.stringify({
        projectName: SCENE.webProjectName,
        publicPorts: [publicPortNumber1, publicPortNumber2],
      })),
      contentType: 'application/json',
    });
    console.log(
      `[python-runtime] FastAPI project "${SCENE.webProjectName}" READY with ports`
        + ` ${publicPortNumber1}/${publicPortNumber2}`,
    );
  });

  test('start the FastAPI run and serve the demo app through both assigned ports', async ({ page }, testInfo) => {
    test.setTimeout(WEB_RUN_TIMEOUT + 300_000);
    await signIn(page);

    // The second public port maps container port 8001, which the template does not
    // listen on yet: add the real second listener through the same workspace file API
    // the editor drives, BEFORE the project page loads, so the run picks up the code
    // and the Start-run revision is current.
    await putFile(page, SCENE.webProjectId, WEB_ENTRY_PATH, SECOND_LISTENER_SOURCE);
    await openProject(page, SCENE.webProjectName);
    await page.getByRole('tab', { name: 'Run' }).click();
    const start = page.getByRole('button', { name: 'Start run' });
    await expect(start).toBeEnabled();
    await start.click();
    const runState = page.getByRole('status', { name: 'Run state' });
    await expect(runState).toBeVisible();
    await expect(runState).toContainText('RUNNING', { timeout: 780_000 });

    // The toolbar reads the actual run policy of the selected web run.
    await expect(page.getByText('python -u -m uvicorn app.main:app')).toBeVisible();

    // Corroboration: this is a SERVICE run with a verified readiness lifetime, and the
    // deadline is armed at first verified readiness - never before.
    const activeRun = await pollForActiveReadyRun(page);
    expect(activeRun.policy.templateId, 'the FastAPI run must name its template')
      .toBe('python-fastapi-web');
    expect(activeRun.policy.executionKind, 'the web template must run as a bounded SERVICE run')
      .toBe('SERVICE');
    expect(activeRun.firstReadyAt, 'readiness must be verified before the ports serve').toBeTruthy();
    expect(activeRun.expiresAt, 'the immutable lifetime deadline must be armed at readiness')
      .toBeTruthy();
    SCENE.webRunId = activeRun.id;

    await expectPortServesDemo(page, publicPortNumber1);
    await expectPortServesDemo(page, publicPortNumber2);

    await testInfo.attach('python-runtime-web-run.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.webProjectId,
        runId: SCENE.webRunId,
        executionKind: activeRun.policy.executionKind,
        firstReadyAt: activeRun.firstReadyAt,
        expiresAt: activeRun.expiresAt,
        publicPorts: [publicPortNumber1, publicPortNumber2],
      })),
      contentType: 'application/json',
    });
    console.log(
      `[python-runtime] run ${SCENE.webRunId} serves ${DEMO_PATH} through ports`
        + ` ${publicPortNumber1}/${publicPortNumber2}; lifetime ends at ${activeRun.expiresAt}`,
    );
    // The run is intentionally left active: the next test stops this exact run from the UI.
  });

  test('stop the FastAPI run from the UI and start it again', async ({ page }, testInfo) => {
    test.setTimeout(WEB_RUN_TIMEOUT + 600_000);
    await signIn(page);
    await openProject(page, SCENE.webProjectName);

    // The run from the previous test is still the project's single active run.
    const before = await pollForActiveReadyRun(page);
    expect(before.id, 'the stop test must continue the run started by the previous test')
      .toBe(SCENE.webRunId);

    const stop = page.getByRole('button', { name: 'Stop run' });
    await expect(stop).toBeEnabled();
    await stop.click();
    const dialog = page.getByRole('dialog', { name: 'Stop run' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();

    // The server, not the browser, ends the run: wait for the settled state, then for
    // the gateway route withdrawal on both public ports.
    const stopped = await waitForRunState(
      page,
      SCENE.webProjectId,
      SCENE.webRunId,
      /CANCELLED/,
      STOP_SETTLEMENT_TIMEOUT,
    );
    expect(stopped.terminationReason, 'a UI stop records USER_STOPPED').toBe('USER_STOPPED');
    await expect(async () => {
      const stillServing = (await probePort(page, publicPortNumber1))
        || (await probePort(page, publicPortNumber2));
      expect(stillServing, 'the public ports must stop serving after the UI stop').toBe(false);
    }).toPass({ timeout: WITHDRAWAL_PROBE_TIMEOUT, intervals: [5_000, 10_000] });
    console.log(`[python-runtime] run ${SCENE.webRunId} stopped from the UI; ports withdrawn`);

    // Starting again must produce a NEW run that serves again with the same code.
    const start = page.getByRole('button', { name: 'Start run' });
    await expect(start).toBeEnabled({ timeout: 120_000 });
    await start.click();
    const againState = page.getByRole('status', { name: 'Run state' });
    await expect(againState).toContainText('RUNNING', { timeout: 780_000 });
    const againRun = await pollForActiveReadyRun(page);
    expect(againRun.id, 'a manual re-run starts a new run id').not.toBe(SCENE.webRunId);
    await expectPortServesDemo(page, publicPortNumber1);
    await expectPortServesDemo(page, publicPortNumber2);

    await testInfo.attach('python-runtime-stop-rerun.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.webProjectId,
        stoppedRunId: SCENE.webRunId,
        rerunId: againRun.id,
        publicPorts: [publicPortNumber1, publicPortNumber2],
      })),
      contentType: 'application/json',
    });
    console.log(`[python-runtime] re-run ${againRun.id} serves both ports again`);
  });

  test('add httpx through the dependency form, import it, remove it and fail the import again', async ({ page }, testInfo) => {
    test.setTimeout(1_800_000); // two cloud runs plus uv resolution on both changes
    await signIn(page);
    await openProject(page, SCENE.consoleProjectName);
    expect(SCENE.consoleProjectId, 'the console project from the earlier scene').not.toBe('');

    // ADD httpx through the workbench form; the committed files must list it.
    await page.getByRole('tab', { name: 'Dependencies' }).click();
    await page.getByLabel('Package name').fill('httpx');
    await page.getByRole('button', { name: 'Add dependency' }).click();
    await expect
      .poll(async () => readPyproject(page), { timeout: 120_000, intervals: [2_000, 5_000] })
      .toContain('httpx');
    console.log('[python-runtime] httpx added through the dependency form');

    // A run that imports httpx must succeed with the resolved dependency present.
    await putFile(
      page,
      SCENE.consoleProjectId,
      CONSOLE_ENTRY_PATH,
      '"""Manao dependency acceptance: httpx is importable."""\n\nimport httpx\n\nprint(httpx.__version__)\n',
    );
    await openProject(page, SCENE.consoleProjectName);
    await startRunFromToolbar(page);
    const withHttpxRunId = await pollForActiveRunId(page, SCENE.consoleProjectId);
    const withHttpx = await waitForRunState(
      page,
      SCENE.consoleProjectId,
      withHttpxRunId,
      /SUCCEEDED/,
      CONSOLE_RUN_TIMEOUT,
    );
    expect(withHttpx.exitCode, 'importing httpx must work after the ADD').toBe(0);

    // REMOVE httpx through the same form; the committed files must drop it.
    await page.getByRole('tab', { name: 'Dependencies' }).click();
    await page.getByLabel('Package name').fill('httpx');
    await page.getByRole('button', { name: 'Remove dependency' }).click();
    await expect
      .poll(async () => readPyproject(page), { timeout: 120_000, intervals: [2_000, 5_000] })
      .not.toContain('httpx');
    console.log('[python-runtime] httpx removed through the dependency form');

    // The same importing program must now fail: the removal left no residue.
    await openProject(page, SCENE.consoleProjectName);
    await startRunFromToolbar(page);
    const withoutHttpxRunId = await pollForActiveRunId(page, SCENE.consoleProjectId);
    expect(withoutHttpxRunId, 'every change runs as a new run').not.toBe(withHttpxRunId);
    const withoutHttpx = await waitForRunState(
      page,
      SCENE.consoleProjectId,
      withoutHttpxRunId,
      /FAILED/,
      CONSOLE_RUN_TIMEOUT,
    );
    expect(withoutHttpx.exitCode, 'a missing import must fail the run').not.toBe(0);

    await testInfo.attach('python-runtime-dependency-cycle.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.consoleProjectId,
        withHttpxRunId,
        withoutHttpxRunId,
      })),
      contentType: 'application/json',
    });
  });

  test('a lost dependency response stays recoverable after a refresh', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await signIn(page);
    await openProject(page, SCENE.consoleProjectName);

    // Deliver the change request but lose the response: the backend may commit
    // while the browser never learns the result, exactly like a real outage.
    let deliveredDependencyPost = 0;
    const dependencyChangePostRoute = '**/api/v1/projects/*/python-dependencies';
    await page.route(dependencyChangePostRoute, async (route) => {
      deliveredDependencyPost += 1;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.getByRole('tab', { name: 'Dependencies' }).click();
    await page.getByLabel('Package name').fill('requests');
    await page.getByRole('button', { name: 'Add dependency' }).click();
    expect(deliveredDependencyPost, 'the ADD was sent exactly once').toBe(1);

    // The unconfirmed entry appears and no automatic retry is sent.
    await expect(page.getByText('Dependency change is unconfirmed')).toBeVisible();
    expect(deliveredDependencyPost).toBe(1);

    // Refresh: the same session still offers the check entry for the SAME operation.
    await page.reload();
    await signIn(page);
    if (page.url().endsWith('/projects')) {
      await openProject(page, SCENE.consoleProjectName);
    } else {
      await expect(page.getByRole('heading', { name: SCENE.consoleProjectName })).toBeVisible();
    }
    const check = page.getByRole('button', { name: 'Check dependency change' });
    await expect(check).toBeEnabled();
    expect(deliveredDependencyPost, 'the refresh must not resend the ADD').toBe(1);

    // Checking queries/reconciles the original operation and the workspace confirms it.
    // unroute must use the exact registered pattern, or the fetch-then-abort
    // interceptor would silently survive and drop every later change response.
    await page.unroute(dependencyChangePostRoute);
    await check.click();
    await expect(page.getByText('Dependency change is unconfirmed')).toBeHidden({ timeout: 180_000 });
    await expect
      .poll(async () => readPyproject(page), { timeout: 120_000, intervals: [2_000, 5_000] })
      .toContain('requests');
    console.log('[python-runtime] lost dependency response recovered through the same operation id');

    // Leave the project clean for the deletion scene. This cleanup REMOVE is also the
    // defensive proof that the interceptor is really gone: a surviving route would drop
    // the response, re-enter the unconfirmed state and bump the counter to 2.
    await page.getByLabel('Package name').fill('requests');
    await page.getByRole('button', { name: 'Remove dependency' }).click();
    await expect(page.getByText('Dependency change is unconfirmed')).toBeHidden({ timeout: 180_000 });
    await expect
      .poll(async () => readPyproject(page), { timeout: 120_000, intervals: [2_000, 5_000] })
      .not.toContain('requests');
    expect(deliveredDependencyPost, 'the unintercepted cleanup REMOVE must not pass through the route')
      .toBe(1);

    await testInfo.attach('python-runtime-lost-response-recovery.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.consoleProjectId,
        deliveredDependencyPost,
      })),
      contentType: 'application/json',
    });
  });

  test('a FAILED reconciliation page recovers the pending dependency operation', async ({ page }, testInfo) => {
    // Authored-only case: reaching WORKSPACE_RECONCILIATION_REQUIRED needs a backend
    // fault (agent commit interrupted after prepare). Task 11 pairs this case with the
    // operator-injected fault; without the fault value the case must not run and stays
    // explicitly NOT_REVERIFIED instead of passing vacuously.
    test.skip(
      !process.env.MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT,
      'requires MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT=<canary package>: the value IS the canary package '
        + 'name the backend fault (MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE) is armed with, so the operator '
        + 'must set the SAME value on both sides - this test then provisions the FAILED scene itself by '
        + 'adding that package',
    );
    test.setTimeout(600_000);
    // Dual-purpose contract: the variable is both the arming flag and the exact canary
    // package value. A value that could never pass the backend's own package rule would
    // commit normally on an armed backend - so it must fail here loudly, never vacuously.
    const canary = process.env.MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT!;
    expect(
      canary,
      `MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT="${canary}" must be a valid backend dependency package `
        + 'name (lowercase alnum at both ends, hyphens inside) and must resolve through real uv - '
        + 'use "six"',
    ).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);

    await signIn(page);
    // The backend fault sits AFTER prepare + durable PENDING registration and BEFORE the
    // commit: one ADD of the canary itself must answer the production fail-closed error.
    // A 2xx would mean the backend fault was not armed with this canary value.
    const revision = await currentWorkspaceRevision(page, SCENE.consoleProjectId);
    const faultResponse = await authedPost(
      page,
      `/api/v1/projects/${SCENE.consoleProjectId}/python-dependencies`,
      {
        operationId: generateDependencyOperationId(),
        action: 'ADD',
        packageName: canary,
        version: null,
        expectedWorkspaceRevision: revision,
      },
    );
    expect(
      faultResponse.status(),
      `the canary ADD must answer 409 WORKSPACE_RECONCILIATION_REQUIRED (got ${faultResponse.status()}): `
        + 'a 2xx means the backend fault MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE was NOT armed with '
        + `"${canary}" on this backend`,
    ).toBe(409);
    expect(
      ((await faultResponse.json()) as { code?: string }).code,
      'the fail-closed body must carry the reconciliation code',
    ).toBe('WORKSPACE_RECONCILIATION_REQUIRED');

    await page.goto(`/projects/${SCENE.consoleProjectId}`);

    // The failure page must reach the recovery entry without the READY workbench.
    await expect(page.getByText('WORKSPACE_RECONCILIATION_REQUIRED')).toBeVisible();
    const check = page.getByRole('button', { name: 'Check dependency change' });
    await expect(check).toBeEnabled();
    await check.click();

    // Reconciling lifts exactly this failure and reopens the workbench.
    await expect(page.getByRole('heading', { name: SCENE.consoleProjectName })).toBeVisible({
      timeout: 300_000,
    });
    console.log('[python-runtime] FAILED project recovered through the dependency check entry');

    await testInfo.attach('python-runtime-failed-recovery.json', {
      body: Buffer.from(JSON.stringify({ projectId: SCENE.consoleProjectId })),
      contentType: 'application/json',
    });
  });

  test('delete both projects from the UI and confirm the cards stay gone', async ({ page }, testInfo) => {
    await signIn(page);

    // Deletion is refused while a run is active. Settle the second web run through the
    // same stop call the toolbar's Stop button issues, then delete from the UI.
    const active = await (await authedGet(page, `/api/v1/projects/${SCENE.webProjectId}/runs/active`)).json();
    if (active?.run) {
      await authedPost(page, `/api/v1/projects/${SCENE.webProjectId}/runs/${active.run.id}/stop`, {});
      await expect
        .poll(
          async () => (await fetchRun(page, SCENE.webProjectId, active.run.id)).state,
          { timeout: STOP_SETTLEMENT_TIMEOUT, intervals: [5_000, 10_000] },
        )
        .toMatch(/SUCCEEDED|FAILED|STOPPED|TIMED_OUT|CANCELLED/);
      console.log(`[python-runtime] settled active run ${active.run.id} before deletion`);
    }

    for (const name of [SCENE.webProjectName, SCENE.consoleProjectName]) {
      const card = projectCard(page, name);
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Delete project' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete project?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      // Deletion runs the whole Kubernetes cleanup synchronously; right after a stop it
      // can outlive a default 30s expectation (measured 2026-09-22), so give it 120s.
      await expect(card).toBeHidden({ timeout: 120_000 });
      console.log(`[python-runtime] project "${name}" deleted from the UI`);
    }

    await page.reload();
    await signIn(page);
    await expect(projectCard(page, SCENE.consoleProjectName)).toBeHidden();
    await expect(projectCard(page, SCENE.webProjectName)).toBeHidden();

    // UI deletion is the acceptance path; cluster-side reclamation of the workspace and
    // MySQL PVCs, the python cache and the Job/Service resources is verified by the
    // Task 11 operator checklist, not from the browser.
    await testInfo.attach('python-runtime-deletion.json', {
      body: Buffer.from(JSON.stringify({
        deleted: [SCENE.consoleProjectName, SCENE.webProjectName],
      })),
      contentType: 'application/json',
    });
  });
});

// ---------------------------------------------------------------------------
// Page operations reused from existing mature specs (see file header).
// ---------------------------------------------------------------------------

function projectCard(page: Page, name: string) {
  return page.getByRole('article', { name });
}

function currentProjectId(page: Page): string {
  const id = page.url().split('/').pop() ?? '';
  expect(id, 'project id must be derivable from the project URL').not.toBe('');
  return id;
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
  // Login normally lands on the list; after an unauthenticated reload the app
  // returns to the pre-reload deep link, so both /projects and /projects/{id} hold.
  await expect(page).toHaveURL(/\/projects(\/[0-9a-f-]+)?$/);
}

/**
 * Opens a project card by its visible name and waits for the workbench heading.
 */
async function openProject(page: Page, projectName: string): Promise<void> {
  const card = projectCard(page, projectName);
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
}

async function startRunFromToolbar(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click();
  const start = page.getByRole('button', { name: 'Start run' });
  await expect(start).toBeEnabled();
  await start.click();
  const runState = page.getByRole('status', { name: 'Run state' });
  await expect(runState).toBeVisible();
}

// ---------------------------------------------------------------------------
// API corroboration and public-port probes (never replace a UI assertion).
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

/** Minimal replica of src/api/pythonDependencyApi.ts generateOperationId: the panel builds
 * the operation id the same RFC-4122 v4 way from getRandomValues, because public HTTP pages
 * have no secure-context crypto.randomUUID guarantee. The spec never imports app code, so
 * the fault-provisioning POST replicates the identity format it must be indistinguishable
 * from. */
function generateDependencyOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}` +
    `-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

/** Current workspace revision for optimistic writes (files/tree carries it). */
async function currentWorkspaceRevision(page: Page, projectId: string): Promise<string> {
  const response = await authedGet(page, `/api/v1/projects/${projectId}/files/tree`);
  expect(response.ok(), 'workspace tree must be readable before file edits').toBeTruthy();
  return ((await response.json()) as { workspaceRevision: string }).workspaceRevision;
}

/** The committed dependency declaration; '' when the file is not readable (yet). */
async function readPyproject(page: Page): Promise<string> {
  const response = await authedGet(
    page,
    `/api/v1/projects/${SCENE.consoleProjectId}/files/content?path=${encodeURIComponent('pyproject.toml')}`,
  );
  if (!response.ok()) {
    return '';
  }
  const body = (await response.json()) as { content?: string };
  return body.content ?? '';
}

/** Overwrite an existing template entry through the file content API the editor drives. */
async function putFile(page: Page, projectId: string, path: string, content: string): Promise<void> {
  const revision = await currentWorkspaceRevision(page, projectId);
  const response = await authedPut(
    page,
    `/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`,
    { content, expectedWorkspaceRevision: revision },
  );
  expect(response.ok(), `file ${path} must be savable`).toBeTruthy();
}

/** The single active run id; the run leaves the active view once it settles. */
async function pollForActiveRunId(page: Page, projectId: string): Promise<string> {
  await expect(async () => {
    const response = await authedGet(page, `/api/v1/projects/${projectId}/runs/active`);
    expect(response.ok(), 'active-run corroboration must succeed').toBeTruthy();
    expect(
      ((await response.json()) as { run: RunSummaryLike | null }).run,
      'waiting for the active run',
    ).not.toBeNull();
  }).toPass({ timeout: 120_000, intervals: [2_000, 5_000] });
  const response = await authedGet(page, `/api/v1/projects/${projectId}/runs/active`);
  return ((await response.json()) as { run: RunSummaryLike }).run!.id;
}

/** The single active SERVICE run with its readiness deadline armed. */
async function pollForActiveReadyRun(page: Page): Promise<RunSummaryLike> {
  await expect(async () => {
    const response = await authedGet(page, `/api/v1/projects/${SCENE.webProjectId}/runs/active`);
    expect(response.ok(), 'active-run corroboration must succeed').toBeTruthy();
    const body = (await response.json()) as { run: RunSummaryLike | null };
    expect(
      body.run,
      'the bounded web session must still be the project\'s single active run',
    ).not.toBeNull();
    expect(body.run!.firstReadyAt, 'waiting for the verified readiness to arm the deadline').toBeTruthy();
  }).toPass({ timeout: 900_000, intervals: [10_000, 30_000] });
  const response = await authedGet(page, `/api/v1/projects/${SCENE.webProjectId}/runs/active`);
  return ((await response.json()) as { run: RunSummaryLike }).run!;
}

async function fetchRun(page: Page, projectId: string, runId: string): Promise<RunSummaryLike> {
  const response = await authedGet(page, `/api/v1/projects/${projectId}/runs/${runId}`);
  expect(response.ok(), 'run corroboration must succeed').toBeTruthy();
  return (await response.json()) as RunSummaryLike;
}

async function waitForRunState(
  page: Page,
  projectId: string,
  runId: string,
  pattern: RegExp,
  timeout: number,
): Promise<RunSummaryLike> {
  await expect
    .poll(async () => (await fetchRun(page, projectId, runId)).state, {
      timeout,
      intervals: [5_000, 10_000],
    })
    .toMatch(pattern);
  return fetchRun(page, projectId, runId);
}

/** One probe attempt: does this public port serve the demo app right now? */
async function probePort(page: Page, port: number): Promise<boolean> {
  try {
    const response = await page.request.get(`${publicOriginValue}:${port}${DEMO_PATH}`, {
      timeout: 10_000,
    });
    if (!response.ok()) {
      return false;
    }
    return (await response.text()).includes(DEMO_GREETING);
  } catch {
    // Connection refused/reset/timeout: the port is not serving traffic.
    return false;
  }
}

/** The port must serve the template app's demo endpoint (bounded by readiness lag). */
async function expectPortServesDemo(page: Page, port: number): Promise<void> {
  await expect(async () => {
    const served = await probePort(page, port);
    expect(served, `public port ${port} must serve ${DEMO_PATH} with the demo payload`).toBe(true);
  }).toPass({ timeout: FIRST_SERVICE_PROBE_TIMEOUT, intervals: [5_000, 10_000] });
}
