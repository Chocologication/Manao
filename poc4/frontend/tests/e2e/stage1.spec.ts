import { expect, test, type Locator, type Page } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const MOCK_FAILURE_REASON = 'Mock workspace provisioning failed';
const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
const ACCESS_DENIED_LEAK = /not found|does not exist|bob|prj-bob|exist/i;

const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
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
  await expect(projectCard(page, 'Alice Notebook').getByText('READY', { exact: true })).toBeVisible();
  return accessToken;
}

async function createProject(page: Page, name: string): Promise<Locator> {
  await page.getByLabel('Project name').fill(name);
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
  const headerBox = await page.locator('header').boundingBox();
  const mainBox = await page.locator('main').boundingBox();
  expect(headerBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  if (headerBox && mainBox) {
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(mainBox.y + 1);
  }
}

async function assertProjectStateLabelsUnclipped(page: Page): Promise<void> {
  const labels = page.locator('article p').filter({ hasText: /^(CREATING|READY|FAILED)$/ });
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
  await expect(alerts).toHaveText('Invalid username or password');
  await expect(alerts).not.toHaveText('wrong-pass');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('valid login returns to the original protected path or /projects', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
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
  await expect(page.getByText('READY', { exact: true })).toBeVisible();
});

test('create project shows CREATING then READY and allows project route navigation', async ({
  page,
}) => {
  await signInAsAliceOnProjects(page);

  const card = await createProject(page, 'Workspace Alpha');
  await expect(card.getByText('CREATING', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open' })).toBeDisabled();

  await expect(card.getByText('READY', { exact: true })).toBeVisible();
  const open = card.getByRole('link', { name: 'Open' });
  await expect(open).toBeVisible();
  await open.click();

  await expect(page).toHaveURL(/\/projects\/prj-\d+$/);
  await expect(page.getByRole('heading', { name: 'Workspace Alpha' })).toBeVisible();
  await expect(page.getByText('READY', { exact: true })).toBeVisible();
  await expect(page.getByTestId('terminal-spike-panel')).toHaveCount(0);
});

test('fail- project reaches FAILED and displays the deterministic reason', async ({ page }) => {
  await signInAsAliceOnProjects(page);

  const card = await createProject(page, 'fail-workspace');
  await expect(card.getByText('CREATING', { exact: true })).toBeVisible();
  await expect(card.getByText('FAILED', { exact: true })).toBeVisible();
  await expect(card.getByText(MOCK_FAILURE_REASON)).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Open' })).toHaveCount(0);
});

test('three projects disable creation and a bypassed fourth request returns the limit error', async ({
  page,
}) => {
  const accessToken = await signInAsAliceOnProjects(page);

  await createProject(page, 'Second Workspace');
  await createProject(page, 'Third Workspace');

  await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
  await expect(projectCard(page, 'Second Workspace')).toBeVisible();
  await expect(projectCard(page, 'Third Workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
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
      body: JSON.stringify({ name: 'Fourth Workspace' }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { code?: string; message?: string },
    };
  }, accessToken);

  expect(bypassed.status).toBe(409);
  expect(bypassed.body.code).toBe('PROJECT_LIMIT_REACHED');
  expect(bypassed.body.message).toBe('Project limit reached');
  await expect(projectCard(page, 'Fourth Workspace')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
});

test('forced 401 clears cached projects and redirects to login', async ({ page }) => {
  const accessToken = await signInAsAliceOnProjects(page);

  const probe = await createProject(page, 'Session Probe');
  await expect(probe.getByText('CREATING', { exact: true })).toBeVisible();

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
  await expect(alerts).toHaveText(SESSION_EXPIRED);
  await expect(alerts).not.toHaveText('mock-trace-unauthenticated');
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
  await expect(alert).not.toHaveText(ACCESS_DENIED_LEAK);
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bob Lab' })).toHaveCount(0);
  await expect(page.getByText('READY', { exact: true })).toHaveCount(0);
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
  await expect(projectCard(page, 'Bob Lab').getByText('READY', { exact: true })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(projectCard(page, 'Alice Notebook')).toBeVisible();
    await expect(projectCard(page, 'Alice Notebook').getByText('READY', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible();
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
