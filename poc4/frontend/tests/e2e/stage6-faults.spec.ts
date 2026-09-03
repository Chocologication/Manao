import { expect, test } from '@playwright/test';

/**
 * Stage 6A: fault-injection and isolation checks over the real backend. Reuses the
 * stage6-real-backend helpers (gate guard, login, token, project/run lifecycle) and drives
 * the terminal WebSocket disconnect, cross-project bridge isolation, and operator-injected
 * fault phases. Outside a gate run (STAGE6_GATE != 1) the suite skips when the backend is
 * unreachable; inside a gate run an unreachable backend fails loudly.
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

async function createProject(page: import('@playwright/test').Page, name: string, token: string): Promise<{ id: string; state: string }> {
  const created = await page.request.post('/api/v1/projects', { data: { name }, headers: authHeaders(token) });
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string; state: string };
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

/** Starts the policy-constrained run (mvn clean test) and returns its id/state. */
async function startRun(page: import('@playwright/test').Page, projectId: string, token: string): Promise<{ id: string; state: string }> {
  const tree = (await (await page.request.get('/api/v1/projects/' + projectId + '/files/tree?path=', { headers: authHeaders(token) })).json())
    .workspaceRevision as string;
  const started = await page.request.post('/api/v1/projects/' + projectId + '/runs', {
    data: { expectedWorkspaceRevision: tree },
    headers: authHeaders(token),
  });
  expect(started.status()).toBe(202);
  return (await started.json()) as { id: string; state: string };
}

/** Polls a run until its state is one of targetStates; returns the final observed state. */
async function awaitRunState(
  page: import('@playwright/test').Page,
  projectId: string,
  runId: string,
  token: string,
  targetStates: string[],
  maxIterations = 150,
): Promise<string> {
  let state = '';
  for (let i = 0; i < maxIterations; i++) {
    const fetched = await page.request.get('/api/v1/projects/' + projectId + '/runs/' + runId, { headers: authHeaders(token) });
    state = (await fetched.json()).state as string;
    if (targetStates.includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return state;
}

test('channel disconnect fails closed then reconnects', async ({ page }) => {
  test.setTimeout(360_000);

  // REST setup without UI login: fresh token, READY project, and a RUNNING run.
  const token = await apiToken(page, ALICE);
  const project = await createProject(page, 'stage6-fault-channel-' + Date.now(), token);
  expect(await awaitReady(page, project.id, token), 'channel test requires a READY project').toBe('READY');
  const run = await startRun(page, project.id, token);
  expect(await awaitRunState(page, project.id, run.id, token, ['RUNNING']), 'terminal requires a RUNNING run').toBe('RUNNING');

  // UI login once, then open the project workbench (client-side navigation keeps the token).
  await login(page, ALICE);
  await page.getByRole('article', { name: project.name }).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp('/projects/' + encodeURIComponent(project.id) + '$'));
  await page.getByRole('tab', { name: 'Terminal' }).click();

  // Track terminal sockets created from here so we can force a mid-session disconnect.
  await page.evaluate(() => {
    const host = window as unknown as { __stage6TerminalSockets?: WebSocket[] };
    host.__stage6TerminalSockets = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
        const resolved = new URL(String(url), window.location.origin);
        if (resolved.pathname === '/api/v1/ws/terminals') {
          host.__stage6TerminalSockets!.push(this);
        }
      }
    } as unknown as typeof WebSocket;
  });

  await page.getByRole('button', { name: 'Open terminal' }).click({ timeout: 30_000 });
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready', { timeout: 30_000 });

  // Fail closed: close the client WebSocket; the server treats the graceful close as a
  // connection loss (CONNECTION_LOST) and must surface a session error, not silently reconnect.
  await page.evaluate(() => {
    const host = window as unknown as { __stage6TerminalSockets?: WebSocket[] };
    const sockets = host.__stage6TerminalSockets ?? [];
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) throw new Error('no terminal socket captured');
    socket.close();
  });

  await expect(page.getByRole('alert', { name: 'Terminal session error' })).toHaveText(
    'Terminal session failed. Open a new session to retry.',
    { timeout: 15_000 },
  );

  // Reconnect: a fresh reservation/ticket re-establishes the channel and receives frames again.
  await page.getByRole('button', { name: 'Open terminal' }).click({ timeout: 30_000 });
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready', { timeout: 30_000 });
});

