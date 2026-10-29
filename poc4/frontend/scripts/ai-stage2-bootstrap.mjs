import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = process.env;
const base = new URL(env.MANAO_AI_ACCEPTANCE_BASE_URL ?? 'about:blank');
const port = Number(env.MANAO_AI_ACCEPTANCE_PUBLIC_PORT);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/'
    || base.search || base.hash || !env.MANAO_AI_ACCEPTANCE_USERNAME || !env.MANAO_AI_ACCEPTANCE_PASSWORD
    || !/^\d+$/.test(env.MANAO_AI_ACCEPTANCE_PUBLIC_PORT ?? '') || !Number.isInteger(port) || port < 30000 || port > 31000) {
  throw new Error('Stage 2 bootstrap requires explicit BASE_URL, USERNAME, PASSWORD and PUBLIC_PORT (30000–31000)');
}
const demoPath = 'src/main/java/com/example/app/DemoController.java';
const fixturePath = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';
const controller = readFileSync(new URL('../tests/fixtures/ai-stage2/DemoController.java', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../tests/fixtures/ai-stage2/DemoControllerAcceptanceTest.java', import.meta.url), 'utf8');
const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
const summary = { projectName: `ai-stage2-${randomUUID().slice(0, 8)}`, creationKey: randomUUID(),
  projectId: null, initialRevision: null, r0Id: null, publicPort: port, endpoint: null,
  testFixtureSha256: fixtureSha256, fixturePath, createdAt: new Date().toISOString(), cleanup: 'RETAINED' };
let token;
class BootstrapFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new BootstrapFailure('API_OUTCOME_UNKNOWN'); }
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new BootstrapFailure(/^[A-Z][A-Z0-9_]+$/.test(parsed?.code ?? '') ? parsed.code : 'API_FAILED');
  return parsed;
}
const projectPath = () => `/api/v1/projects/${summary.projectId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, ready, failed, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (failed(value) || Date.now() >= deadline) throw new BootstrapFailure('BOOTSTRAP_STATE_NOT_READY');
    await sleep(2000);
  }
}
async function revision() {
  const tree = await api(`${projectPath()}/files/tree`);
  if (!/^(0|[1-9][0-9]*)$/.test(tree.workspaceRevision)) throw new BootstrapFailure('REVISION_UNKNOWN');
  return tree.workspaceRevision;
}
async function main() {
  const login = await api('/api/v1/auth/login', { method: 'POST', body: {
    username: env.MANAO_AI_ACCEPTANCE_USERNAME, password: env.MANAO_AI_ACCEPTANCE_PASSWORD } });
  if (typeof login?.accessToken !== 'string' || !login.accessToken) throw new BootstrapFailure('LOGIN_FAILED');
  token = login.accessToken;
  // Log the stable identity before creation, so unknown outcomes can be reconciled.
  console.log(JSON.stringify({ creationKey: summary.creationKey, projectName: summary.projectName, publicPort: port }));
  let created;
  try {
    created = await api('/api/v1/projects', { method: 'POST', body: {
      name: summary.projectName, creationKey: summary.creationKey, templateId: 'java-spring-boot-web',
      mysql: false, redis: false, publicPorts: [{ name: 'http', targetPort: 8080, publicPort: port }] } });
  } catch (error) {
    if (error.code !== 'API_OUTCOME_UNKNOWN') throw error;
    // Read only: never repeat a possibly applied create with a new identity.
    created = await api(`/api/v1/projects/creation/${summary.creationKey}`);
  }
  if (!/^[0-9a-f-]{36}$/.test(created?.id ?? '')) throw new BootstrapFailure('CREATION_ID_UNKNOWN');
  summary.projectId = created.id;
  await poll(() => api(projectPath()), (view) => view.state === 'READY',
    (view) => ['FAILED', 'DELETING'].includes(view.state), 900_000);
  await api(`${projectPath()}/files/content?path=${encodeURIComponent(demoPath)}`, { method: 'PUT',
    body: { content: controller, expectedWorkspaceRevision: await revision() } });
  const levels = fixturePath.split('/').slice(0, -1);
  for (let depth = 1; depth <= levels.length; depth++) {
    try {
      await api(`${projectPath()}/entries`, { method: 'POST', body: {
        kind: 'directory', path: levels.slice(0, depth).join('/'), expectedWorkspaceRevision: await revision() } });
    } catch (error) { if (error.code !== 'ENTRY_ALREADY_EXISTS') throw error; }
  }
  await api(`${projectPath()}/entries`, { method: 'POST', body: {
    kind: 'file', path: fixturePath, expectedWorkspaceRevision: await revision() } });
  await api(`${projectPath()}/files/content?path=${encodeURIComponent(fixturePath)}`, { method: 'PUT',
    body: { content: fixture, expectedWorkspaceRevision: await revision() } });
  for (const [path, content] of [[demoPath, controller], [fixturePath, fixture]]) {
    const saved = await api(`${projectPath()}/files/content?path=${encodeURIComponent(path)}`);
    if (saved.content !== content) throw new BootstrapFailure('FIXTURE_ROUND_TRIP_FAILED');
  }
  summary.initialRevision = await revision();
  let r0;
  try {
    r0 = await api(`${projectPath()}/runs`, { method: 'POST', body: { expectedWorkspaceRevision: summary.initialRevision } });
  } catch (error) {
    if (error.code !== 'API_OUTCOME_UNKNOWN') throw error;
    r0 = (await api(`${projectPath()}/runs/active`)).run;
    if (r0?.requestedWorkspaceRevision !== summary.initialRevision) throw new BootstrapFailure('RUN_OUTCOME_UNKNOWN');
  }
  if (!r0?.id) throw new BootstrapFailure('RUN_OUTCOME_UNKNOWN');
  summary.r0Id = r0.id;
  const ready = await poll(() => api(`${projectPath()}/runs/${summary.r0Id}`),
    (run) => run.state === 'RUNNING' && run.firstReadyAt !== null,
    (run) => ['FAILED', 'CANCELLED', 'TIMED_OUT', 'SUCCEEDED'].includes(run.state), 900_000);
  const current = await api(`${projectPath()}/runs/active`);
  if (current.run?.id !== ready.id || ready.requestedWorkspaceRevision !== summary.initialRevision
    || await revision() !== summary.initialRevision) throw new BootstrapFailure('R0_IDENTITY_CHANGED');
  const project = await api(projectPath());
  const primary = project.runtime?.publicPorts?.[0];
  const endpoint = project.endpoints?.find((entry) => entry.name === primary?.name);
  if (primary?.publicPort !== port || endpoint?.publicPort !== port || !endpoint?.url) throw new BootstrapFailure('PUBLIC_ENDPOINT_UNKNOWN');
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || url.username || url.password || Number(url.port) !== port) throw new BootstrapFailure('PUBLIC_ENDPOINT_INVALID');
  summary.endpoint = url.href;
  summary.readyAt = ready.firstReadyAt;
  summary.status = 'R0_READY';
  console.log(JSON.stringify(summary, null, 2));
  console.log('Set MANAO_AI_PROJECT_ID to this project only in an authorized release. Export projectId, initialRevision and r0Id for the browser/operator steps. No configuration was changed; project and R0 are RETAINED.');
}
main().catch((error) => {
  console.log(JSON.stringify({ ...summary, status: 'FAILED', failure: error instanceof BootstrapFailure ? error.code : 'BOOTSTRAP_FAILED' }, null, 2));
  process.exitCode = 1;
});
