import { expect, test, type Page } from '@playwright/test';
import { openCloudProjectCreation, unconfirmedDependencyAlert } from '../support/cloudWorkbench';

// Local browser coverage of the page operations shared with the cloud specs.
// Backend provisioning and durable cloud receipts still require cloud acceptance.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function signIn(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  const login = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/auth/login' &&
    response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const body = await (await login).json() as { accessToken: string };
  await expect(page).toHaveURL(/\/projects(?:\/[^/]+)?$/);
  return body.accessToken;
}

test('cloud entry opens the collapsed form and exposes every runtime template', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('article', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByLabel('Template', { exact: true })).toHaveCount(0);
  await openCloudProjectCreation(page);
  await expect(page.getByLabel('Template', { exact: true }).locator('option')).toHaveText([
    'Java console', 'Java Spring Boot web', 'Python console', 'Python FastAPI web',
  ]);
});

test('cloud creation remains unambiguous on an empty account and can be reopened', async ({ page }) => {
  await signIn(page);
  const seed = page.getByRole('article', { name: 'Alice Notebook' });
  await seed.getByRole('button', { name: 'Delete project', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(seed).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toHaveCount(2);
  await openCloudProjectCreation(page);
  await openCloudProjectCreation(page);
  await page.getByLabel('Project name').fill('cloud-ui-empty-account');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('article', { name: 'cloud-ui-empty-account' }).locator('p[data-state]'))
    .toHaveAttribute('data-state', 'READY');
});

test('unconfirmed dependency alert survives workbench re-entry and clears after checking the same operation', async ({ page }) => {
  const token = await signIn(page);
  await openCloudProjectCreation(page);
  await page.getByLabel('Project name').fill('cloud-ui-python-recovery');
  await page.getByLabel('Template', { exact: true }).selectOption('python-console');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const card = page.getByRole('article', { name: 'cloud-ui-python-recovery' });
  await expect(card.locator('p[data-state]')).toHaveAttribute('data-state', 'READY');
  await card.getByRole('link', { name: 'Open', exact: true }).click();
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  const dependencyPath = `/api/v1/projects/${projectId}/python-dependencies`;
  const submittedOperations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === dependencyPath) {
      submittedOperations.push((request.postDataJSON() as { operationId: string }).operationId);
    }
  });
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click();
  const scenarioStatus = await page.evaluate(async (accessToken) => (await fetch(
    '/api/v1/session/dependency-scenario', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'lost-response' }),
    },
  )).status, token);
  expect(scenarioStatus).toBe(204);
  await page.getByLabel('Package name').fill('requests');
  await page.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(unconfirmedDependencyAlert(page)).toBeVisible();
  expect(submittedOperations).toHaveLength(1);
  const operationId = submittedOperations[0]!;

  // MSW project/receipt state lives in this page's memory. Re-enter through the SPA
  // to exercise client operation-id restoration; full reload remains a cloud test.
  await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('article', { name: 'cloud-ui-python-recovery' })
    .getByRole('link', { name: 'Open', exact: true }).click();
  await expect(unconfirmedDependencyAlert(page)).toBeVisible();
  expect(submittedOperations).toEqual([operationId]);
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeDisabled();
  const check = page.getByRole('button', { name: 'Check dependency change', exact: true });
  await expect(check).toBeEnabled();
  const receipt = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${dependencyPath}/${operationId}` &&
    response.request().method() === 'GET',
  );
  await check.click();
  expect((await receipt).ok()).toBe(true);
  await expect(unconfirmedDependencyAlert(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeEnabled();
  expect(submittedOperations).toEqual([operationId]);
  const declaration = await page.evaluate(async ({ projectId, accessToken }) => {
    const response = await fetch(`/api/v1/projects/${projectId}/files/content?path=pyproject.toml`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Cannot read dependency declaration: ${response.status}`);
    return (await response.json() as { content: string }).content;
  }, { projectId, accessToken: token });
  expect(declaration).toContain('requests');
});
