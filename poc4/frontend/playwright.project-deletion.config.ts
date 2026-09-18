import { defineConfig, devices } from '@playwright/test';

// UI contract tests only: intercepted API responses, not real-cluster acceptance.
export default defineConfig({
  testDir: './tests/ui',
  testMatch: 'project-deletion.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/project-deletion-ui',
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4187',
    screenshot: 'only-on-failure',
    trace: 'off',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
