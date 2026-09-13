import { expect, test } from '../support/stage6-cleanup/fixtures';

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
    expect(reachable, '6A gate: backend must be reachable').toBe(true);
  }
});

async function login(page: import('@playwright/test').Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel(/Username|用户名/i).fill(user.username);
  await page.getByLabel(/Password|密码/i).fill(user.password);
  await page.getByRole('button', { name: /Sign in|登录|login/i }).click();
  await expect(page.getByText(/Projects|项目/i).first()).toBeVisible();
}

/** Fetches a fresh JWT for API calls; the in-memory auth store never persists it. */
async function apiToken(page: import('@playwright/test').Page, user: { username: string; password: string }): Promise<string> {
  const res = await page.request.post('/api/v1/auth/login', { data: { username: user.username, password: user.password } });
  expect(res.status(), 'login must issue a token').toBe(200);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function authHeaders(token: string) {
  return { Authorization: 'Bearer ' + token };
}

async function awaitReady(page: import('@playwright/test').Page, projectId: string, token: string): Promise<string> {
  let state = 'CREATING';
  for (let i = 0; i < 60 && state === 'CREATING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fetched = await page.request.get('/api/v1/projects/' + projectId, { headers: authHeaders(token) });
    state = (await fetched.json()).state as string;
  }
  return state;
}

test('login and Alice/Bob owner isolation on the real backend', async ({ page, resources }) => {
  await login(page, ALICE);
  const aliceToken = await apiToken(page, ALICE);
  const aliceProject = await resources.createProject('alice', 'owner-isolation');
  const aliceState = await awaitReady(page, aliceProject.id, aliceToken);
  expect(aliceState, 'owner isolation requires a READY project').toBe('READY');

  await login(page, BOB);
  const bobToken = await apiToken(page, BOB);
  const bobList = (await (await page.request.get('/api/v1/projects', { headers: authHeaders(bobToken) })).json()) as {
    items: { id: string }[];
  };
  expect(bobList.items.map((project) => project.id)).not.toContain(aliceProject.id);
  const bobDirect = await page.request.get('/api/v1/projects/' + aliceProject.id, { headers: authHeaders(bobToken) });
  expect([401, 404]).toContain(bobDirect.status());
  const bobFiles = await page.request.get('/api/v1/projects/' + aliceProject.id + '/files/tree?path=', { headers: authHeaders(bobToken) });
  expect([401, 404]).toContain(bobFiles.status());
});

test('project creation reaches READY with template files through the real workspace', async ({ page, resources }) => {
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await resources.createProject('alice', 'template-files');
  const state = await awaitReady(page, project.id, token);
  expect(state, 'provisioning must reach READY on the real cluster').toBe('READY');

  const tree = await page.request.get('/api/v1/projects/' + project.id + '/files/tree?path=', { headers: authHeaders(token) });
  expect(tree.ok()).toBeTruthy();
  const treeBody = (await tree.json()) as { entries: { path: string }[] };
  expect(treeBody.entries.map((entry) => entry.path)).toContain('pom.xml');
});

test('file save advances the workspace revision and rejects stale revisions', async ({ page, resources }) => {
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await resources.createProject('alice', 'file-save');
  expect(await awaitReady(page, project.id, token)).toBe('READY');

  const revisionBefore = (await (await page.request.get('/api/v1/projects/' + project.id + '/files/tree?path=', { headers: authHeaders(token) })).json())
    .workspaceRevision as string;
  const created = await page.request.post('/api/v1/projects/' + project.id + '/entries', {
    data: { kind: 'file', path: 'notes.md', expectedWorkspaceRevision: revisionBefore },
    headers: authHeaders(token),
  });
  expect(created.status()).toBe(201);
  const { workspaceRevision } = (await created.json()) as { workspaceRevision: string };

  const saved = await page.request.put('/api/v1/projects/' + project.id + '/files/content?path=notes.md', {
    data: { content: '# stage6', expectedWorkspaceRevision: workspaceRevision },
    headers: authHeaders(token),
  });
  expect(saved.ok()).toBeTruthy();

  const stale = await page.request.put('/api/v1/projects/' + project.id + '/files/content?path=notes.md', {
    data: { content: 'stale', expectedWorkspaceRevision: workspaceRevision },
    headers: authHeaders(token),
  });
  expect(stale.status()).toBe(409);
});

test('start run produces a policy-constrained run that progresses on the real cluster', async ({ page, resources }) => {
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await resources.createProject('alice', 'start-run');
  const state = await awaitReady(page, project.id, token);
  expect(state, 'run test requires a READY project').toBe('READY');

  const tree = (await (await page.request.get('/api/v1/projects/' + project.id + '/files/tree?path=', { headers: authHeaders(token) })).json())
    .workspaceRevision as string;
  const started = await page.request.post('/api/v1/projects/' + project.id + '/runs', {
    data: { expectedWorkspaceRevision: tree },
    headers: authHeaders(token),
  });
  expect(started.status()).toBe(202);
  const run = (await started.json()) as { id: string; state: string; policy: { command: string } };
  await resources.recordRun(project.id, run.id);
  expect(run.state).toBe('STARTING');
  expect(run.policy.command).toBe('mvn clean test');

  let finalState = run.state;
  for (let i = 0; i < 150 && ['STARTING', 'RUNNING', 'STOPPING', 'RECOVERING'].includes(finalState); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    finalState = (await (await page.request.get('/api/v1/projects/' + project.id + '/runs/' + run.id, { headers: authHeaders(token) })).json()).state;
  }
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
