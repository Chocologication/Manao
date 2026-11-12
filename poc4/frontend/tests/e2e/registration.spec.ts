import { expect, test } from '@playwright/test';

test('registration completes from the login entry and the new account can sign in', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (reason) => errors.push(reason.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/login');
  await page.getByRole('link', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page).toHaveTitle('注册账号 | 码瑙');
  await expect(page.getByLabel('图形验证码', { exact: true })).toBeEnabled();
  await expect(page.getByRole('img', { name: '图形验证码', exact: true })).toBeVisible();
  await expect(page.locator('.entry__feature').last()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('registration-desktop.png'), fullPage: true });
  await page.getByLabel('用户名', { exact: true }).fill('lab_new_user');
  await page.getByLabel('邮箱', { exact: true }).fill('lab-new@example.com');
  await page.getByLabel('密码', { exact: true }).fill('new-lab-password');
  await page.getByLabel('确认密码').fill('new-lab-password');
  await page.getByLabel('图形验证码', { exact: true }).fill('MANAO');
  await page.getByRole('button', { name: '发送邮箱验证码' }).click();
  await expect(page.getByText('邮箱验证码已发送', { exact: false })).toBeVisible();
  await expect(page.getByLabel('邮箱验证码')).toBeFocused();
  await expect(page.getByRole('button', { name: '重新发送验证码' })).toBeDisabled();
  await page.getByLabel('邮箱验证码').fill('123456');
  await page.screenshot({ path: testInfo.outputPath('registration-verify.png'), fullPage: true });
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('注册成功');
  await page.getByLabel('Username').fill('lab_new_user');
  await page.getByLabel('Password', { exact: true }).fill('new-lab-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect(errors).toEqual([]);
});

test('registration adapts to a narrow screen and supports reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/register');
  await expect(page.getByLabel('图形验证码', { exact: true })).toBeEnabled();
  await expect(page.locator('.entry__atmosphere')).toHaveAttribute('data-background-state', 'still');
  await expect(page.locator('.entry__instrument')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: '返回登录' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('registration-narrow.png'), fullPage: true });
  await page.getByRole('link', { name: '返回登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
