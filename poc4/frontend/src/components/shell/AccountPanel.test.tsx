import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountPanel } from './AccountPanel';
import { useThemePreferences } from '@/features/preferences/themePreferences';
import { useEditorPreferences } from '@/features/editor/editorPreferences';

vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ snapshot: { status: 'authenticated', user: { id: 'actual-account-id', username: 'alice' } } }) }));

afterEach(() => {
  cleanup();
  useThemePreferences.getState().setPreference('lab');
  useEditorPreferences.getState().update({ fontSize: 14, wordWrap: false, minimap: false });
});

describe('account and preferences panel', () => {
  it('shows the authenticated account, copies its ID and restores trigger focus', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<AccountPanel onLogout={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '账户与偏好' });
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: '账户与偏好' });
    expect(panel).toHaveTextContent('actual-account-id');
    expect(panel).toHaveTextContent('alice');
    await user.click(within(panel).getByRole('button', { name: '复制账户 ID' }));
    expect(copy).toHaveBeenCalledWith('actual-account-id');
    expect(within(panel).getByRole('status')).toHaveTextContent('账户 ID 已复制');
    await user.click(within(panel).getByRole('button', { name: '关闭账户面板' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('supports keyboard tabs, changes themes and reuses existing editor preferences', async () => {
    const user = userEvent.setup();
    render(<AccountPanel compact onLogout={vi.fn()} />);
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
    render(<AccountPanel onLogout={logout} />);
    await user.click(screen.getByRole('button', { name: '账户与偏好' }));
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
