import { defineConfig, devices } from '@playwright/test';
import { acceptanceEnvironment } from './tests/e2e/ai-python-contract';

// Fail before browser launch. No local service, provider substitute, retries or default project.
const environment = acceptanceEnvironment(process.env);
export default defineConfig({
  testDir: './tests/e2e', testMatch: /ai-python\.spec\.ts/,
  workers: 1, fullyParallel: false, retries: 0, webServer: undefined,
  timeout: 7_200_000, globalTimeout: 18_000_000, reporter: 'list',
  expect: { timeout: 30_000 },
  use: { baseURL: environment.baseURL, trace: 'off', screenshot: 'off', video: 'off',
    actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [{ name: 'ai-python-real', use: { ...devices['Desktop Chrome'] } }],
});
