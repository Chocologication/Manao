import { expect, test, type Page } from '@playwright/test';

/**
 * Java project runtime: cloud lifecycle acceptance, driven purely through the browser
 * against the public ingress (MANAO_RUNTIME_BASE_URL). One serial scene covers the
 * runtime-capable lifecycle: login and entry assertions, create a Spring Boot web
 * project with MySQL + Redis + two operator-assigned public ports, READY with both
 * dependencies ready, a bounded web (SERVICE) run serving the template app through
 * both public ports, the full two-hour readiness-based lifetime with port service
 * throughout, settlement at the deadline, and a UI-scoped project deletion.
 *
 * This spec is the execution surface for the real cloud acceptance round (Task 9 of
 * the java-runtime-implementation plan). It is authored and typechecked up front;
 * every case below requires the real deployed environment and fails loudly when the
 * environment or its configuration is missing - never a silent skip, never an
 * assertion-free placeholder.
 *
 * Selector provenance (reused mature page operations, do not re-derive):
 * - login / project card / create: stage1.spec.ts `signIn`, `createProject`,
 *   `projectCard`
 * - run tab / Run state / Start run: stage6-real-backend.spec.ts and the
 *   stage6b-cloud-lifecycle.spec.ts run operations
 * - create-form runtime controls: CreateProjectForm.tsx (Template select, Public
 *   access / MySQL / Redis checkboxes, Container port N / Public port N rows,
 *   Create result status)
 * - project card runtime view: ProjectCard.tsx (runtime line, dependency line,
 *   endpoint line)
 * - deletion: DeleteProjectDialog.tsx (alertdialog "Delete project?" -> Delete
 *   permanently), matching the ProjectsPage deletion unit tests
 *
 * Public ports are NEVER scanned or auto-selected: the operator fixes both test
 * NodePorts via MANAO_RUNTIME_PUBLIC_PORT_1 / MANAO_RUNTIME_PUBLIC_PORT_2 before the
 * run, and the suite fails up front when either is missing.
 */

const BASE_URL = process.env.MANAO_RUNTIME_BASE_URL;
const USERNAME = process.env.MANAO_RUNTIME_USERNAME;
const PASSWORD = process.env.MANAO_RUNTIME_PASSWORD;
const PUBLIC_PORT_1 = process.env.MANAO_RUNTIME_PUBLIC_PORT_1;
const PUBLIC_PORT_2 = process.env.MANAO_RUNTIME_PUBLIC_PORT_2;

const DEMO_PATH = '/api/demo';
const DEMO_GREETING = 'Hello from Manao';
// Port 1 maps the template's own HTTP listener (8080). Port 2 maps 9090, which the
// template app does NOT listen on until the run test adds a second Tomcat connector
// through the workspace file API (a Service cannot declare the same service port
// twice, so both mappings must point at distinct real listeners - plan Task 9:
// "另一端口9090由示例代码真实监听"). The public ports stay what the operator assigned.
const WEB_CONTAINER_PORT = '8080';
const SECOND_CONTAINER_PORT = '9090';
const SECOND_PORT_CONFIG_PATH = 'src/main/java/com/example/app/AdditionalPortConfig.java';
const SECOND_PORT_CONFIG_SOURCE = `package com.example.app;

import org.apache.catalina.connector.Connector;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Acceptance extension: the app genuinely listens on a second HTTP port (9090). */
@Configuration
public class AdditionalPortConfig {

    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> secondHttpPort() {
        return factory -> {
            Connector connector = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
            connector.setPort(9090);
            factory.addAdditionalTomcatConnectors(connector);
        };
    }
}
`;
// The platform ingress port must stay out of the test range; the backend would
// reject it as reserved, but naming it is the clearer operator error.
const PLATFORM_INGRESS_PORT = '30080';
// The demo app may become reachable a while after RUNNING (readiness is verified
// server-side before the route is armed); this bounds the first successful probe.
const FIRST_SERVICE_PROBE_TIMEOUT = 120_000;
// Serve-through loop cadence and transient-jitter tolerance. A poll counts as failed
// only when both ports fail within the poll; three consecutive failed polls are a
// real outage and fail the case. A single lost packet must not.
const SERVE_POLL_INTERVAL_MS = 60_000;
const SERVE_MAX_CONSECUTIVE_FAILED_POLLS = 3;
// After the immutable lifetime deadline the run settles asynchronously; bound the wait.
const SETTLEMENT_TIMEOUT = 600_000;
// Clock/polling slack when asserting that settlement happened no earlier than the
// readiness deadline.
const DEADLINE_SLACK_MS = 60_000;
// Post-settlement, the gateway withdraws the route; NodePorts with no endpoints refuse
// or blackhole depending on the network layer, so "down" means failing or non-2xx.
const WITHDRAWAL_PROBE_TIMEOUT = 90_000;

