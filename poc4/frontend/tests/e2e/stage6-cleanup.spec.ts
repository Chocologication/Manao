import { execFileSync } from 'node:child_process';
import { createClusterClient, type ClusterSnapshot } from '../support/stage6-cleanup/cluster.ts';
import { expect, test, type Stage6Resources } from '../support/stage6-cleanup/fixtures';
import type { HttpCleanupTransport } from '../support/stage6-cleanup/http-transport.ts';

/**
 * Stage 6 cleanup matrix C01-C08. Real execution stays behind STAGE6_GATE=1.
 * Passing this file is not a 6A PASS and does not start 6B.
 */
const ALICE = { username: 'alice', password: 'stage6-alice-pass' };
const GATE_MODE = process.env.STAGE6_GATE === '1';

test.describe.configure({ mode: 'serial' });

async function backendReachable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/api/v1/projects');
    return [200, 401].includes(response.status());
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(page: import('@playwright/test').Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel(/Username|用户名/i).fill(user.username);
  await page.getByLabel(/Password|密码/i).fill(user.password);
  await page.getByRole('button', { name: /Sign in|登录|login/i }).click();
  await expect(page.getByText(/Projects|项目/i).first()).toBeVisible();
}

async function apiToken(page: import('@playwright/test').Page, user: { username: string; password: string }): Promise<string> {
  const res = await page.request.post('/api/v1/auth/login', { data: { username: user.username, password: user.password } });
  expect(res.status(), 'login must issue a token').toBe(200);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function authHeaders(token: string) {
  return { Authorization: 'Bearer ' + token };
}

function requireHttp(resources: Stage6Resources): HttpCleanupTransport {
  if (resources.http === null) {
    throw new Error('HTTP_TRANSPORT_REQUIRED');
  }
  return resources.http;
}

function clusterClient() {
  if (!process.env.KUBECONFIG || !process.env.MANAO_K8S_NAMESPACE) {
    if (!GATE_MODE) {
      test.skip(true, 'cluster kubeconfig not provided');
    }
    throw new Error('C02/C03 require KUBECONFIG and MANAO_K8S_NAMESPACE');
  }
  return createClusterClient();
}

function pvcVersions(snapshot: ClusterSnapshot): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const pvc of snapshot.pvcs) {
    versions[pvc.name] = pvc.resourceVersion;
  }
  return versions;
}

test.beforeEach(async ({ request }) => {
  const reachable = await backendReachable(request);
  if (!reachable) {
    test.skip(!GATE_MODE, '6A backend not reachable; gate-only suite');
    expect(reachable, '6A gate: backend must be reachable').toBe(true);
  }
});

test('C01 owner delete is 204, non-owner is 404, repeat delete and other snapshot stay isolated', async ({ resources }) => {
  const alice = await resources.createProject('alice', 'c01-owner');
  expect(await resources.waitReady('alice', alice.id)).toBe('READY');
  const bob = await resources.createProject('bob', 'c01-other');
  expect(await resources.waitReady('bob', bob.id)).toBe('READY');
  const bobBefore = await resources.listProjects('bob');
  expect(bobBefore.map((item) => item.id)).toContain(bob.id);
  expect(bobBefore.map((item) => item.id)).not.toContain(alice.id);
  expect((await resources.getProject('bob', alice.id)).status).toBe(404);
  expect(await resources.deleteProject('bob', alice.id)).toEqual({ status: 404 });
  const bobAfterDenied = await resources.listProjects('bob');
  expect(bobAfterDenied.map((item) => item.id).sort()).toEqual(bobBefore.map((item) => item.id).sort());
  expect(bobAfterDenied.find((item) => item.id === bob.id)?.state).toBe('READY');
  expect(await resources.deleteProject('alice', alice.id)).toEqual({ status: 204 });
  expect((await resources.getProject('alice', alice.id)).status).toBe(404);
  expect(await resources.deleteProject('alice', alice.id)).toEqual({ status: 404 });
  const bobFinal = await resources.listProjects('bob');
  expect(bobFinal.map((item) => item.id)).toContain(bob.id);
  expect(bobFinal.find((item) => item.id === bob.id)?.state).toBe('READY');
});

test('C02 leftover initializer on a registered project is removed with the project', async ({ resources }) => {
  const project = await resources.createProject('alice', 'c02-initializer');
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
  const cluster = clusterClient();
  const before = cluster.snapshot(project.id);
  expect(before.pvcs.some((pvc) => pvc.name === 'manao-pvc-' + project.id), 'C02 requires the registered PVC').toBe(true);
  cluster.createLeftoverInitializer(project.id);
  let leftover = false;
  for (let i = 0; i < 20 && !leftover; i++) {
    leftover = cluster.leftoverExists(project.id);
    if (!leftover) {
      await sleep(500);
    }
  }
  expect(leftover, 'C02 leftover initializer must exist before DELETE').toBe(true);
  expect(await resources.deleteProject('alice', project.id)).toEqual({ status: 204 });
  expect((await resources.getProject('alice', project.id)).status).toBe(404);
  const after = cluster.snapshot(project.id);
  expect(after.pods).toEqual([]);
  expect(after.pvcs).toEqual([]);
  expect(after.services).toEqual([]);
  expect(cluster.leftoverExists(project.id)).toBe(false);
});

