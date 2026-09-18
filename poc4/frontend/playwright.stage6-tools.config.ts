import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/tools',
  testMatch: 'stage6-cleanup-resume.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 660_000,
});
