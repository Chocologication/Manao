import { defineConfig, devices } from '@playwright/test';

/**
 * Java project runtime: cloud lifecycle acceptance against the public ingress only.
 *
 * Independent entry for the java-runtime-implementation plan (2026-09-22). It never
 * starts or proxies any local service (no Vite, no backend, no echo server) and only
 * ever drives the real deployed frontend through MANAO_RUNTIME_BASE_URL. The old
 * Stage 6B config keeps its own collection scope; this config collects only the new
 * java-runtime-lifecycle spec so the two acceptance rounds can never be mixed up.
 *
 * Required environment:
 * - MANAO_RUNTIME_BASE_URL        public entry URL of the deployed frontend (required here)
 * - MANAO_RUNTIME_USERNAME        test account username (checked by the spec)
 * - MANAO_RUNTIME_PASSWORD        test account password (checked by the spec)
 * - MANAO_RUNTIME_PUBLIC_PORT_1   first test public NodePort, operator-assigned (checked by the spec)
 * - MANAO_RUNTIME_PUBLIC_PORT_2   second test public NodePort, operator-assigned (checked by the spec)
 *
 * Missing credentials or ports fail the run loudly in the spec's beforeAll - never a
 * silent skip. The two public ports are chosen by the operator up front; nothing here
 * scans for a free port or picks a number on the operator's behalf.
 */

const baseUrl = process.env.MANAO_RUNTIME_BASE_URL;

if (!baseUrl) {
  throw new Error(
    '环境变量 MANAO_RUNTIME_BASE_URL 未设置：Java 运行时云端生命周期 E2E 只允许访问真实公网入口，'
      + '请显式提供部署后的前端 URL（例如 http://203.0.113.7:30080），'
      + '本配置不会回退到任何本机地址或自动启动本地服务。',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  // Hard boundary: only the java-runtime lifecycle spec is collected, nothing else and
  // nothing from the accepted Stage 6B round.
  testMatch: /java-runtime-lifecycle\.spec\.ts/,
  fullyParallel: false,
  // Serial lifecycle: one project flows through create -> READY -> run -> public-port
  // service -> bounded web session. No parallelism, no retry masking.
  workers: 1,
  retries: 0,
  // Explicit: never boot a local webServer; the public ingress must already exist.
  webServer: undefined,
  reporter: 'list',
  // Per-test default for UI-only steps (login, form input, editor save): 5 minutes.
  // Run-heavy tests raise their own timeout via test.setTimeout() while staying under
  // the global cap.
  timeout: 300_000,
  // Whole-run cap: 3.5 hours bounds the full serial scene including the single
  // two-hour bounded web-session case. One complete pass only - no automatic retry.
  globalTimeout: 12_600_000,
  expect: {
    // Single action/expectation budget: 30s, matching UI responsiveness over the
    // public internet; long server-side waits use explicit expect timeouts.
    timeout: 30_000,
  },
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'java-runtime-cloud',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
