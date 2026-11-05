import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['login-entry.spec.ts', 'registration.spec.ts', 'multi-account.spec.ts'],
  workers: 1,
  retries: 0,
  reporter: 'list',
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4184',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: '.\\node_modules\\.bin\\vite.cmd --mode mock --host 127.0.0.1 --port 4184',
    url: 'http://127.0.0.1:4184',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
