import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'ai-terminal-settlement.spec.ts',workers:1,fullyParallel:false,retries:0,
  timeout:60_000,expect:{timeout:15_000},reporter:'list',
  globalSetup:'./tests/fixtures/ai-terminal-settlement/setup.ts',
  use:{baseURL:'http://127.0.0.1:4189',trace:'retain-on-failure'},
  outputDir:'test-results/ai-terminal-settlement',
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'pnpm exec vite --config tests/fixtures/ai-terminal-settlement/vite.config.ts --host 127.0.0.1 --port 4189 --strictPort',
    url:'http://127.0.0.1:4189/tests/fixtures/ai-terminal-settlement/index.html',reuseExistingServer:false,timeout:120_000},
});
