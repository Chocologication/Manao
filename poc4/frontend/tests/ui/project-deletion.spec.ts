import { expect, test, type Page } from '@playwright/test';

const project = { id: 'delete-target', name: 'Deletion demo', state: 'READY',
  createdAt: '2026-09-16T00:00:00Z', failureReason: null };
async function setup(page: Page, behavior: 'success' | 'incomplete' | 'lost-response' | 'conflict') {
  let items = [project, { ...project, id: 'keep', name: 'Keep this project' }];
  let deletes = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/login') {
      await route.fulfill({ json: { accessToken: 'browser-test-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: { id: 'alice', username: 'alice' } } });
    } else if (url.pathname === '/api/v1/projects' && request.method() === 'GET') {
      await route.fulfill({ json: { items, limit: 8 } });
    } else if (url.pathname === '/api/v1/projects/delete-target' && request.method() === 'DELETE') {
      deletes++;
      if (behavior === 'conflict') {
        await route.fulfill({ status: 409, json: { code: 'RUN_ALREADY_ACTIVE', message: 'Active run', traceId: 'test' } });
      } else if (behavior === 'incomplete' && deletes === 1) {
        items[0] = { ...project, state: 'DELETING' };
        await route.fulfill({ status: 503, json: { code: 'PROJECT_CLEANUP_INCOMPLETE', message: 'Incomplete', traceId: 'test' } });
      } else {
        items = items.filter((item) => item.id !== project.id);
        if (behavior === 'lost-response') await route.abort('connectionreset');
        else await route.fulfill({ status: 204 });
      }
    } else {
      await route.fulfill({ status: 404, json: { code: 'ENTRY_NOT_FOUND', message: 'Not found', traceId: 'test' } });
    }
  });
  return { deletes: () => deletes };
}
async function signIn(page: Page) {
  await page.goto('/projects');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}
async function confirm(page: Page) {
  await page.getByRole('article', { name: project.name }).getByRole('button', { name: 'Delete project' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
}

test('confirmation can be cancelled with Escape; confirmed deletion removes only the target', async ({ page }, info) => {
  const api = await setup(page, 'success');
  await signIn(page);
  const card = page.getByRole('article', { name: project.name });
  await card.getByRole('button', { name: 'Delete project' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete project?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('delete-confirmation.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(api.deletes()).toBe(0);
  await confirm(page);
  await expect(page.getByRole('status')).toHaveText('Project deleted.');
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Keep this project' })).toBeVisible();
  expect(api.deletes()).toBe(1);
  await signIn(page);
  await expect(card).toHaveCount(0);
});

test('incomplete deletion survives reload and finishes only after explicit continuation', async ({ page }, info) => {
  const api = await setup(page, 'incomplete');
  await signIn(page);
  await confirm(page);
  await expect(page.getByRole('button', { name: 'Continue deletion' })).toBeVisible();
  await expect(page.getByRole('article', { name: project.name })).toBeVisible();
  await expect(page.getByText('Project deleted.')).toHaveCount(0);
  await signIn(page);
  expect(api.deletes()).toBe(1);
  await expect(page.getByText(/deletion has not completed/i)).toBeVisible();
  await page.screenshot({ path: info.outputPath('deletion-incomplete.png') });
  await page.getByRole('button', { name: 'Continue deletion' }).click();
  await expect(page.getByText('Project deleted.')).toBeVisible();
  expect(api.deletes()).toBe(2);
});

test('lost success response is reconciled without a duplicate DELETE', async ({ page }) => {
  const api = await setup(page, 'lost-response');
  await signIn(page);
  await confirm(page);
  await expect(page.getByText('Project deleted.')).toBeVisible();
  expect(api.deletes()).toBe(1);
});

test('active Run conflict leaves the project visible and usable', async ({ page }) => {
  const api = await setup(page, 'conflict');
  await signIn(page);
  await confirm(page);
  await expect(page.getByRole('alert')).toContainText('Finish or stop the active Run');
  await expect(page.getByRole('article', { name: project.name }).getByRole('link', { name: 'Open' })).toBeVisible();
  await expect(page.getByText('Project deleted.')).toHaveCount(0);
  expect(api.deletes()).toBe(1);
});
