import { expect, test } from '../support/stage6-cleanup/fixtures';

/**
 * Dedicated Stage 6 cleanup slice. It creates a registered project through the ledgered
 * helper and relies on the per-test fixture to DELETE it. Real execution stays behind
 * STAGE6_GATE=1; this file is not a 6A PASS on its own.
 */
const ALICE = { username: 'alice', password: 'stage6-alice-pass' };
const GATE_MODE = process.env.STAGE6_GATE === '1';

async function backendReachable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/api/v1/projects');
    return [200, 401].includes(response.status());
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  const reachable = await backendReachable(request);
  if (!reachable) {
    test.skip(!GATE_MODE, '6A backend not reachable; gate-only suite');
    expect(reachable, '6A gate: backend must be reachable').toBe(true);
  }
});

test('registered project is deleted through the owner-scoped cleanup protocol', async ({ page, resources }) => {
  await page.goto('/');
  await page.getByLabel(/Username|用户名/i).fill(ALICE.username);
  await page.getByLabel(/Password|密码/i).fill(ALICE.password);
  await page.getByRole('button', { name: /Sign in|登录|login/i }).click();
  await expect(page.getByText(/Projects|项目/i).first()).toBeVisible();
  const project = await resources.createProject('alice', 'cleanup-slice');
  expect(project.id).toBeTruthy();
});
