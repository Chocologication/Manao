import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { AccountPanel } from './AccountPanel';
import { useThemePreferences } from '@/features/preferences/themePreferences';
import { useEditorPreferences } from '@/features/editor/editorPreferences';

const authMock = vi.hoisted(() => ({ email: 'alice@example.com' as string | null }));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({
    snapshot: {
      status: 'authenticated',
      accessToken: 'panel-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: {
        id: 'actual-account-id',
        username: 'alice',
        email: authMock.email,
        emailVerified: authMock.email !== null,
      },
    },
  }),
}));

function LocationEcho() {
  const location = useLocation();
  const historyAction = useNavigationType();
  return (
    <div
      data-testid="location-echo"
      hidden
      data-pathname={location.pathname}
      data-history-action={historyAction}
    />
  );
}

function renderPanel(props: { compact?: boolean; onLogout: () => void }) {
  return render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route
          path="/projects"
          element={
            <>
              <LocationEcho />
              <AccountPanel {...props} />
            </>
          }
        />
        <Route
          path="/account/password"
          element={
            <>
              <LocationEcho />
              <main>CHANGE_PASSWORD_PAGE</main>
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function readPathname(): string {
  return screen.getByTestId('location-echo').getAttribute('data-pathname') ?? '';
}

beforeEach(() => {
  authMock.email = 'alice@example.com';
});

afterEach(() => {
  cleanup();
  useThemePreferences.getState().setPreference('lab');
  useEditorPreferences.getState().update({ fontSize: 14, wordWrap: false, minimap: false });
});

describe('account and preferences panel', () => {
  it('shows the authenticated account and email, copies its ID and restores trigger focus', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderPanel({ onLogout: vi.fn() });
    const trigger = screen.getByRole('button', { name: '账户与偏好' });
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: '账户与偏好' });
    expect(panel).toHaveTextContent('actual-account-id');
    expect(panel).toHaveTextContent('alice');
    expect(panel).toHaveTextContent('alice@example.com');
    await user.click(within(panel).getByRole('button', { name: '复制账户 ID' }));
    expect(copy).toHaveBeenCalledWith('actual-account-id');
    expect(within(panel).getByRole('status')).toHaveTextContent('账户 ID 已复制');
    await user.click(within(panel).getByRole('button', { name: '关闭账户面板' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('tells a legacy account without a bound email that email recovery is unavailable', async () => {
    authMock.email = null;
    const user = userEvent.setup();
    renderPanel({ onLogout: vi.fn() });
    await user.click(screen.getByRole('button', { name: '账户与偏好' }));
    const panel = screen.getByRole('dialog', { name: '账户与偏好' });
    expect(panel).toHaveTextContent(/未绑定邮箱/);
    expect(panel).toHaveTextContent(/无法通过邮箱找回/);
  });

  it('navigates to the change-password page and closes the panel', async () => {
    const user = userEvent.setup();
    renderPanel({ onLogout: vi.fn() });
    await user.click(screen.getByRole('button', { name: '账户与偏好' }));
    await user.click(screen.getByRole('link', { name: '修改密码' }));

    expect(await screen.findByText('CHANGE_PASSWORD_PAGE')).toBeInTheDocument();
    expect(readPathname()).toBe('/account/password');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('supports keyboard tabs, changes themes and reuses existing editor preferences', async () => {
    const user = userEvent.setup();
    renderPanel({ compact: true, onLogout: vi.fn() });
    await user.click(screen.getByRole('button', { name: '账户与偏好' }));
    screen.getByRole('tab', { name: '账户' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '外观' })).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: '日间浅色' }));
    expect(useThemePreferences.getState().theme).toBe('light');
    await user.click(screen.getByRole('tab', { name: '编辑器' }));
    const fontSize = screen.getByRole('spinbutton', { name: '代码字号' });
    await user.clear(fontSize);
    await user.type(fontSize, '18');
    expect(fontSize).toHaveValue(18);
    expect(useEditorPreferences.getState().fontSize).toBe(18);
    await user.clear(fontSize);
    await user.type(fontSize, '99');
    await user.tab();
    expect(fontSize).toHaveValue(24);
    await user.click(screen.getByRole('checkbox', { name: '自动换行' }));
    await user.click(screen.getByRole('checkbox', { name: /代码缩略图/ }));
    expect(useEditorPreferences.getState()).toMatchObject({ wordWrap: true, minimap: true });
    await user.click(screen.getByRole('button', { name: '恢复编辑器默认设置' }));
    expect(useEditorPreferences.getState()).toMatchObject({ fontSize: 14, wordWrap: false, minimap: false });
  });

  it('closes the account panel before invoking the existing logout guard', async () => {
    const user = userEvent.setup();
    const logout = vi.fn();
    renderPanel({ onLogout: logout });
    await user.click(screen.getByRole('button', { name: '账户与偏好' }));
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
