import { expect, test, type Locator, type Page } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const MOCK_FAILURE_REASON = 'Mock workspace provisioning failed';
const SESSION_EXPIRED = '登录会话已过期，请重新登录';
const ACCESS_DENIED_LEAK = /not found|does not exist|bob|prj-bob|exist/i;

const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

/** The card keeps the machine state next to the localized label (READY -> 环境就绪). */
function projectState(page: Page, name: string): Locator {
  return projectCard(page, name).locator('p[data-state]');
}

/** A READY project route mounts the workbench shell instead of printing a state label. */
async function expectWorkbenchMounted(page: Page): Promise<void> {
  await expect(page.getByRole('tablist', { name: 'Workbench panels' })).toBeVisible();
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
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

async function signInAsAliceOnProjects(page: Page): Promise<string> {
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
  await expect(projectState(page, 'Alice Notebook')).toHaveAttribute('data-state', 'READY');
  return accessToken;
}

/** Opens the create form and returns the guided wizard to its first step. */
async function resetCreateForm(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '新建项目' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  const restart = page.getByRole('button', { name: '创建另一个项目' });
  if ((await restart.count()) > 0) {
    await restart.click();
  }
  if ((await page.getByLabel('Project name').count()) === 0) {
    await page
      .getByRole('navigation', { name: '创建项目步骤' })
      .getByRole('button', { name: /项目名称/ })
      .click();
  }
}

async function createProject(page: Page, name: string): Promise<Locator> {
  await resetCreateForm(page);
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  const card = projectCard(page, name);
  await expect(card).toBeVisible();
  return card;
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

async function assertNoPanelOverlap(page: Page): Promise<void> {
  const headerCount = await page.locator('header').count();
  const mainCount = await page.locator('main').count();
  if (headerCount === 0 || mainCount === 0) {
    return;
  }
  // The redesigned shell nests the header inside <main>, so "header ends before main
  // starts" no longer describes the layout. Assert instead that the block following the
  // header is never covered by it, which still holds for the login page and the console.
  const boxes = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (header === null) {
      return null;
    }
    let sibling: Element | null = header.nextElementSibling;
    while (sibling !== null && sibling.getBoundingClientRect().height < 1) {
      sibling = sibling.nextElementSibling;
    }
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      siblingTop: sibling === null ? null : sibling.getBoundingClientRect().top,
    };
  });
  expect(boxes).not.toBeNull();
  if (boxes !== null && boxes.siblingTop !== null) {
    expect(boxes.headerBottom).toBeLessThanOrEqual(boxes.siblingTop + 1);
  }
}

async function assertProjectStateLabelsUnclipped(page: Page): Promise<void> {
  const labels = page.locator(
    'article p[data-state="CREATING"], article p[data-state="READY"], article p[data-state="FAILED"]',
  );
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    await expect(label).toBeVisible();
    const clipped = await label.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        return true;
      }
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
      ) {
        return true;
      }
      return (
        rect.left < -1 ||
        rect.top < -1 ||
        rect.right > window.innerWidth + 1 ||
        rect.bottom > window.innerHeight + 1
      );
    });
    expect(clipped).toBe(false);
  }
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

test('/projects redirects to /login when anonymous', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(projectCard(page, 'Alice Notebook')).toHaveCount(0);
});

test('invalid login stays on login and exposes one alert', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(ALICE.username);
  await page.getByLabel('Password').fill('wrong-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const alerts = page.getByRole('alert');
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toContainText('用户名或密码错误');
  await expect(alerts).not.toContainText('wrong-pass');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('valid login returns to the original protected path or /projects', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: '我的实验项目' })).toBeVisible();
  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.goto(`/projects/${ALICE_SEED_PROJECT_ID}`);
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, ALICE);
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expectWorkbenchMounted(page);
});

test('create project shows CREATING then READY and allows project route navigation', async ({
  page,
}) => {
  await signInAsAliceOnProjects(page);

  const card = await createProject(page, 'Workspace Alpha');
  await expect(card.locator('p[data-state]')).toHaveAttribute('data-state', 'CREATING');
  await expect(card.getByRole('button', { name: 'Open' })).toBeDisabled();

  await expect(card.locator('p[data-state]')).toHaveAttribute('data-state', 'READY');
  const open = card.getByRole('link', { name: 'Open' });
  await expect(open).toBeVisible();
  await open.click();

  await expect(page).toHaveURL(/\/projects\/prj-\d+$/);
  await expect(page.getByRole('heading', { name: 'Workspace Alpha' })).toBeVisible();
  await expectWorkbenchMounted(page);
  await expect(page.getByTestId('terminal-spike-panel')).toHaveCount(0);
});

