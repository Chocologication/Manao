import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm build:mock && pnpm preview --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev:echo',
      url: 'http://127.0.0.1:4174/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: /stage2-large-files\.spec\.ts|stage3-large-writes\.spec\.ts|stage4-large-logs\.spec\.ts|stage5-terminal-stress\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chrome',
      testIgnore: /stage2-large-files\.spec\.ts|stage3-large-writes\.spec\.ts|stage4-large-logs\.spec\.ts|stage5-terminal-stress\.spec\.ts/,
      use: { channel: 'chrome' },
    },
    {
      name: 'edge',
      testIgnore: /stage2-large-files\.spec\.ts|stage3-large-writes\.spec\.ts|stage4-large-logs\.spec\.ts|stage5-terminal-stress\.spec\.ts/,
      use: { channel: 'msedge' },
    },
    {
      name: 'chromium-large-files',
      testMatch: /stage2-large-files\.spec\.ts/,
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-large-writes',
      testMatch: /stage3-large-writes\.spec\.ts/,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-large-logs',
      testMatch: /stage4-large-logs\.spec\.ts/,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-terminal-stress',
      testMatch: /stage5-terminal-stress\.spec\.ts/,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