// Load-safe gate: other configs (e.g. the default localhost config, where
// MANAO_RUNTIME_BASE_URL is unset) also scan tests/e2e, so this file must never
// throw at module scope and must not parse configuration eagerly. The java-runtime
// config itself throws on a missing MANAO_RUNTIME_BASE_URL (fail fast), so the skip
// below only ever fires for other configs' collection - the acceptance run itself
// can never skip silently.
test.skip(
  !BASE_URL,
  'java-runtime cloud lifecycle requires MANAO_RUNTIME_BASE_URL plus credentials and ports; '
    + 'run via pnpm test:e2e:java-runtime',
);

// Parsed in beforeAll (never at module scope): missing/invalid values must fail the
// acceptance run loudly at runtime, while other configs still collect this file safely.
let publicPortNumber1 = 0;
let publicPortNumber2 = 0;
let publicOriginValue = '';

type RunSummaryLike = {
  id: string;
  state: string;
  policy: { executionKind?: string };
  firstReadyAt: string | null;
  expiresAt: string | null;
  finishedAt: string | null;
  terminationReason: string | null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared scene state across the serial tests (workers: 1 guarantees ordering).
const SCENE = {
  projectName: `java-runtime-${shortTimestamp()}-${randomSuffix()}`,
  projectId: '',
  accessToken: '',
  webRunId: '',
};

test.describe.serial('java runtime cloud lifecycle', () => {
  // Runtime configuration guard: reached only when MANAO_RUNTIME_BASE_URL is set
  // (module-level skip keeps the default config load-safe). Missing credentials or
  // ports must fail the run loudly, never silently skip to a green exit.
  test.beforeAll(() => {
    if (!USERNAME || !PASSWORD) {
      throw new Error(
        '环境变量 MANAO_RUNTIME_USERNAME / MANAO_RUNTIME_PASSWORD 未设置：'
          + 'MANAO_RUNTIME_BASE_URL 已配置时必须同时提供私有运行环境注入的真实凭据，'
          + 'Java 运行时云端 E2E 拒绝在凭据缺失时静默跳过。',
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
      `[java-runtime] entry=${BASE_URL} ports=${publicPortNumber1}/${publicPortNumber2}`
        + ` project="${SCENE.projectName}"`,
    );
  });

  test('login on the public entry and verify the runtime workbench is served', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/projects$/);

    // The deployed entry must expose the runtime-capable creation form, not just the
    // legacy console-only view.
    const templateSelect = page.getByLabel('Template');
    await expect(templateSelect).toBeVisible();
    await expect(templateSelect.locator('option', { hasText: 'Java Spring Boot web' })).toHaveCount(1);
    console.log(`[java-runtime] login and runtime workbench verified on ${BASE_URL}`);
  });

  test('create the marked web project with MySQL, Redis and the two assigned public ports', async ({ page }, testInfo) => {
    // Provisioning includes the per-project MySQL StatefulSet and Redis Deployment;
    // image pulls on a cold cluster make minutes the honest budget (measured 2026-09-22:
    // a cold mysql:8.0.40 pull pushed first-readiness past 13 minutes, so the dependency
    // waits below get 840s each and the test 1500s overall).
    test.setTimeout(1_500_000);
    await signIn(page);

    await page.getByLabel('Project name').fill(SCENE.projectName);
    await page.getByLabel('Template').selectOption({ label: 'Java Spring Boot web' });
    await page.getByLabel('Public access').check();
    await page.getByLabel('MySQL').check();
    await page.getByLabel('Redis').check();

    await page.getByLabel('Container port 1').fill(WEB_CONTAINER_PORT);
    await page.getByLabel('Public port 1').fill(String(publicPortNumber1));
    await page.getByRole('button', { name: 'Add port' }).click();
    await page.getByLabel('Container port 2').fill(SECOND_CONTAINER_PORT);
    await page.getByLabel('Public port 2').fill(String(publicPortNumber2));

    await page.getByRole('button', { name: 'Create project' }).click();
    const result = page.locator('p[role="status"][aria-label="Create result"]');
    await expect(result).toContainText(`Created ${SCENE.projectName}`);
    await expect(result).toContainText(String(publicPortNumber1));
    await expect(result).toContainText(String(publicPortNumber2));

    // Project READY plus both selected dependencies READY on the card's runtime view.
    const card = projectCard(page, SCENE.projectName);
    await expect(card).toBeVisible();
    await expect(card.getByText('READY', { exact: true })).toBeVisible({ timeout: 600_000 });
    await expect(card.getByText('MySQL READY')).toBeVisible({ timeout: 840_000 });
    await expect(card.getByText('Redis READY')).toBeVisible({ timeout: 840_000 });
    // The exact user-selected NodePorts were provisioned, not substituted.
    await expect(card).toContainText(String(publicPortNumber1));
    await expect(card).toContainText(String(publicPortNumber2));

    const open = card.getByRole('link', { name: 'Open' });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    SCENE.projectId = page.url().split('/').pop() ?? '';
    expect(SCENE.projectId, 'project id must be derivable from the project URL').not.toBe('');
    await expect(page.getByRole('heading', { name: SCENE.projectName })).toBeVisible();

    await testInfo.attach('java-runtime-project.json', {
      body: Buffer.from(JSON.stringify({
        projectName: SCENE.projectName,
        projectId: SCENE.projectId,
        publicPorts: [publicPortNumber1, publicPortNumber2],
      })),
      contentType: 'application/json',
    });
    console.log(
      `[java-runtime] project "${SCENE.projectName}" id=${SCENE.projectId} READY with`
        + ` MySQL/Redis and ports ${publicPortNumber1}/${publicPortNumber2}`,
    );
  });

  test('start the bounded web run and serve the demo app through both assigned ports', async ({ page }, testInfo) => {
    test.setTimeout(900_000); // cloud Maven build plus app startup may take minutes
    await signIn(page);

    // The second public port maps container port 9090, which the template does not
    // listen on yet: add the second Tomcat connector through the same workspace file
    // API the editor drives, so the run genuinely serves both assigned ports. The edit
    // happens BEFORE the project page loads, so the UI's Start-run revision is current
    // (an edit after loading would leave the page holding a stale revision).
    const created = await authedPost(page, `/api/v1/projects/${SCENE.projectId}/entries`, {
      kind: 'file',
      path: SECOND_PORT_CONFIG_PATH,
      expectedWorkspaceRevision: await currentWorkspaceRevision(page),
    });
    expect(created.ok(), 'the additional-port source file must be creatable').toBeTruthy();
    const saved = await authedPut(
      page,
      `/api/v1/projects/${SCENE.projectId}/files/content?path=${encodeURIComponent(SECOND_PORT_CONFIG_PATH)}`,
      {
        content: SECOND_PORT_CONFIG_SOURCE,
        expectedWorkspaceRevision: (await created.json()).workspaceRevision,
      },
    );
    expect(saved.ok(), 'the additional-port source file must be savable').toBeTruthy();
    console.log(`[java-runtime] added ${SECOND_PORT_CONFIG_PATH} so the app listens on ${SECOND_CONTAINER_PORT}`);

    await openProject(page);
    await page.getByRole('tab', { name: 'Run' }).click();
    const start = page.getByRole('button', { name: 'Start run' });
    await expect(start).toBeEnabled();
    await start.click();
    const runState = page.getByRole('status', { name: 'Run state' });
    await expect(runState).toBeVisible();
    await expect(runState).toContainText('RUNNING', { timeout: 780_000 });

    // Corroboration: this is a SERVICE run with a verified readiness lifetime, and the
    // deadline is armed at first verified readiness - never before.
    const activeRun = await pollForActiveReadyRun(page);
    expect(activeRun.policy.executionKind, 'the web template must run as a bounded SERVICE run')
      .toBe('SERVICE');
    expect(activeRun.firstReadyAt, 'readiness must be verified before the ports serve').toBeTruthy();
    expect(activeRun.expiresAt, 'the immutable lifetime deadline must be armed at readiness')
      .toBeTruthy();
    SCENE.webRunId = activeRun.id;

    await expectPortServesDemo(page, publicPortNumber1);
    await expectPortServesDemo(page, publicPortNumber2);

    await testInfo.attach('java-runtime-web-run.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.projectId,
        runId: SCENE.webRunId,
        executionKind: activeRun.policy.executionKind,
        firstReadyAt: activeRun.firstReadyAt,
        expiresAt: activeRun.expiresAt,
        publicPorts: [publicPortNumber1, publicPortNumber2],
      })),
      contentType: 'application/json',
    });
    console.log(
      `[java-runtime] run ${SCENE.webRunId} serves ${DEMO_PATH} through ports`
        + ` ${publicPortNumber1}/${publicPortNumber2}; lifetime ends at ${activeRun.expiresAt}`,
    );
    // The run is intentionally left active: the next test continues this exact run
    // through its whole lifetime.
  });

  test('the bounded web session serves through both ports for its whole lifetime and stops at the readiness deadline', async ({ page }, testInfo) => {
    // 120 min immutable lifetime + startup allowance + settlement/withdrawal checks,
    // under the 3.5h global cap; runs once, no retry.
    test.setTimeout(9_300_000);
    await signIn(page);
    await openProject(page);

    // The run from the previous test is still the project's single active run; its
    // deadline is immutable, so re-read it here and serve through the remaining window.
    const activeRun = await pollForActiveReadyRun(page);
    expect(activeRun.id, 'the bounded session must continue the run started by the previous test')
      .toBe(SCENE.webRunId);
    const deadlineMs = Date.parse(activeRun.expiresAt!);
    expect(deadlineMs, 'the SERVICE run must carry its immutable readiness deadline').not.toBeNaN();

    let failedPolls = 0;
    let servedPolls = 0;
    while (Date.now() < deadlineMs) {
      const served = (await probePort(page, publicPortNumber1))
        && (await probePort(page, publicPortNumber2));
      if (served) {
        servedPolls += 1;
        failedPolls = 0;
      } else {
        failedPolls += 1;
        console.warn(
          `[java-runtime] serve-through poll failed (${failedPolls}/${SERVE_MAX_CONSECUTIVE_FAILED_POLLS})`,
        );
        expect(
          failedPolls,
          'the bounded web session stopped serving through the public ports before its deadline',
        ).toBeLessThan(SERVE_MAX_CONSECUTIVE_FAILED_POLLS);
      }
      const remaining = deadlineMs - Date.now();
      if (remaining > 0) {
        await sleep(Math.min(SERVE_POLL_INTERVAL_MS, remaining));
      }
    }

    // The deadline passed: the run must settle (finishedAt armed) by its
    // readiness-based lifetime.
    await expect.poll(async () => (await fetchRun(page, SCENE.webRunId)).finishedAt, {
      timeout: SETTLEMENT_TIMEOUT,
      intervals: [10_000, 30_000],
    }).toBeTruthy();
    const finalRun = await fetchRun(page, SCENE.webRunId);
    // Settlement may not precede the immutable deadline (slack only for clock/polling
    // granularity - the deadline itself is armed server-side and never renewed).
    expect(
      Date.parse(finalRun.finishedAt!),
      'settlement must respect the readiness deadline, not end before it',
    ).toBeGreaterThanOrEqual(deadlineMs - DEADLINE_SLACK_MS);

    // The gateway withdraws the route at settlement: neither public port may serve anymore.
    await expect(async () => {
      const stillServing = (await probePort(page, publicPortNumber1))
        || (await probePort(page, publicPortNumber2));
      expect(stillServing, 'the public ports must stop serving after the session settles').toBe(false);
    }).toPass({ timeout: WITHDRAWAL_PROBE_TIMEOUT, intervals: [5_000, 10_000] });

    await testInfo.attach('java-runtime-lifetime.json', {
      body: Buffer.from(JSON.stringify({
        projectId: SCENE.projectId,
        runId: SCENE.webRunId,
        expiresAt: activeRun.expiresAt,
        finishedAt: finalRun.finishedAt,
        finalState: finalRun.state,
        terminationReason: finalRun.terminationReason,
        servedPolls,
      })),
      contentType: 'application/json',
    });
    console.log(
      `[java-runtime] bounded session ${SCENE.webRunId} served ${servedPolls} polls until`
        + ` ${activeRun.expiresAt}, settled as ${finalRun.state}`
        + ` (${finalRun.terminationReason ?? 'no reason recorded'}), ports withdrawn`,
    );
  });

  test('delete the project from the UI and confirm the card stays gone', async ({ page }, testInfo) => {
    await signIn(page);

    const card = projectCard(page, SCENE.projectName);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Delete project' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete project?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(card).toBeHidden();
    await page.reload();
    await signIn(page);
    await expect(projectCard(page, SCENE.projectName)).toBeHidden();

    // UI deletion is the acceptance path; cluster-side reclamation of the MySQL
    // StatefulSet, Redis Deployment, Secrets, NetworkPolicies and claims is verified
    // by the Task 9 operator checklist, not from the browser.
    await testInfo.attach('java-runtime-deletion.json', {
      body: Buffer.from(JSON.stringify({ projectName: SCENE.projectName, deleted: true })),
      contentType: 'application/json',
    });
    console.log(
      `[java-runtime] project "${SCENE.projectName}" deleted from the UI;`
        + ' cluster-side reclamation is Task 9\'s checklist',
    );
  });
});

