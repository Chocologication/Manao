import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { LoginResponse } from '../../src/contracts/auth';
import type { CreateProjectRequest, ProjectSummary } from '../../src/contracts/project';
import type { OwnerShare, PublicShare, PublishRequest, RunSharePreview } from '../../src/contracts/runShare';
import { createClusterClient } from '../support/stage6-cleanup/cluster';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const DELAY = 2_000;
type Run = { id: string; state: string; exitCode: number | null; terminationReason?: string | null };
type Ledger = {
  invocation: string; preparedAt: string; creation: CreateProjectRequest; ownerId?: string;
  projectId?: string; runIds: string[]; shareId?: string; expiresAt?: string;
  shareRequestId?: string; publishRequest?: PublishRequest; logSha256?: string; logUtf8Bytes?: number;
  stage: string; result: 'RUNNING' | 'PASS' | 'FAILED';
  observedRun?: Run;
  diagnostic?: { runHttp: number; previewHttp?: number; logSha256?: string; logUtf8Bytes?: number; file?: string };
  failure?: { stage: string; type: string; matcher?: string; location?: string; code?: string; actual?: unknown; expected?: unknown };
  cleanup: string[]; checks: string[];
};

// Public tokens, login credentials, raw responses and full share URLs stay in memory.
test('real run share survives source deletion and owner revocation ends anonymous access', async ({ page, browser }, info) => {
  const invocation = randomUUID();
  const ledger: Ledger = {
    invocation, preparedAt: new Date().toISOString(), stage: 'login', result: 'RUNNING',
    creation: { name: `share-e2e-${invocation.slice(0, 8)}`, creationKey: randomUUID(),
      templateId: 'java-console', mysql: false, redis: false, publicPorts: [] },
    runIds: [], cleanup: [], checks: [],
  };
  const save = () => writeFile(info.outputPath(`ledger-${invocation}.json`), JSON.stringify(ledger, null, 2), 'utf8');
  let token = '';
  let anonymous: BrowserContext | undefined;
  let failureStage: string | undefined;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const projectPath = () => `/api/v1/projects/${encodeURIComponent(ledger.projectId!)}`;
  const get = (path: string) => page.request.get(path, { headers: auth(), timeout: 30_000 });
  const stage = async (name: string) => { ledger.stage = name; await save(); };

  async function signIn(): Promise<void> {
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill(process.env.MANAO_RUN_SHARE_USERNAME!);
    await page.getByLabel('Password', { exact: true }).fill(process.env.MANAO_RUN_SHARE_PASSWORD!);
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const response = await pending; expect(response.status()).toBe(200);
    const session = await response.json() as LoginResponse;
    expect(typeof session.accessToken === 'string' && typeof session.user?.id === 'string', 'login identity').toBe(true);
    if (ledger.ownerId) expect(session.user.id === ledger.ownerId, 'same dedicated owner after re-login').toBe(true);
    token = session.accessToken; ledger.ownerId = session.user.id;
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  }

  async function reconcileCreation(): Promise<ProjectSummary> {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const response = await get(`/api/v1/projects/creation/${ledger.creation.creationKey}`);
      if (response.status() === 200) {
        const project = await response.json() as ProjectSummary;
        expect(project.name === ledger.creation.name && project.runtime?.templateId === 'java-console', 'creation receipt identity').toBe(true);
        return project;
      }
      expect(response.status(), 'creation lookup must be readable or not yet visible').toBe(404);
      await page.waitForTimeout(DELAY);
    }
    throw new Error('CREATION_UNRESOLVED');
  }

  async function deleteOwnProject(): Promise<void> {
    const identity = await get('/api/v1/auth/me');
    expect(identity.status()).toBe(200);
    expect((await identity.json() as { id: string }).id === ledger.ownerId, 'cleanup owner').toBe(true);
    let current = await get(projectPath());
    if (current.status() === 404) return;
    expect(current.status()).toBe(200);
    const project = await current.json() as ProjectSummary;
    expect(project.id === ledger.projectId && project.name === ledger.creation.name, 'cleanup exact project identity').toBe(true);
    const activeResponse = await get(`${projectPath()}/runs/active`);
    expect(activeResponse.status()).toBe(200);
    const active = (await activeResponse.json() as { run: Run | null }).run;
    if (active) {
      expect(ledger.runIds.includes(active.id), 'refuse to stop an unrecorded active run').toBe(true);
      await page.request.post(`${projectPath()}/runs/${active.id}/stop`, { headers: auth(), timeout: 30_000 });
      await expect.poll(async () => {
        const response = await get(`${projectPath()}/runs/${active.id}`);
        expect(response.status()).toBe(200);
        return TERMINAL.includes((await response.json() as Run).state);
      }, { timeout: 120_000, intervals: [DELAY] }).toBe(true);
    }
    // At most one initial delete plus two explicit continuations after observing DELETING.
    for (let attempt = 0; attempt < 3; attempt++) {
      let status = 0;
      try {
        const response = await page.request.delete(projectPath(), { headers: auth(), timeout: 30_000 });
        status = response.status();
        ledger.cleanup.push(`PROJECT_DELETE_HTTP_${status}`); await save();
        if (status >= 400) {
          const body = await response.json().catch(() => ({})) as { code?: string };
          throw new Error(`PROJECT_DELETE_${/^[A-Z_]+$/.test(body.code ?? '') ? body.code : 'REJECTED'}`);
        }
      }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('PROJECT_DELETE_')) throw error;
        // A lost delete response is reconciled with GET before any continuation.
      }
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        current = await get(projectPath());
        if (current.status() === 404) return;
        expect(current.status()).toBe(200);
        const observed = await current.json() as ProjectSummary;
        expect(observed.state, `delete response ${status}; observed project state`).toBe('DELETING');
        await page.waitForTimeout(DELAY);
      }
    }
    throw new Error('PROJECT_DELETE_UNRESOLVED');
  }

  async function observePublic(recipient: Page, shareUrl: string, expected: PublicShare | undefined, log: string): Promise<PublicShare> {
    const pending = recipient.waitForResponse(r => new URL(r.url()).pathname.startsWith('/api/v1/public/run-shares/') && r.request().method() === 'GET');
    if (expected) await recipient.reload(); else await recipient.goto(shareUrl);
    const response = await pending;
    expect(response.status()).toBe(200);
    expect(response.request().headers().authorization === undefined, 'anonymous public GET has no bearer').toBe(true);
    expect(response.headers()['cache-control']).toContain('no-store');
    const body = await response.json() as PublicShare;
    if (expected) expect(JSON.stringify(body) === JSON.stringify(expected), 'public snapshot unchanged after source deletion').toBe(true);
    await expect(recipient.getByRole('heading', { name: body.title, exact: true })).toBeVisible();
    expect(await recipient.getByTestId('run-share-log').textContent() === log, 'exact log text including original newlines').toBe(true);
    return body;
  }

  try {
    await save();
    await signIn();
    await stage('project-create');
    // Only one POST. Any uncertain outcome is recovered through the durable creation key.
    let project: ProjectSummary | undefined;
    try {
      const response = await page.request.post('/api/v1/projects', { headers: auth(), data: ledger.creation, timeout: 30_000 });
      if (response.ok()) project = await response.json() as ProjectSummary;
      else if (response.status() < 500) throw new Error('PROJECT_CREATE_REJECTED');
    } catch (error) {
      if (error instanceof Error && error.message === 'PROJECT_CREATE_REJECTED') throw error;
    }
    project ??= await reconcileCreation();
    expect(project.name === ledger.creation.name && typeof project.id === 'string' && project.runtime?.templateId === 'java-console', 'created project identity').toBe(true);
    ledger.projectId = project.id; await save();
    await stage('project-ready');
    const readyDeadline = Date.now() + 600_000;
    while (true) {
      const response = await get(projectPath()); expect(response.status()).toBe(200);
      const current = await response.json() as ProjectSummary;
      expect(['FAILED', 'DELETING'].includes(current.state), 'project provisioning must not fail').toBe(false);
      if (current.state === 'READY') break;
      if (Date.now() >= readyDeadline) throw new Error('PROJECT_READY_TIMEOUT');
      await page.waitForTimeout(DELAY);
    }
    await stage('workbench-open');
    // Auth is intentionally memory-only. Re-login refreshes the list; SPA links preserve it.
    await signIn();
    const card = page.getByRole('article', { name: ledger.creation.name, exact: true });
    await card.getByRole('link', { name: '进入工作台', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${ledger.projectId}$`));
    await expect(page.getByRole('heading', { name: ledger.creation.name, exact: true })).toBeVisible();
    await stage('run-start-and-terminal');
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    const start = page.waitForResponse(r => new URL(r.url()).pathname === `${projectPath()}/runs` && r.request().method() === 'POST');
    await page.getByRole('button', { name: '启动运行', exact: true }).click();
    const started = await start; expect(started.ok()).toBe(true);
    const run = await started.json() as Run;
    expect(typeof run.id === 'string', 'new run identity').toBe(true);
    ledger.runIds.push(run.id); await save();
    const runDeadline = Date.now() + 780_000;
    while (true) {
      const response = await get(`${projectPath()}/runs/${run.id}`); expect(response.status()).toBe(200);
      const current = await response.json() as Run;
      ledger.observedRun = { id: current.id, state: current.state, exitCode: current.exitCode, terminationReason: current.terminationReason };
      await save();
      if (TERMINAL.includes(current.state)) {
        expect(current.state, 'real run terminal state').toBe('SUCCEEDED');
        expect(current.exitCode, 'real run exit code').toBe(0);
        break;
      }
      if (Date.now() >= runDeadline) throw new Error('RUN_TERMINAL_TIMEOUT');
      await page.waitForTimeout(DELAY);
    }
    await expect(page.getByRole('status', { name: '运行状态' })).toContainText(/SUCCEEDED|运行成功/);
    await page.locator(`button[data-run-id="${run.id}"]`).click();
    await stage('share-preview-and-ui-publish');
    const previewPending = page.waitForResponse(r => new URL(r.url()).pathname === `${projectPath()}/runs/${run.id}/share-preview`);
    await page.getByRole('button', { name: '分享运行结果', exact: true }).click();
    const previewResponse = await previewPending; expect(previewResponse.status()).toBe(200);
    const preview = await previewResponse.json() as RunSharePreview;
    if (preview.kind !== 'PREVIEW') throw new Error('UNEXPECTED_EXISTING_SHARE');
    const expectedLog = preview.snapshot.logText;
    expect(expectedLog.includes('Hello from Manao'), 'real default application output').toBe(true);
    ledger.logSha256 = createHash('sha256').update(expectedLog).digest('hex');
    ledger.logUtf8Bytes = Buffer.byteLength(expectedLog, 'utf8');
    const title = `运行分享验收 ${invocation.slice(0, 8)}`;
    const dialog = page.getByRole('dialog', { name: '分享运行结果', exact: true });
    await dialog.getByLabel('分享标题', { exact: true }).fill(title);
    await dialog.getByLabel('分享说明', { exact: true }).fill('真实运行的独立只读快照');
    const publishPending = page.waitForResponse(r => new URL(r.url()).pathname === `${projectPath()}/runs/${run.id}/shares` && r.request().method() === 'POST');
    const publishRequest = page.waitForRequest(r => new URL(r.url()).pathname === `${projectPath()}/runs/${run.id}/shares` && r.method() === 'POST');
    await dialog.getByRole('button', { name: '生成分享链接', exact: true }).click();
    const request = (await publishRequest).postDataJSON() as PublishRequest;
    expect(Object.keys(request).sort()).toEqual(['description', 'requestId', 'snapshotDigest', 'title']);
    ledger.shareRequestId = request.requestId; ledger.publishRequest = request; await save();
    const publish = await publishPending;
    expect(publish.status()).toBe(201);
    const share = await publish.json() as OwnerShare;
    ledger.shareId = share.id; ledger.expiresAt = share.expiresAt; await save();
    expect(share.title === title && share.status === 'ACTIVE', 'new share identity').toBe(true);
    expect(Date.parse(share.expiresAt) - Date.parse(share.createdAt)).toBe(72 * 60 * 60 * 1_000);
    expect(/^\/shares\/[A-Za-z0-9_-]{43}$/.test(share.sharePath ?? ''), 'same-origin public share path').toBe(true);
    const shareUrl = new URL(share.sharePath!, info.project.use.baseURL).href;
    expect(await dialog.getByLabel('分享链接', { exact: true }).inputValue() === shareUrl, 'displayed URL matches published path and site origin').toBe(true);
    await dialog.getByRole('button', { name: '关闭分享弹窗', exact: true }).click();
    await stage('anonymous-direct-open');
    anonymous = await browser.newContext();
    const recipient = await anonymous.newPage();
    const initial = await observePublic(recipient, shareUrl, undefined, expectedLog);
    expect(initial.title === title && initial.snapshot.logText === expectedLog, 'snapshot corresponds to this run and share').toBe(true);
    ledger.checks.push('ANONYMOUS_DIRECT_OPEN_EXACT_LOG_PASS');
    await stage('delete-source-and-anonymous-refresh');
    await deleteOwnProject(); ledger.cleanup.push('PROJECT_API_404'); await save();
    await observePublic(recipient, shareUrl, initial, expectedLog);
    ledger.checks.push('SOURCE_404_ANONYMOUS_REFRESH_EXACT_SNAPSHOT_PASS');
    await stage('my-shares-ui-revoke');
    await signIn();
    await page.getByRole('button', { name: '账户与偏好', exact: true }).click();
    await page.getByRole('link', { name: '我的分享', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/shares$/);
    const row = page.locator(`li[data-share-id="${share.id}"]`);
    await expect(row.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const revokePending = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/run-shares/${share.id}` && r.request().method() === 'DELETE');
    await row.getByRole('button', { name: '撤销分享', exact: true }).click();
    expect((await revokePending).status()).toBe(204);
    await expect(row.getByRole('status')).toHaveText('已撤销');
    const revokedPending = recipient.waitForResponse(r => new URL(r.url()).pathname.startsWith('/api/v1/public/run-shares/'));
    await recipient.reload(); const revoked = await revokedPending;
    expect(revoked.status()).toBe(410);
    expect((await revoked.json() as { code: string }).code).toBe('RUN_SHARE_REVOKED');
    await expect(recipient.getByText('分享已撤销', { exact: true })).toBeVisible();
    await expect(recipient.getByTestId('run-share-log')).toHaveCount(0);
    ledger.checks.push('MY_SHARES_UI_REVOKE_ANONYMOUS_410_PASS');
    ledger.result = 'PASS';
  } catch (error) {
    failureStage = ledger.stage; ledger.result = 'FAILED';
    const failure = error as { name?: string; stack?: string; message?: string; matcherResult?: { name?: string; actual?: unknown; expected?: unknown } };
    const safeScalar = (value: unknown) => typeof value === 'boolean' || typeof value === 'number'
      || value === null || typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : undefined;
    ledger.failure = {
      stage: ledger.stage,
      type: /^[A-Za-z]+$/.test(failure.name ?? '') ? failure.name! : 'Error',
      matcher: failure.matcherResult?.name,
      location: failure.stack?.match(/run-sharing\.spec\.ts:\d+:\d+/)?.[0],
      code: /^[A-Z_]+$/.test(failure.message ?? '') ? failure.message : undefined,
      actual: safeScalar(failure.matcherResult?.actual), expected: safeScalar(failure.matcherResult?.expected),
    };
    await save();
    // Capture this known default-template Run before finally deletes source rows and Job logs.
    if (token && ledger.projectId && ledger.runIds.length === 1) {
      try {
        const response = await get(`${projectPath()}/runs/${ledger.runIds[0]}`);
        ledger.diagnostic = { runHttp: response.status() };
        if (response.status() === 200) {
          const current = await response.json() as Run;
          ledger.observedRun = { id: current.id, state: current.state, exitCode: current.exitCode, terminationReason: current.terminationReason };
          if (TERMINAL.includes(current.state)) {
            const previewResponse = await get(`${projectPath()}/runs/${current.id}/share-preview`);
            ledger.diagnostic.previewHttp = previewResponse.status();
            if (previewResponse.status() === 200) {
              const preview = await previewResponse.json() as RunSharePreview;
              if (preview.kind === 'PREVIEW') {
                const text = preview.snapshot.logText;
                ledger.diagnostic.logSha256 = createHash('sha256').update(text).digest('hex');
                ledger.diagnostic.logUtf8Bytes = Buffer.byteLength(text, 'utf8');
                ledger.diagnostic.file = `diagnostic-run-${current.id}.log`;
                await writeFile(info.outputPath(ledger.diagnostic.file), text, 'utf8');
              }
            }
          }
        }
      } catch { ledger.cleanup.push('PRIMARY_RUN_DIAGNOSTIC_UNAVAILABLE'); }
      await save();
    }
  } finally {
    ledger.cleanup.push('FINALLY_ENTERED'); await save();
    if (token && ledger.ownerId) {
      try {
        if (ledger.publishRequest && !ledger.shareId && ledger.projectId && ledger.runIds.length === 1) {
          // Recover an uncertain publish through this exact Run's read-only preview, never a new POST.
          const response = await get(`${projectPath()}/runs/${ledger.runIds[0]}/share-preview`);
          if (response.status() === 200) {
            const preview = await response.json() as RunSharePreview;
            if (preview.kind === 'EXISTING' && preview.share.title === ledger.publishRequest.title
              && preview.share.sourceProjectName === ledger.creation.name) {
              ledger.shareId = preview.share.id; ledger.expiresAt = preview.share.expiresAt;
              ledger.cleanup.push('UNCERTAIN_SHARE_READONLY_RECOVERED'); await save();
            } else ledger.cleanup.push('SHARE_RECEIPT_UNRESOLVED');
          } else ledger.cleanup.push('SHARE_RECEIPT_UNRESOLVED');
        }
        if (!ledger.projectId) {
          // Lookup only; never create a second project during cleanup.
          const found = await get(`/api/v1/projects/creation/${ledger.creation.creationKey}`);
          if (found.status() === 200) {
            const project = await found.json() as ProjectSummary;
            if (project.name !== ledger.creation.name) throw new Error('IDENTITY_MISMATCH');
            ledger.projectId = project.id; await save();
          } else if (found.status() !== 404) throw new Error('LOOKUP_UNREADABLE');
        }
        if (ledger.projectId) { await deleteOwnProject(); if (!ledger.cleanup.includes('PROJECT_API_404')) ledger.cleanup.push('PROJECT_API_404'); }
      } catch { ledger.cleanup.push('PROJECT_CLEANUP_UNRESOLVED'); }
      if (ledger.shareId) {
        try {
          const response = await page.request.delete(`/api/v1/run-shares/${ledger.shareId}`, { headers: auth(), timeout: 30_000 });
          if (response.status() !== 204) throw new Error('REVOKE_UNCONFIRMED');
          ledger.cleanup.push('OWN_SHARE_REVOKED');
        } catch { ledger.cleanup.push('SHARE_CLEANUP_UNRESOLVED'); }
      }
    }
    if (ledger.projectId && process.env.KUBECONFIG && process.env.MANAO_K8S_NAMESPACE) {
      try {
        const snapshot = createClusterClient().snapshot(ledger.projectId);
        if (snapshot.jobs === null || snapshot.pods.length || snapshot.pvcs.length || snapshot.services.length || snapshot.jobs.length) {
          ledger.cleanup.push('K8S_RESIDUAL_OR_UNREADABLE');
        } else ledger.cleanup.push('K8S_EXACT_PROJECT_ZERO_RESIDUAL_PASS');
      } catch { ledger.cleanup.push('K8S_VERIFICATION_FAILED'); }
    } else ledger.cleanup.push('K8S_VERIFICATION_NOT_RUN');
    await anonymous?.close();
    // Failure artifacts must not capture credentials or bearer URLs from the active page.
    await page.goto('about:blank').catch(() => undefined);
    if (ledger.cleanup.some(item => /UNRESOLVED|FAILED|RESIDUAL_OR/.test(item))) ledger.result = 'FAILED';
    await save();
  }
  expect(ledger.result, `stage=${failureStage ?? ledger.stage}; run=${JSON.stringify(ledger.observedRun)}; failure=${JSON.stringify(ledger.failure)}; see sanitized invocation ledger`).toBe('PASS');
});
