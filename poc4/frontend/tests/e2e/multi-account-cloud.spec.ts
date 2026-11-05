import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Real-cloud sequential acceptance for the multi-account delivery (Phase B only).
//
// Hard boundaries (enforced by design, not by the mocks):
// - The two accounts are created and email-verified MANUALLY by the user. This spec never
//   requests a real email code, never reads IMAP, never polls the 126 mailbox and never
//   bypasses or auto-solves the image captcha. Login never needs a captcha, so the normal
//   login path is exercised without touching the email flow at all.
// - No MSW and no local service: every request targets the public entry URL from
//   MANAO_MULTI_ACCOUNT_BASE_URL (see playwright.multi-account-cloud.config.ts).
// - The two accounts are driven sequentially with one worker. A missing environment is
//   reported as an explicit SKIPPED/NOT_RUN, never silently passed and never replaced by a
//   local/mocked backend.
//
// Run (Phase B, with fresh user-prepared accounts and disposable projects):
//   pnpm exec playwright test --config playwright.multi-account-cloud.config.ts

const BASE_URL = (process.env.MANAO_MULTI_ACCOUNT_BASE_URL ?? '').trim().replace(/\/+$/, '');

type Account = { label: string; username: string; password: string };

const ACCOUNT_A: Account = {
  label: 'A',
  username: (process.env.MANAO_MULTI_ACCOUNT_A_USERNAME ?? '').trim(),
  password: process.env.MANAO_MULTI_ACCOUNT_A_PASSWORD ?? '',
};
const ACCOUNT_B: Account = {
  label: 'B',
  username: (process.env.MANAO_MULTI_ACCOUNT_B_USERNAME ?? '').trim(),
  password: process.env.MANAO_MULTI_ACCOUNT_B_PASSWORD ?? '',
};
const PROJECT_A = (process.env.MANAO_MULTI_ACCOUNT_A_PROJECT_ID ?? '').trim();
const PROJECT_B = (process.env.MANAO_MULTI_ACCOUNT_B_PROJECT_ID ?? '').trim();

const NOT_RUN_CONFIG =
  'NOT_RUN: cloud acceptance needs MANAO_MULTI_ACCOUNT_BASE_URL plus the four user-manual '
  + 'MANAO_MULTI_ACCOUNT_{A,B}_{USERNAME,PASSWORD} values created by the user. No local '
  + 'fallback, no mock backend and no automatic service start is allowed.';

function requireCloudAccounts(): void {
  test.skip(BASE_URL === '', NOT_RUN_CONFIG);
  test.skip(
    ACCOUNT_A.username === '' || ACCOUNT_A.password === ''
      || ACCOUNT_B.username === '' || ACCOUNT_B.password === '',
    NOT_RUN_CONFIG,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

/** Sign in through the real login page and return the access token from the real response. */
async function signIn(page: Page, account: Account): Promise<string> {
  await page.goto('/login');
  // Login must never require an image captcha (design section 5.1).
  await expect(page.getByLabel('图形验证码', { exact: true })).toHaveCount(0);
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await loginResponse;
  expect(response.ok(), 'account ' + account.label + ' rejected the user-manual credentials').toBe(true);
  const body = asRecord(await response.json());
  const accessToken = body.accessToken;
  expect(typeof accessToken).toBe('string');
  await expect(page).toHaveURL(/\/projects/);
  return accessToken as string;
}

/** Log out through the workbench UI and verify the anonymous login route. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function apiGet(
  request: APIRequestContext,
  accessToken: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await request.get(BASE_URL + path, {
    headers: { Authorization: 'Bearer ' + accessToken },
    failOnStatusCode: false,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status(), body };
}

/** A readable own project answers 200; another account's project must answer 403/404. */
async function expectProjectAccess(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  readable: boolean,
): Promise<void> {
  const encoded = encodeURIComponent(projectId);
  const summary = await apiGet(request, accessToken, '/api/v1/projects/' + encoded);
  const tree = await apiGet(request, accessToken, '/api/v1/projects/' + encoded + '/files/tree');
  if (readable) {
    expect(summary.status).toBe(200);
    expect(tree.status).toBe(200);
    return;
  }
  expect([403, 404]).toContain(summary.status);
  expect([403, 404]).toContain(tree.status);
}

test('cloud: sequentially logs in both user-manual accounts without a captcha', async ({ page, request }) => {
  requireCloudAccounts();
  for (const account of [ACCOUNT_A, ACCOUNT_B]) {
    const accessToken = await signIn(page, account);

    // /auth/me must expose a bound, verified email: the accounts were registered manually.
    const me = await apiGet(request, accessToken, '/api/v1/auth/me');
    expect(me.status).toBe(200);
    const meBody = asRecord(me.body);
    expect(typeof meBody.email).toBe('string');
    expect(meBody.emailVerified).toBe(true);
    expect(meBody.username).toBe(account.username);

    // The account can read its own project list in the real backend.
    const projects = await apiGet(request, accessToken, '/api/v1/projects');
    expect(projects.status).toBe(200);
    expect(Array.isArray(asRecord(projects.body).items)).toBe(true);

    await signOut(page);
  }
});

test('cloud: A then B project/file reads stay inside each account', async ({ page, request }) => {
  requireCloudAccounts();
  test.skip(
    PROJECT_A === '' || PROJECT_B === '',
    'NOT_RUN: MANAO_MULTI_ACCOUNT_A_PROJECT_ID / B_PROJECT_ID are not set; the user-prepared '
      + 'disposable project ids are required to check cross-account isolation.',
  );

  const tokenA = await signIn(page, ACCOUNT_A);
  await expectProjectAccess(request, tokenA, PROJECT_A, true);
  await expectProjectAccess(request, tokenA, PROJECT_B, false);
  await signOut(page);

  const tokenB = await signIn(page, ACCOUNT_B);
  await expectProjectAccess(request, tokenB, PROJECT_B, true);
  await expectProjectAccess(request, tokenB, PROJECT_A, false);
  await signOut(page);
});

// ---------------------------------------------------------------------------
// Explicit NOT_RUN gates. These are part of the acceptance matrix and must stay
// visible as skipped until the Phase B orchestration (or the user) provides the
// required real environment/state. They are never converted into passes here.
// ---------------------------------------------------------------------------

test('NOT_RUN: real 126 email delivery chains are user-manual only', async () => {
  test.skip(
    true,
    'NOT_RUN (user-manual): normal registration delivery, normal recovery delivery, expired '
      + 'code, resend-invalidates-old-code, duplicate-submit rejection and reset-invalidates-old-'
      + 'password must be verified by the user with real 126 mail. This suite must never request '
      + 'real email codes, read IMAP or poll the mailbox.',
  );
});

test('NOT_RUN: password-change revocation, natural expiry and background continuation', async () => {
  test.skip(
    true,
    'NOT_RUN (Phase B orchestration): requires coordinated accounts, a background Run/AI task, '
      + 'an old JWT/ticket/connection holder and explicit user authorization. Not executed by '
      + 'this local/cloud skeleton.',
  );
});

test('NOT_RUN: 8-project limit and cross-account write/ticket/conversation rejection', async () => {
  test.skip(
    true,
    'NOT_RUN (Phase B orchestration): needs up to nine disposable projects per account plus '
      + 'authorized destructive-path checks (file write, Run, log/terminal ticket, conversation '
      + 'and agent-task ids). Read-only isolation is covered by the previous test.',
  );
});
