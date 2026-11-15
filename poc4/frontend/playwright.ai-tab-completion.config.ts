import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.MANAO_TAB_BASE_URL;
for (const name of ['MANAO_TAB_BASE_URL', 'MANAO_TAB_USERNAME', 'MANAO_TAB_PASSWORD', 'MANAO_TAB_PROJECT_ID', 'MANAO_TAB_PHASE']) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}
if (!['local', 'cloud'].includes(process.env.MANAO_TAB_PHASE!)) throw new Error('Invalid MANAO_TAB_PHASE');
if (process.env.MANAO_TAB_PHASE === 'cloud' && ['localhost', '127.0.0.1', '::1'].includes(new URL(baseURL!).hostname)) {
  throw new Error('Cloud acceptance requires the deployed public origin');
}

export default defineConfig({
  testDir: './tests/e2e', testMatch: /ai-tab-completion-real\.spec\.ts/,
  workers: 1, fullyParallel: false, retries: 0, webServer: undefined,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL, trace: 'off', screenshot: 'off', video: 'off',
    actionTimeout: 30_000, navigationTimeout: 60_000 },
});
