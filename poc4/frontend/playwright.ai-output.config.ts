import { defineConfig, devices } from '@playwright/test';
import { validateAiOutputEnvironment } from './tests/e2e/ai-output-contract';

// Config evaluation refuses before browser launch; discovery is not real-model acceptance.
const { baseURL } = validateAiOutputEnvironment(process.env);
export default defineConfig({
  testDir: './tests/e2e', testMatch: /ai-output\.spec\.ts/, fullyParallel: false,
  workers: 1, retries: 0, webServer: undefined, reporter: 'list',
  timeout: 1_800_000, globalTimeout: 1_900_000, expect: { timeout: 30_000 },
  use: { baseURL, trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [{ name: 'ai-output', use: { ...devices['Desktop Chrome'] } }],
});
