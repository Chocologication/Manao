import { defineConfig, devices } from '@playwright/test';

// Local mock-mode browser acceptance for the multi-account lifecycle pages
// (/register, /forgot-password, /account/password and the login entries).
//
// This config starts exactly one local process: the Vite mock build + preview of this
// repository's own frontend. The mock build (--mode mock, .env.mock sets
// VITE_ENABLE_MOCK_API=true) serves the MSW test doubles; there is no backend, no SMTP,
// no IMAP, no real email, no 126 login and no cluster access. The mock captcha accepts any
// non-empty answer and the mock email challenges accept any 6-digit code: they are
// deterministic test doubles, not real verification.
export default defineConfig({
  testDir: './tests/e2e',
  // Hard boundary: only the local mock multi-account spec is collected.
  testMatch: /multi-account\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4188',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build:mock && pnpm preview --host 127.0.0.1 --port 4188',
    url: 'http://127.0.0.1:4188',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
