import { expect, test } from '@playwright/test';

/**
 * Stage 6A: real-backend browser flow with MSW disabled. The Vite dev server (4173) proxies
 * /api/v1 to the local Spring Boot backend (18080), which uses the local MySQL and the real
 * cluster through the SSH API tunnel. Outside a gate run (STAGE6_GATE != 1) the suite skips
 * when the backend is unreachable; inside a gate run an unreachable backend fails loudly.
 */

const ALICE = { username: 'alice', password: 'stage6-alice-pass' };
const BOB = { username: 'bob', password: 'stage6-bob-pass' };
const GATE_MODE = process.env.STAGE6_GATE === '1';

async function backendReachable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    // A wrong-method probe on a real route distinguishes "backend present" from a proxy error.
    const response = await request.get('/api/v1/projects');
    return [200, 401].includes(response.status());
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  const reachable = await backendReachable(request);
  if (!reachable) {
    test.skip(!GATE_MODE, '6A backend not reachable; gate-only suite');
    // In gate mode an unreachable backend is a failure, never a silent skip.
    expect(reachable, '6A gate: backend must be reachable').toBe(true);
  }
});

async function login(page: import('@playwright/test').Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByPlaceholder(/用户名|username/i).fill(user.username);
  await page.getByPlaceholder(/密码|password/i).fill(user.password);
  await page.getByRole('button', { name: /登录|login/i }).click();
  await expect(page.getByText(/项目|projects/i).first()).toBeVisible();
}

async function createProject(page: import('@playwright/test').Page, name: string): Promise<{ id: string; state: string }> {
  const created = await page.request.post('/api/v1/projects', { data: { name } });
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string; state: string };
}

async function awaitReady(page: import('@playwright/test').Page, projectId: string): Promise<string> {
  let state = 'CREATING';
  for (let i = 0; i < 60 && state === 'CREATING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fetched = await page.request.get(`/api/v1/projects/${projectId}`);
    state = (await fetched.json()).state as string;
  }
  return state;
}

test('login and Alice/Bob owner isolation on the real backend', async ({ page }) => {
  await login(page, ALICE);
  const aliceProject = await createProject(page, `stage6-iso-${Date.now()}`);
  const aliceState = await awaitReady(page, aliceProject.id);
  expect(aliceState, 'owner isolation requires a READY project').toBe('READY');

  // Bob authenticates as himself and must not see Alice's project in his list.
  await login(page, BOB);
  const bobList = (await (await page.request.get('/api/v1/projects')).json()) as {
    items: { id: string }[];
  };
  expect(bobList.items.map((project) => project.id)).not.toContain(aliceProject.id);
  // Bob's direct lookup of Alice's project is hidden as 404.
  const bobDirect = await page.request.get(`/api/v1/projects/${aliceProject.id}`);
  expect([401, 404]).toContain(bobDirect.status());
  // Bob's file access to Alice's project is likewise hidden.
  const bobFiles = await page.request.get(`/api/v1/projects/${aliceProject.id}/files/tree?path=`);
  expect([401, 404]).toContain(bobFiles.status());
});

test('project creation reaches READY with template files through the real workspace', async ({ page }) => {
  await login(page, ALICE);
  const project = await createProject(page, `stage6-e2e-${Date.now()}`);
  const state = await awaitReady(page, project.id);
  // FAILED here means the creation pipeline must be fixed, not that the test is skipped.
  expect(state, 'provisioning must reach READY on the real cluster').toBe('READY');

  const tree = await page.request.get(`/api/v1/projects/${project.id}/files/tree?path=`);
  expect(tree.ok()).toBeTruthy();
  const treeBody = (await tree.json()) as { entries: { path: string }[] };
  expect(treeBody.entries.map((entry) => entry.path)).toContain('pom.xml');
});

test('file save advances the workspace revision and rejects stale revisions', async ({ page }) => {
  await login(page, ALICE);
  const project = await createProject(page, `stage6-save-${Date.now()}`);
  expect(await awaitReady(page, project.id)).toBe('READY');

  const revisionBefore = (await (await page.request.get(`/api/v1/projects/${project.id}/files/tree?path=`)).json())
    .workspaceRevision as string;
  const created = await page.request.post(`/api/v1/projects/${project.id}/entries`, {
    data: { kind: 'file', path: 'notes.md', expectedWorkspaceRevision: revisionBefore },
  });
  expect(created.status()).toBe(201);
  const { workspaceRevision } = (await created.json()) as { workspaceRevision: string };

  const saved = await page.request.put(`/api/v1/projects/${project.id}/files/content?path=notes.md`, {
    data: { content: '# stage6', expectedWorkspaceRevision: workspaceRevision },
  });
  expect(saved.ok()).toBeTruthy();

  const stale = await page.request.put(`/api/v1/projects/${project.id}/files/content?path=notes.md`, {
    data: { content: 'stale', expectedWorkspaceRevision: workspaceRevision },
  });
  expect(stale.status()).toBe(409);
});

test('start run produces a policy-constrained run that progresses on the real cluster', async ({ page }) => {
  await login(page, ALICE);
  const project = await createProject(page, `stage6-run-${Date.now()}`);
  const state = await awaitReady(page, project.id);
  expect(state, 'run test requires a READY project').toBe('READY');

  const tree = (await (await page.request.get(`/api/v1/projects/${project.id}/files/tree?path=`)).json())
    .workspaceRevision as string;
  const started = await page.request.post(`/api/v1/projects/${project.id}/runs`, {
    data: { expectedWorkspaceRevision: tree },
  });
  // 409 before any Job exists is a bug, not a race: the run was just created.
  expect(started.status()).toBe(202);
  const run = (await started.json()) as { id: string; state: string; policy: { command: string } };
  expect(run.state).toBe('STARTING');
  expect(run.policy.command).toBe('mvn clean test');

  // The observation loop must drive the run out of STARTING on the real cluster.
  let finalState = run.state;
  for (let i = 0; i < 150 && ['STARTING', 'RUNNING'].includes(finalState); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    finalState = (await (await page.request.get(`/api/v1/projects/${project.id}/runs/${run.id}`)).json()).state;
  }
  // A still-RUNNING run after the observation window is a stall symptom, not a pass.
  expect(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']).toContain(finalState);
});

test('error responses never leak cluster identifiers', async ({ request }) => {
  const response = await request.get('/api/v1/projects/does-not-exist/files/tree?path=');
  expect([401, 404]).toContain(response.status());
  const body = await response.text();
  for (const forbidden of ['manao-ws', 'manao-pvc', 'manao-run', 'namespace', '/workspace', 'kube']) {
    expect(body).not.toContain(forbidden);
  }
});
