import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/ui',testMatch:/ai-image-input\.spec\.ts/,workers:1,retries:0,timeout:60_000,reporter:'list',
  use:{baseURL:'http://127.0.0.1:4189',trace:'off',screenshot:'off'},
  webServer:{command:'pnpm exec vite --host 127.0.0.1 --port 4189 --strictPort',url:'http://127.0.0.1:4189/tests/ui/ai-image-input.html',reuseExistingServer:false},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
});
