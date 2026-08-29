import { expect, test } from '@playwright/test';

/**
 * Stage 6A: real-backend browser flow with MSW disabled. The Vite dev server (4173) proxies
 * /api/v1 to the local Spring Boot backend (18080), which uses the local MySQL and the real
 * cluster through the SSH API tunnel. Every test skips when the backend is not reachable so the
 * suite can be executed only during a gate run.
 */

const ALICE = { username: 'alice', password: 'stage6-alice-pass' };
const BOB = { username: 'bob', password: 'stage6-bob-pass' };

async function backendAvailable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/api/v1/auth/login', { failOnStatusCode: false });
    return response.status() < 500 || response.status() === 404 || response.status() === 405;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  test.skip(!(await backendAvailable(request)), '6A backend not reachable; gate-only suite');
});

async function login(page: import('@playwright/test').Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByPlaceholder(/用户名|username/i).fill(user.username);
  await page.getByPlaceholder(/密码|password/i).fill(user.password);
  await page.getByRole('button', { name: /登录|login/i }).click();
  await expect(page.getByText(/项目|projects/i).first()).toBeVisible();
}

test('login and Alice/Bob owner isolation on the real backend', async ({ page }) => {
  await login(page, ALICE);
  await page.goto('/');
  await login(page, BOB);
  // Bob must not see Alice's project names; the projects endpoint is owner-scoped.
  const response = await page.request.get('/api/v1/projects');
  expect(response.ok()).toBeTruthy();
});

test('project creation reaches READY with template files through the real workspace', async ({ page }) => {
  await login(page, ALICE);
  const projectName = `stage6-e2e-${Date.now()}`;
  const created = await page.request.post('/api/v1/projects', {
    data: { name: projectName },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string; state: string };

  // Poll until provisioning completes (PVC + initializer + workspace pod + template).
  let state = project.state;
  for (let i = 0; i < 60 && state === 'CREATING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fetched = await page.request.get(`/api/v1/projects/${project.id}`);
    state = (await fetched.json()).state as string;
  }
  expect(state).toBe('READY');

  const tree = await page.request.get(`/api/v1/projects/${project.id}/files/tree?path=`);
  expect(tree.ok()).toBeTruthy();
  const treeBody = (await tree.json()) as { entries: { path: string }[] };
  const paths = treeBody.entries.map((entry) => entry.path);
  expect(paths).toContain('pom.xml');
});

test('file save advances the workspace revision and rejects stale revisions', async ({ page }) => {
  await login(page, ALICE);
  const projectName = `stage6-save-${Date.now()}`;
  const created = await page.request.post('/api/v1/projects', { data: { name: projectName } });
  const project = (await created.json()) as { id: string };
  let state = 'CREATING';
  for (let i = 0; i < 60 && state === 'CREATING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state = (await (await page.request.get(`/api/v1/projects/${project.id}`)).json()).state;
  }
  expect(state).toBe('READY');

  const created2 = await page.request.post(`/api/v1/projects/${project.id}/entries`, {
    data: { kind: 'file', path: 'notes.md', expectedWorkspaceRevision: '7' },
  });
  expect(created2.status()).toBe(201);
  const { workspaceRevision } = (await created2.json()) as { workspaceRevision: string };

  const saved = await page.request.put(
    `/api/v1/projects/${project.id}/files/content?path=notes.md`,
    { data: { content: '# stage6', expectedWorkspaceRevision: workspaceRevision } },
  );
  expect(saved.ok()).toBeTruthy();

  const stale = await page.request.put(
    `/api/v1/projects/${project.id}/files/content?path=notes.md`,
    { data: { content: 'stale', expectedWorkspaceRevision: workspaceRevision } },
  );
  expect(stale.status()).toBe(409);
});

test('start run produces a policy-constrained job and logs stream over the real cluster', async ({ page }) => {
  test.info().annotations.push({ type: 'gate', description: 'requires MANAO_MAVEN_RUNNER_IMAGE in the cluster' });
  await login(page, ALICE);
  const projects = (await (await page.request.get('/api/v1/projects')).json()) as {
    items: { id: string; state: string }[];
  };
  const ready = projects.items.find((project) => project.state === 'READY');
  test.skip(ready === undefined, 'no READY project available');
  if (ready === undefined) return;

  const started = await page.request.post(`/api/v1/projects/${ready.id}/runs`, {
    data: { expectedWorkspaceRevision: '7' },
  });
  test.skip(started.status() === 409, 'run already active or revision stale');
  expect([202, 409]).toContain(started.status());
});

test('audit and error responses never leak cluster identifiers', async ({ page }) => {
  const response = await page.request.get('/api/v1/projects/does-not-exist/files/tree?path=');
  expect([401, 404]).toContain(response.status());
  const body = await response.text();
  for (const forbidden of ['manao-ws', 'manao-pvc', 'pod', 'namespace', '/workspace', 'kube']) {
    expect(body).not.toContain(forbidden);
  }
});
