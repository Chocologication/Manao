import { defineConfig, devices } from '@playwright/test';

// Fail before browser launch, service startup or model/cluster access. --list is not acceptance.
const required = ['MANAO_AI_ACCEPTANCE_BASE_URL', 'MANAO_AI_ACCEPTANCE_PROJECT_ID',
  'MANAO_AI_ACCEPTANCE_USERNAME', 'MANAO_AI_ACCEPTANCE_PASSWORD', 'MANAO_AI_CONTEXT_KUBE_CONTEXT',
  'MANAO_AI_CONTEXT_NAMESPACE', 'MANAO_AI_CONTEXT_WORKER_DEPLOYMENT', 'MANAO_AI_CONTEXT_FIXTURE_PATH'] as const;
const missing = required.filter(name => !process.env[name]);
if (process.env.MANAO_AI_CONTEXT_MODEL_AUTHORIZED !== 'true' ||
    process.env.MANAO_AI_CONTEXT_RESTART_AUTHORIZED !== 'true' ||
    process.env.MANAO_AI_CONTEXT_GLOBAL_IDLE_CONFIRMED !== 'true' || missing.length) {
  throw new Error(`NOT_RUN: AI context needs this round's model/restart authorization, operator-confirmed global idle worker and explicit environment (${missing.join(', ')}). No browser/service/model/cluster action started.`);
}
const baseURL = process.env.MANAO_AI_ACCEPTANCE_BASE_URL!;
const origin = new URL(baseURL);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('NOT_RUN: BASE_URL must be an explicit HTTP(S) origin without credentials.');
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.txt$/.test(process.env.MANAO_AI_CONTEXT_FIXTURE_PATH!)) {
  throw new Error('NOT_RUN: fixture must be an explicit project-relative top-level .txt name without traversal.');
}
export default defineConfig({
  testDir: './tests/e2e', testMatch: /ai-context\.spec\.ts/, fullyParallel: false,
  workers: 1, retries: 0, webServer: undefined, reporter: 'list',
  timeout: 1_800_000, globalTimeout: 1_900_000, expect: { timeout: 30_000 },
  // Credentials and real project content must not enter automatic trace/screenshot artifacts.
  use: { baseURL, trace: 'off', screenshot: 'off', actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [{ name: 'ai-context', use: { ...devices['Desktop Chrome'] } }],
});