test('parallel projects keep isolated dynamic bridges', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const projectA = await createProject(page, 'stage6-bridge-a-' + Date.now(), token);
  const projectB = await createProject(page, 'stage6-bridge-b-' + Date.now(), token);
  const [stateA, stateB] = await Promise.all([
    awaitReady(page, projectA.id, token),
    awaitReady(page, projectB.id, token),
  ]);
  expect(stateA, 'project A must reach READY').toBe('READY');
  expect(stateB, 'project B must reach READY').toBe('READY');

  const contentA = 'alpha-bridge-content';
  const contentB = 'beta-bridge-content';

  async function writeBridgeFile(projectId: string, content: string): Promise<{ status: number; content: string }> {
    const tree = (await (await page.request.get('/api/v1/projects/' + projectId + '/files/tree?path=', { headers: authHeaders(token) })).json())
      .workspaceRevision as string;
    const created = await page.request.post('/api/v1/projects/' + projectId + '/entries', {
      data: { kind: 'file', path: 'bridge-notes.md', expectedWorkspaceRevision: tree },
      headers: authHeaders(token),
    });
    expect(created.status()).toBe(201);
    const { workspaceRevision } = (await created.json()) as { workspaceRevision: string };
    const saved = await page.request.put('/api/v1/projects/' + projectId + '/files/content?path=bridge-notes.md', {
      data: { content, expectedWorkspaceRevision: workspaceRevision },
      headers: authHeaders(token),
    });
    return { status: saved.status(), content };
  }

  const [writeA, writeB] = await Promise.all([
    writeBridgeFile(projectA.id, contentA),
    writeBridgeFile(projectB.id, contentB),
  ]);
  expect(writeA.status, 'project A write must succeed').toBe(200);
  expect(writeB.status, 'project B write must succeed').toBe(200);

  const readA = (await (await page.request.get('/api/v1/projects/' + projectA.id + '/files/content?path=bridge-notes.md', { headers: authHeaders(token) })).json()) as { content: string };
  const readB = (await (await page.request.get('/api/v1/projects/' + projectB.id + '/files/content?path=bridge-notes.md', { headers: authHeaders(token) })).json()) as { content: string };
  expect(readA.content, 'project A must read back its own content').toBe(contentA);
  expect(readB.content, 'project B must read back its own content').toBe(contentB);
  expect(readA.content, 'bridge contents must not cross-contaminate').not.toBe(readB.content);
});

test('fault phases: backend restart / tunnel loss / bridge loss', async ({ page }) => {
  test.setTimeout(300_000);
  const FAULT = process.env.STAGE6_FAULT;
  if (FAULT === undefined || FAULT === '') {
    test.skip(true, 'STAGE6_FAULT not set; operator-injected fault phase');
    return;
  }

  await login(page, ALICE);
  const token = await apiToken(page, ALICE);

  if (FAULT === 'backend-restart') {
    const project = await createProject(page, 'stage6-fault-restart-' + Date.now(), token);
    expect(project.state, 'a freshly created project starts CREATING').toBe('CREATING');
    let state = project.state;
    for (let i = 0; i < 60 && state === 'CREATING'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const fetched = await page.request.get('/api/v1/projects/' + project.id, { headers: authHeaders(token) });
      state = (await fetched.json()).state as string;
    }
    expect(['READY', 'FAILED']).toContain(state);
    const detail = await page.request.get('/api/v1/projects/' + project.id, { headers: authHeaders(token) });
    const detailText = (await detail.text()).toLowerCase();
    for (const forbidden of ['kubeconfig', 'token', 'password']) {
      expect(detailText, 'failure reason must be desensitized').not.toContain(forbidden);
    }
    return;
  }

  if (FAULT === 'tunnel-loss') {
    const created = await page.request.post('/api/v1/projects', {
      data: { name: 'stage6-fault-tunnel-' + Date.now() },
      headers: authHeaders(token),
    });
    expect(created.status(), 'tunnel loss must fail creation with a dependency error').toBeGreaterThanOrEqual(400);
    expect(created.status()).toBeLessThan(600);
    const body = await created.text();
    for (const marker of ['Exception', 'Caused by', '	at ', 'at com.manao']) {
      expect(body, 'dependency error must not leak a stack trace').not.toContain(marker);
    }
    return;
  }

  if (FAULT === 'bridge-loss') {
    const project = await createProject(page, 'stage6-fault-bridge-' + Date.now(), token);
    await awaitReady(page, project.id, token);
    const fileRes = await page.request.get('/api/v1/projects/' + project.id + '/files/tree?path=', { headers: authHeaders(token) });
    expect(fileRes.status(), 'bridge loss must fail file access with a dependency error').toBeGreaterThanOrEqual(400);
    expect(fileRes.status()).toBeLessThan(600);
    const body = await fileRes.text();
    for (const marker of ['Exception', 'Caused by', '	at ', 'at com.manao']) {
      expect(body, 'dependency error must not leak a stack trace').not.toContain(marker);
    }
    await page.goto('/');
    await expect(page.getByLabel(/Username|用户名/i), 'UI must remain usable after the fault').toBeVisible();
    return;
  }

  test.skip(true, 'unknown STAGE6_FAULT value: ' + FAULT);
});