test('C03 DELETE during CREATING is 409 and does not mutate existing Pod/PVC', async ({ resources }) => {
  const project = await resources.createProject('alice', 'c03-creating');
  const first = await resources.getProject('alice', project.id);
  if (first.status !== 200 || first.project.state !== 'CREATING') {
    throw new Error('C03_PRECONDITION_NOT_OBTAINED: state=' + (first.status === 200 ? first.project.state : first.status));
  }
  const cluster = clusterClient();
  const before = cluster.snapshot(project.id);
  const deleted = await resources.deleteProject('alice', project.id);
  expect(deleted.status).toBe(409);
  expect(deleted.code).toBe('PROJECT_CREATING');
  const afterDenied = await resources.getProject('alice', project.id);
  expect(afterDenied.status).toBe(200);
  if (afterDenied.status === 200) {
    expect(afterDenied.project.state).not.toBe('DELETING');
  }
  const after = cluster.snapshot(project.id);
  const beforePvcs = pvcVersions(before);
  const afterPvcs = pvcVersions(after);
  for (const [name, version] of Object.entries(beforePvcs)) {
    expect(afterPvcs[name], 'C03 DELETE must not remove PVC ' + name).toBe(version);
  }
  for (const pod of before.pods) {
    expect(after.pods.some((item) => item.name === pod.name), 'C03 DELETE must not remove pod ' + pod.name).toBe(true);
  }
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
});

test('C04 active Run DELETE is 409 then stop-then-wait cleanup', async ({ page, resources }) => {
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await resources.createProject('alice', 'c04-run');
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
  const revision = (await (await page.request.get(
    '/api/v1/projects/' + project.id + '/files/tree?path=',
    { headers: authHeaders(token) },
  )).json()).workspaceRevision as string;
  const started = await page.request.post('/api/v1/projects/' + project.id + '/runs', {
    data: { expectedWorkspaceRevision: revision },
    headers: authHeaders(token),
  });
  expect(started.status()).toBe(202);
  const run = (await started.json()) as { id: string; state: string };
  await resources.recordRun(project.id, run.id);
  expect(['STARTING', 'RUNNING', 'STOPPING', 'RECOVERING']).toContain(run.state);
  const deleted = await resources.deleteProject('alice', project.id);
  expect(deleted.status, 'C04_PRECONDITION_NOT_OBTAINED').toBe(409);
  expect(deleted.code).toBe('RUN_ALREADY_ACTIVE');
  const still = await resources.getProject('alice', project.id);
  expect(still.status).toBe(200);
  if (still.status === 200) {
    expect(still.project.state).toBe('READY');
  }
});

test('C05 lost create response reconciles without a second POST', async ({ resources }) => {
  const http = requireHttp(resources);
  http.dropCreateResponse = true;
  const before = http.createCalls;
  const project = await resources.createProject('alice', 'c05-lost-create');
  http.dropCreateResponse = false;
  expect(http.createCalls).toBe(before + 1);
  expect(project.id).toBeTruthy();
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
});

test('C06 lost DELETE response is confirmed by GET 404', async ({ resources }) => {
  const http = requireHttp(resources);
  const project = await resources.createProject('alice', 'c06-lost-delete');
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
  http.dropDeleteResponse = true;
  await expect(resources.deleteProject('alice', project.id)).rejects.toThrow('TRANSPORT_UNCERTAIN');
  http.dropDeleteResponse = false;
  expect((await resources.getProject('alice', project.id)).status).toBe(404);
});

test('C07 injected failure on the first project does not block the second', async ({ resources }) => {
  const http = requireHttp(resources);
  const first = await resources.createProject('alice', 'c07-first');
  expect(await resources.waitReady('alice', first.id)).toBe('READY');
  const second = await resources.createProject('alice', 'c07-second');
  expect(await resources.waitReady('alice', second.id)).toBe('READY');
  http.failDeleteIds.add(first.id);
  const report = await resources.sweep();
  http.failDeleteIds.delete(first.id);
  expect(report.entries.find((entry) => entry.projectId === first.id)?.state).toBe('UNRESOLVED');
  expect(report.entries.find((entry) => entry.projectId === second.id)?.state).toBe('API_CLEANED');
  expect((await resources.getProject('alice', second.id)).status).toBe(404);
  expect((await resources.getProject('alice', first.id)).status).toBe(200);
});

test('C08 backend restart resumes cleanup of a DELETING project', async ({ request, resources }) => {
  const script = process.env.STAGE6_BACKEND_RESTART_CMD;
  const envFile = process.env.STAGE6_BACKEND_RESTART_ENVFILE;
  if (!script) {
    test.skip(!GATE_MODE, 'C08 restart command not provided');
    throw new Error('C08 requires STAGE6_BACKEND_RESTART_CMD');
  }
  if (!envFile) {
    throw new Error('C08 requires STAGE6_BACKEND_RESTART_ENVFILE');
  }
  const project = await resources.createProject('alice', 'c08-restart');
  expect(await resources.waitReady('alice', project.id)).toBe('READY');
  const cluster = clusterClient();
  cluster.createLeftoverInitializer(project.id);
  const deletePromise = resources.deleteProject('alice', project.id);
  await sleep(2000);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File',
    script,
    '-EnvFile',
    envFile,
    '-Restart',
  ], {
    encoding: 'utf8',
    timeout: 240_000,
    stdio: 'ignore',
  });
  requireHttp(resources).clearSessions();
  let healthy = false;
  for (let i = 0; i < 90 && !healthy; i++) {
    healthy = await backendReachable(request);
    if (!healthy) {
      await sleep(2000);
    }
  }
  expect(healthy, 'backend must be reachable after C08 restart').toBe(true);
  try {
    await deletePromise;
  } catch {
    // The in-flight DELETE is expected to fail when the process is replaced.
  }
  const after = await resources.getProject('alice', project.id);
  if (after.status === 200) {
    expect(after.project.state, 'C08_PRECONDITION_NOT_OBTAINED').toBe('DELETING');
  } else {
    expect(after.status).toBe(404);
  }
});
