import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 6B: cloud lifecycle acceptance against the public ingress only.
 *
 * This config never starts or proxies any local service (no Vite, no backend,
 * no echo server). The suite drives the real deployed frontend from the public
 * entry URL, so local dependency shutdown is a precondition of the run, not a
 * mock setup. Real execution happens in Phase B once the cluster deployment and
 * public ingress are ready.
 *
 * Required environment:
 * - MANAO_6B_BASE_URL    public entry URL of the deployed frontend (required)
 * - MANAO_6B_USERNAME    test account username (checked by the spec, not here)
 * - MANAO_6B_PASSWORD    test account password (checked by the spec, not here)
 */

const baseUrl = process.env.MANAO_6B_BASE_URL;

if (!baseUrl) {
  throw new Error(
    '环境变量 MANAO_6B_BASE_URL 未设置：Stage 6B 云端生命周期 E2E 只允许访问真实公网入口，'
      + '请显式提供部署后的前端 URL（例如 https://stage6b.example.example），'
      + '本配置不会回退到任何本机地址或自动启动本地服务。',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  // Hard boundary: only the 6B lifecycle spec is collected, nothing else and nothing new.
  testMatch: /stage6b-cloud-lifecycle\.spec\.ts/,
  fullyParallel: false,
  // Serial lifecycle: one project flows through create -> edit -> failed run ->
  // fixed run -> persistence checks. No parallelism, no retry masking.
  workers: 1,
  retries: 0,
  // Explicit: never boot a local webServer; the public ingress must already exist.
  webServer: undefined,
  reporter: 'list',
  // Per-test default for UI-only steps (login, tree navigation, editor save).
  timeout: 300_000,
  // Whole-run cap (see task-4 report for the budget rationale): cloud Maven runs
  // may sit several minutes each from cold start; 30 minutes bounds the scene
  // without silently absorbing hangs. Run-heavy tests raise their own timeout
  // via test.setTimeout() while staying under this cap.
  globalTimeout: 1_800_000,
  expect: {
    // Single action/expectation budget: 30s, matching UI responsiveness over
    // the public internet; long server-side waits use explicit expect timeouts.
    timeout: 30_000,
  },
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'stage6b-cloud',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
