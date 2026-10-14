import { defineConfig, devices } from '@playwright/test';

/**
 * AI stage one: real coding-and-repair-loop acceptance against a dedicated
 * acceptance deployment (independent entry for the pi-stage1 plan, Task 6).
 *
 * Like the java-runtime config, this never starts or proxies any local service and
 * only drives the already-deployed acceptance environment through
 * MANAO_AI_ACCEPTANCE_BASE_URL. That deployment must be prepared by the bootstrap
 * step FIRST (scripts/ai-stage1-bootstrap.mjs): it creates the unique dedicated
 * project, seeds the broken source plus the verbatim acceptance fixture, records the
 * project id, and the acceptance backend is then started with
 * MANAO_AI_ENABLED=true and MANAO_AI_PROJECT_ID=<that id> and the frontend built
 * with VITE_ENABLE_AI=true. This config accepts the existing id through
 * MANAO_AI_ACCEPTANCE_PROJECT_ID - it never creates a project and never assumes the
 * server opens a project the browser invented.
 *
 * Required environment (all fail loudly; no silent skip, no mock substitution):
 * - MANAO_AI_ACCEPTANCE_BASE_URL      public entry URL of the acceptance frontend
 * - MANAO_AI_ACCEPTANCE_USERNAME      acceptance account username
 * - MANAO_AI_ACCEPTANCE_PASSWORD      acceptance account password
 * - MANAO_AI_ACCEPTANCE_PROJECT_ID    the bootstrap-recorded dedicated project id
 *
 * The run is one serial scene with no retries: a real model loop can take the full
 * 1800-second stage task budget, so the loop test raises its own timeout while the
 * whole run stays under the global cap. Nothing here mocks the model; without a real
 * provider configuration the loop test cannot pass and must not be faked.
 */

const baseUrl = process.env.MANAO_AI_ACCEPTANCE_BASE_URL;

if (!baseUrl) {
  throw new Error(
    '环境变量 MANAO_AI_ACCEPTANCE_BASE_URL 未设置：AI 第一阶段验收只允许访问为本次验收'
      + '专门准备的真实部署入口，请先运行 scripts/ai-stage1-bootstrap.mjs 并按 '
      + 'poc4/deploy/ai-stage1/README.md 准备环境（后端 MANAO_AI_ENABLED=true + '
      + 'MANAO_AI_PROJECT_ID、前端 VITE_ENABLE_AI=true），再显式提供前端 URL。'
      + '本配置不会回退到任何本机地址或自动启动本地服务。',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  // Hard boundary: only the ai-stage1 spec is collected, nothing else and nothing
  // from any other acceptance round.
  testMatch: /ai-stage1\.spec\.ts/,
  fullyParallel: false,
  // One serial scene: submit -> occupy -> reload -> settle -> verify -> release.
  workers: 1,
  retries: 0,
  // Explicit: never boot a local webServer; the acceptance deployment must exist.
  webServer: undefined,
  reporter: 'list',
  // Per-test default for UI steps; the real-loop test raises its own timeout.
  timeout: 300_000,
  // Whole-run cap: bootstrap + the up-to-1800s task budget + post-run checks, one
  // complete pass, no automatic retry.
  globalTimeout: 3_600_000,
  expect: {
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
      name: 'ai-stage1',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
