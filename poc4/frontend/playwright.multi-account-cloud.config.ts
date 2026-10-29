import { defineConfig, devices } from '@playwright/test';

// Real-cloud acceptance config for the multi-account delivery (Phase B only).
//
// Hard boundaries:
// - No MSW: this suite talks to the real deployed frontend/backend.
// - No webServer: this config never starts, builds or proxies any local service; the
//   public entry URL must already exist and is taken only from the environment.
// - workers=1 / fullyParallel=false: the two user-manual accounts are driven sequentially.
// - The spec never requests real email codes, never reads IMAP, never probes the 126
//   mailbox and never bypasses the image captcha. The email-verified accounts are created
//   and prepared MANUALLY by the user before the run.
//
// Environment (all values are provided only for the Phase B run, never committed):
//   MANAO_MULTI_ACCOUNT_BASE_URL      public frontend entry URL (required to run)
//   MANAO_MULTI_ACCOUNT_A_USERNAME / MANAO_MULTI_ACCOUNT_A_PASSWORD
//   MANAO_MULTI_ACCOUNT_B_USERNAME / MANAO_MULTI_ACCOUNT_B_PASSWORD
//   MANAO_MULTI_ACCOUNT_A_PROJECT_ID / MANAO_MULTI_ACCOUNT_B_PROJECT_ID  (optional
//                                     isolation anchors; the isolation test skips without them)
//
// Without MANAO_MULTI_ACCOUNT_BASE_URL every test skips with an explicit NOT_RUN reason
// (the placeholder baseURL below is never contacted); a missing value must never fall back
// to a local address and must never auto-start a server.
const baseUrl = process.env.MANAO_MULTI_ACCOUNT_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /multi-account-cloud\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    // Reserved documentation address; only reachable when the env is missing, in which
    // case every test skips before any navigation.
    baseURL: (baseUrl === undefined || baseUrl.trim() === '') ? 'http://127.0.0.1:1' : baseUrl.trim(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    ...devices['Desktop Chrome'],
  },
  webServer: undefined,
  projects: [{ name: 'multi-account-cloud', use: { ...devices['Desktop Chrome'] } }],
});
