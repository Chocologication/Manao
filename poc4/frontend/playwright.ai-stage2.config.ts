import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.MANAO_AI_ACCEPTANCE_BASE_URL;
if (!baseURL) throw new Error('Stage 2 requires an explicitly authorized acceptance BASE_URL; no local service is started.');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /ai-stage2\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: undefined,
  reporter: 'list',
  timeout: 300_000,
  globalTimeout: 3_600_000,
  expect: { timeout: 30_000 },
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [{ name: 'ai-stage2', use: { ...devices['Desktop Chrome'] } }],
});
