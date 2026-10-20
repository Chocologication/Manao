import { expect, type Locator, type Page } from '@playwright/test';

/** Opens the complete creation form used by the cloud lifecycle scenes. */
export async function openCloudProjectCreation(page: Page): Promise<void> {
  // Only the console toggle owns aria-expanded; the empty-state shortcut shares its name.
  const toggle = page.getByRole('button', { name: '新建项目', exact: true })
    .and(page.locator('[aria-expanded]'));
  await expect(toggle).toHaveAttribute('aria-expanded', /^(true|false)$/);
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.locator('.lab-create-region')).toBeVisible();
  const allConfiguration = page.getByRole('button', { name: '所有配置', exact: true });
  if (await allConfiguration.count() > 0) await allConfiguration.click();
  await expect(page.getByLabel('Template', { exact: true })).toBeVisible();
}

export function unconfirmedDependencyAlert(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: /^依赖变更尚未确认$/ });
}
