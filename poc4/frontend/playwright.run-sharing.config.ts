import { defineConfig, devices } from '@playwright/test';

const raw = process.env.MANAO_BASE_URL;
if (!raw) throw new Error('MANAO_BASE_URL_REQUIRED: explicitly provide the prepared real test site');
let site: URL;
try { site = new URL(raw); } catch { throw new Error('MANAO_BASE_URL_INVALID'); }
if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password
  || site.search || site.hash || site.pathname !== '/') throw new Error('MANAO_BASE_URL_INVALID');
for (const key of ['MANAO_RUN_SHARE_USERNAME', 'MANAO_RUN_SHARE_PASSWORD']) {
  if (!process.env[key]) throw new Error(`${key}_REQUIRED`);
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /[\\/]run-sharing\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: undefined,
  reporter: 'list',
  outputDir: 'test-results/run-sharing',
  timeout: 2_160_000,
  globalTimeout: 2_280_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: site.origin,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'run-sharing-chromium', use: { ...devices['Desktop Chrome'] } }],
});
