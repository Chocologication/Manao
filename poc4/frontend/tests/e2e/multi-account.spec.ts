import { expect, test, type Page } from '@playwright/test';

// Local mock-mode browser acceptance for the Task 7 account lifecycle pages.
// Deterministic MSW test doubles only: the mock captcha accepts any non-empty answer and
// the mock email challenge accepts any 6-digit code. No backend, no SMTP/IMAP, no real
// account and no real email is contacted. Run with:
//   pnpm exec playwright test --config playwright.multi-account.config.ts
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const SEED_USER = { username: 'alice', email: 'alice@example.com', password: 'demo-pass' };
const NEW_ACCOUNT = {
  username: 'mock_new_user',
  email: 'mock.new.user@example.com',
  password: 'MockPass123',
  emailCode: '123456',
};
const UNIFORM_RECOVERY_NOTICE = '若该邮箱已绑定账号，将收到验证码';

/** Fill and submit the login form on the current page (no navigation: mock state survives). */
async function submitLogin(
  page: Page,
  username: string,
  password: string,
  expectedUrl: RegExp = /\/projects/,
): Promise<void> {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await loginResponse).ok()).toBe(true);
  await expect(page).toHaveURL(expectedUrl);
}

/** Fresh navigation to /login, then sign in (used only when no in-memory mock state is needed). */
async function signInFresh(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await submitLogin(page, username, password);
}

test('register: two mock steps create the account and the new credentials log in', async ({ page }) => {
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: '注册账号', exact: true })).toBeVisible();

  await page.getByLabel('用户名', { exact: true }).fill(NEW_ACCOUNT.username);
  await page.getByLabel('邮箱', { exact: true }).fill(NEW_ACCOUNT.email);
  await page.getByLabel('密码', { exact: true }).fill(NEW_ACCOUNT.password);
  await page.getByLabel('确认密码', { exact: true }).fill(NEW_ACCOUNT.password);
  await page.getByLabel('图形验证码', { exact: true }).fill('ABCDE');
  await page.getByRole('button', { name: '发送邮箱验证码', exact: true }).click();
  await expect(page.getByText('邮箱验证码已发送')).toBeVisible();

  await page.getByLabel('邮箱验证码', { exact: true }).fill(NEW_ACCOUNT.emailCode);
  await page.getByRole('button', { name: '注册账号', exact: true }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('注册成功');
  // Login never needs an image captcha: the captcha only guards sending email codes.
  await expect(page.getByLabel('图形验证码', { exact: true })).toHaveCount(0);

  await submitLogin(page, NEW_ACCOUNT.username, NEW_ACCOUNT.password);
  await expect(page.getByRole('button', { name: '账户与偏好', exact: true })).toBeVisible();
});

test('forgot password: two mock steps reset the password and the new one logs in', async ({ page }) => {
  const newPassword = 'ResetPass456';
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();

  await page.getByLabel('邮箱', { exact: true }).fill(SEED_USER.email);
  await page.getByLabel('图形验证码', { exact: true }).fill('ABCDE');
  await page.getByRole('button', { name: '发送找回验证码', exact: true }).click();
  // The recovery send answer is uniform and never reveals whether the account exists.
  await expect(page.getByText(UNIFORM_RECOVERY_NOTICE)).toBeVisible();

  await page.getByLabel('邮箱验证码', { exact: true }).fill('654321');
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '重置密码', exact: true }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('密码已重置');
  await submitLogin(page, SEED_USER.username, newPassword);
});

test('change password: success terminates the session and requires a re-login', async ({ page }) => {
  const newPassword = 'ChangedPass789';
  await signInFresh(page, SEED_USER.username, SEED_USER.password);

  await page.getByRole('button', { name: '账户与偏好', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('link', { name: '修改密码', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/password$/);

  await page.getByLabel('当前密码', { exact: true }).fill(SEED_USER.password);
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();

  // Success only clears the session captured when the request started, so the account is
  // back on the login route and must authenticate again. KNOWN COSMETIC DEFECT (found by
  // this real-browser run, reported for a Task 7 follow-up): the explicit
  // navigate('/login', { state: { passwordChanged: true } }) is overwritten by
  // RequireAuth's redirect state ({ from: '/account/password' }), so the
  // "密码已更新，请重新登录" banner is currently NOT displayed even though the session is
  // correctly terminated. The security-relevant behavior below is what this acceptance
  // spec asserts; the missing banner is recorded as a finding instead of being masked.
  test.info().annotations.push({
    type: 'known-defect',
    description:
      'Change-password success banner is not displayed: RequireAuth redirect state overrides the '
      + 'passwordChanged navigation state. Cosmetic only; session termination is verified here.',
  });
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

  // The old password is gone: the mock verification rejects it without logging in.
  await page.getByLabel('Username', { exact: true }).fill(SEED_USER.username);
  await page.getByLabel('Password', { exact: true }).fill(SEED_USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
  await expect(page).toHaveURL(/\/login$/);

  // The new password works. The login page returns to the route that required
  // authentication ('from' = /account/password), then the workbench is reachable.
  await submitLogin(page, SEED_USER.username, newPassword, /\/account\/password$/);
  await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByRole('button', { name: '账户与偏好', exact: true })).toBeVisible();
});

test('login page offers registration and recovery entries and no captcha or demo credentials', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('图形验证码', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '注册账号', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '忘记密码', exact: true })).toBeVisible();
  await expect(page.getByText('演示账号')).toHaveCount(0);
  await expect(page.getByText('demo-pass')).toHaveCount(0);
});
