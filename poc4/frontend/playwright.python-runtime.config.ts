import { defineConfig, devices } from '@playwright/test';

/**
 * Python project runtime: cloud lifecycle acceptance against the public ingress only.
 *
 * Independent entry for the python-runtime-implementation plan (2026-09-25). It never
 * starts or proxies any local service (no Vite, no backend, no echo server) and only
 * ever drives the real deployed frontend through MANAO_RUNTIME_BASE_URL. The accepted
 * java-runtime config keeps its own collection scope; this config collects only the new
 * python-runtime-lifecycle spec so the two acceptance rounds can never be mixed up.
 *
 * Required environment:
 * - MANAO_RUNTIME_BASE_URL        public entry URL of the deployed frontend (required here)
 * - MANAO_RUNTIME_USERNAME        test account username (checked by the spec)
 * - MANAO_RUNTIME_PASSWORD        test account password (checked by the spec)
 * - MANAO_RUNTIME_PUBLIC_PORT_1   first test public NodePort, operator-assigned (checked by the spec)
 * - MANAO_RUNTIME_PUBLIC_PORT_2   second test public NodePort, operator-assigned (checked by the spec)
 *
 * Optional environment:
 * - MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT  enables the FAILED-reconciliation
 *   acceptance case. The case needs a BACKEND fault injection (deployed for the
 *   Task 11 cloud acceptance round only) that leaves a dependency operation
 *   PENDING and its project FAILED with WORKSPACE_RECONCILIATION_REQUIRED.
 *   Without the variable that one case skips loudly and stays NOT_REVERIFIED -
 *   it must never pass vacuously on an unfaulted backend.
 *
 * Missing credentials or ports fail the run loudly in the spec's beforeAll - never a
 * silent skip. The two public ports are chosen by the operator up front; nothing here
 * scans for a free port or picks a number on the operator's behalf.
 */

const baseUrl = process.env.MANAO_RUNTIME_BASE_URL;

if (!baseUrl) {
  throw new Error(
    '环境变量 MANAO_RUNTIME_BASE_URL 未设置：Python 运行时云端生命周期 E2E 只允许访问真实公网入口，'
      + '请显式提供部署后的前端 URL（例如 http://203.0.113.7:30080），'
      + '本配置不会回退到任何本机地址或自动启动本地服务。',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  // Hard boundary: only the python-runtime lifecycle spec is collected, nothing else
  // and nothing from the accepted java-runtime or Stage 6B rounds.
  testMatch: /python-runtime-lifecycle\.spec\.ts/,
  fullyParallel: false,
  // Serial lifecycle: two projects flow through create -> READY -> run cycles -> stop
  // -> run again -> UI deletion. No parallelism, no retry masking.
  workers: 1,
  retries: 0,
  // Explicit: never boot a local webServer; the public ingress must already exist.
  webServer: undefined,
  reporter: 'list',
  // Per-test default for UI-only steps (login, form input, editor save): 5 minutes.
  // Run-heavy tests raise their own timeout via test.setTimeout() while staying under
  // the global cap.
  timeout: 300_000,
  // Whole-run cap: two projects with several cloud runs each (uv dependency preparation
  // included). One complete pass only - no automatic retry.
  globalTimeout: 7_200_000,
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
      name: 'python-runtime-cloud',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
