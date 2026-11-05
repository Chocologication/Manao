import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: /(?:node-runtime-mock|assistant-studio)\.spec\.ts/,
  fullyParallel: false, workers: 1, retries: 0, timeout: 60000,
  expect: { timeout: 15000 }, reporter: 'list',
  outputDir: process.env.MANAO_NODE_BROWSER_OUTPUT ?? 'test-results/node-runtime',
  use: { baseURL: 'http://127.0.0.1:4194', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm dev:mock --host 127.0.0.1 --port 4194 --strictPort', url: 'http://127.0.0.1:4194', reuseExistingServer: false, timeout: 90000, env: { VITE_ENABLE_AI: 'true' } },
});