test('fail- project reaches FAILED and displays the deterministic reason', async ({ page }) => {
  await signInAsAliceOnProjects(page);

  const card = await createProject(page, 'fail-workspace');
  await expect(card.locator('p[data-state]')).toHaveAttribute('data-state', 'CREATING');
  await expect(card.locator('p[data-state]')).toHaveAttribute('data-state', 'FAILED');
  await expect(card.getByText(MOCK_FAILURE_REASON)).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Open' })).toHaveCount(0);
});

test('eight projects disable creation and a bypassed ninth request returns the limit error', async ({
  page,
}) => {
  const accessToken = await signInAsAliceOnProjects(page);

  for (let index = 2; index <= 8; index += 1) {
    await createProject(page, `Workspace ${index}`);
    await expect(projectCard(page, `Workspace ${index}`)).toBeVisible();
  }

  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
  await resetCreateForm(page);
  await expect(page.locator('.lab-create-region').locator('button[type="submit"]')).toBeDisabled();
  await expect(page.getByLabel('Project name')).toBeDisabled();
  await expect(page.getByText('Project limit reached')).toBeVisible();

  const bypassed = await page.evaluate(async (token) => {
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: 'Ninth Workspace' }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { code?: string; message?: string },
    };
  }, accessToken);

  expect(bypassed.status).toBe(409);
  expect(bypassed.body.code).toBe('PROJECT_LIMIT_REACHED');
  expect(bypassed.body.message).toBe('Project limit reached');
  await expect(projectCard(page, 'Ninth Workspace')).toHaveCount(0);
  await expect(page.locator('.lab-create-region').locator('button[type="submit"]')).toBeDisabled();
});

test('forced 401 clears cached projects and redirects to login', async ({ page }) => {
  const accessToken = await signInAsAliceOnProjects(page);

  const probe = await createProject(page, 'Session Probe');
  await expect(probe.locator('p[data-state]')).toHaveAttribute('data-state', 'CREATING');

  const unauthorizedList = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return (
      pathname.replace(/\/$/, '') === '/api/v1/projects' &&
      response.request().method() === 'GET' &&
      response.status() === 401
    );
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

  expect((await unauthorizedList).status()).toBe(401);

  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  const alerts = page.getByRole('alert');
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toContainText(SESSION_EXPIRED);
  await expect(alerts).not.toContainText('mock-trace-unauthenticated');
  await expect(page.getByText('Alice Notebook')).toHaveCount(0);
  await expect(page.getByText('Session Probe')).toHaveCount(0);
});

test("Bob's project produces generic access denied for Alice", async ({ page }) => {
  await page.goto(`/projects/${BOB_SEED_PROJECT_ID}`);
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, ALICE);
  await expect(page).toHaveURL(new RegExp(`/projects/${BOB_SEED_PROJECT_ID}$`));

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Access denied');
  await expect(alert).not.toContainText(ACCESS_DENIED_LEAK);
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bob Lab' })).toHaveCount(0);
  await expect(page.locator('[data-state="READY"]')).toHaveCount(0);
});

test("logout followed by Bob login never shows Alice's cached projects", async ({ page }) => {
  await signInAsAliceOnProjects(page);
  await expect(projectCard(page, 'Bob Lab')).toHaveCount(0);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Alice Notebook')).toHaveCount(0);

  await signIn(page, BOB);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Bob Lab')).toBeVisible();
  await expect(projectState(page, 'Bob Lab')).toHaveAttribute('data-state', 'READY');
  await expect(projectCard(page, 'Alice Notebook')).toHaveCount(0);
  await expect(page.getByText('alice', { exact: true })).toHaveCount(0);
  await expect(page.getByText('bob', { exact: true })).toBeVisible();
});

for (const viewport of viewports) {
  test(`captures login and populated projects at ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertNoPanelOverlap(page);
    await captureViewport(
      page,
      `../docs/evidence/stage-1/${testInfo.project.name}-login-${viewport.name}.png`,
      viewport,
    );

    await signIn(page, ALICE);
    await expect(page.getByRole('heading', { name: '我的实验项目' })).toBeVisible();
    await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
    await expect(projectState(page, 'Alice Notebook')).toHaveAttribute('data-state', 'READY');
    await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertNoPanelOverlap(page);
    await assertProjectStateLabelsUnclipped(page);
    await captureViewport(
      page,
      `../docs/evidence/stage-1/${testInfo.project.name}-projects-${viewport.name}.png`,
      viewport,
    );
  });
}
