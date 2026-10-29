import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['visual/ai-ui.spec.ts', 'e2e/cloud-workbench-ui.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 60_000,
  expect: { timeout: 10_000 }, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4183', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build:mock && pnpm preview --host 127.0.0.1 --port 4183',
    url: 'http://127.0.0.1:4183', reuseExistingServer: false,
    env: { VITE_ENABLE_AI: 'true', VITE_AI_UI_FIXTURE: 'true' }, timeout: 120_000,
  },
});