// ---------------------------------------------------------------------------
// Page operations reused from existing mature specs (see file header).
// ---------------------------------------------------------------------------

function projectCard(page: Page, name: string) {
  return page.getByRole('article', { name });
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

async function openProject(page: Page): Promise<void> {
  const card = projectCard(page, SCENE.projectName);
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${SCENE.projectId}$`));
  await expect(page.getByRole('heading', { name: SCENE.projectName })).toBeVisible();
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

/** Current workspace revision for optimistic writes (files/tree carries it). */
async function currentWorkspaceRevision(page: Page): Promise<string> {
  const response = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/files/tree`);
  expect(response.ok(), 'workspace tree must be readable before file edits').toBeTruthy();
  return ((await response.json()) as { workspaceRevision: string }).workspaceRevision;
}

/** The single active SERVICE run with its readiness deadline armed. */
async function pollForActiveReadyRun(page: Page): Promise<RunSummaryLike> {
  await expect(async () => {
    const response = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/runs/active`);
    expect(response.ok(), 'active-run corroboration must succeed').toBeTruthy();
    const body = (await response.json()) as { run: RunSummaryLike | null };
    expect(
      body.run,
      'the bounded web session must still be the project\'s single active run',
    ).not.toBeNull();
    expect(body.run!.firstReadyAt, 'waiting for the verified readiness to arm the deadline').toBeTruthy();
  }).toPass({ timeout: 900_000, intervals: [10_000, 30_000] });
  const response = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/runs/active`);
  return ((await response.json()) as { run: RunSummaryLike }).run!;
}

async function fetchRun(page: Page, runId: string): Promise<RunSummaryLike> {
  const response = await authedGet(page, `/api/v1/projects/${SCENE.projectId}/runs/${runId}`);
  expect(response.ok(), 'run corroboration must succeed').toBeTruthy();
  return (await response.json()) as RunSummaryLike;
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
