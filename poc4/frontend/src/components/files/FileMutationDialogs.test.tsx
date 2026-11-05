import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVE_MESSAGE,
  requestUnsavedDialog,
  resetUnsavedDialog,
} from '../../features/editor/unsavedChangesGuard';
import { FileMutationDialogs } from './FileMutationDialogs';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

afterEach(() => {
  cleanup();
  resetUnsavedDialog();
});

describe('FileMutationDialogs', () => {
  it('labels the basename input, focuses it on open, and uses a New file title', () => {
    render(
      <FileMutationDialogs
        open
        kind="create-file"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '新建文件' });
    const input = screen.getByLabelText('名称');
    expect(dialog).toContainElement(input);
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute('placeholder', expect.stringMatching(/src\//));
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });

  it('uses a New folder title for directory create', () => {
    render(
      <FileMutationDialogs
        open
        kind="create-folder"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveFocus();
  });

  it('submits a valid basename with Enter and Create', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <FileMutationDialogs open kind="create-file" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    await user.type(screen.getByLabelText('名称'), '你好.java');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('你好.java');

    onSubmit.mockClear();
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(onSubmit).toHaveBeenCalledWith('你好.java');
  });

  it('cancels with Escape and the Cancel button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <FileMutationDialogs open kind="create-file" onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['', 'src/App.java', 'App\\java', '.', '..'])(
    'shows local validation for %j before requesting',
    async (value) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(
        <FileMutationDialogs open kind="create-folder" onSubmit={onSubmit} onCancel={() => {}} />,
      );

      const input = screen.getByLabelText('名称');
      if (value !== '') {
        await user.type(input, value);
      }
      await user.keyboard('{Enter}');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('请输入有效名称，不能包含路径分隔符或仅使用点号');
      expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeInTheDocument();
      expect(input).toHaveValue(value);
    },
  );

  it('keeps the dialog open when a server error is shown', async () => {
    const user = userEvent.setup();
    render(
      <FileMutationDialogs
        open
        kind="create-file"
        errorMessage="已存在同名文件或文件夹"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const input = screen.getByLabelText('名称');
    await user.type(input, 'pom.xml');
    expect(screen.getByRole('alert')).toHaveTextContent('已存在同名文件或文件夹');
    expect(screen.getByRole('dialog', { name: '新建文件' })).toBeInTheDocument();
    expect(input).toHaveValue('pom.xml');
  });

  it('disables submit while pending without replacing the dialog controls', () => {
    render(
      <FileMutationDialogs
        open
        kind="create-file"
        pending
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const create = screen.getByRole('button', { name: '创建' });
    expect(create).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
  });

  it('does not show a second native dialog while the unsaved modal is open', () => {
    requestUnsavedDialog({
      open: true,
      mode: 'leave',
      action: { type: 'logout' },
      message: LEAVE_MESSAGE,
    });
    render(
      <>
        <UnsavedChangesDialog
          open
          mode="leave"
          message={LEAVE_MESSAGE}
          onDiscard={() => {}}
          onCancel={() => {}}
        />
        <FileMutationDialogs
          open
          kind="create-file"
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      </>,
    );

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: '有未保存的修改' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '新建文件' })).not.toBeInTheDocument();
  });

  it('prefills rename with the current basename selected', async () => {
    render(
      <FileMutationDialogs
        open
        kind="rename"
        currentName="App.java"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const input = screen.getByLabelText('名称') as HTMLInputElement;
    expect(screen.getByRole('dialog', { name: '重命名' })).toContainElement(input);
    expect(input).toHaveValue('App.java');
    expect(input).toHaveFocus();
    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('App.java'.length);
    });
    expect(screen.getByRole('button', { name: '重命名' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });

  it('submits the renamed basename with Enter and Rename', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <FileMutationDialogs
        open
        kind="rename"
        currentName="App.java"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    const input = screen.getByLabelText('名称');
    fireEvent.change(input, { target: { value: 'Main.java' } });
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Main.java');

    onSubmit.mockClear();
    await user.click(screen.getByRole('button', { name: '重命名' }));
    expect(onSubmit).toHaveBeenCalledWith('Main.java');
  });

  it('shows the exact relative path and file icon, and focuses Cancel on delete', () => {
    render(
      <FileMutationDialogs
        open
        kind="delete"
        targetPath="src/main/java/demo/App.java"
        targetKind="file"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '删除' });
    expect(dialog).toHaveTextContent('src/main/java/demo/App.java');
    expect(dialog.querySelector('svg')).not.toBeNull();
    expect(dialog).toHaveAttribute('data-entry-kind', 'file');
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    const confirm = screen.getByRole('button', { name: '删除' });
    expect(confirm.className).toMatch(/bg-destructive/);
    expect(confirm.className).toMatch(/\bh-8\b|\bh-9\b/);
    expect(confirm).toBeEnabled();
  });

  it('shows a directory icon and nested-content warning on folder delete', () => {
    render(
      <FileMutationDialogs
        open
        kind="delete"
        targetPath="src/main"
        targetKind="directory"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '删除' });
    expect(dialog).toHaveAttribute('data-entry-kind', 'directory');
    expect(dialog).toHaveTextContent('src/main');
    expect(dialog).toHaveTextContent(/此操作无法撤销/i);
    expect(dialog).toHaveTextContent(/其他文件和子文件夹/i);
  });

  it('confirms delete without side effects on Cancel or Escape', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <FileMutationDialogs
        open
        kind="delete"
        targetPath="README.md"
        targetKind="file"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits delete from the destructive confirm button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <FileMutationDialogs
        open
        kind="delete"
        targetPath="README.md"
        targetKind="file"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    await user.click(within(screen.getByRole('dialog', { name: '删除' })).getByRole('button', { name: '删除' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps delete confirm size when pending', () => {
    render(
      <FileMutationDialogs
        open
        kind="delete"
        targetPath="README.md"
        targetKind="file"
        pending
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const confirm = screen.getByRole('button', { name: '删除' });
    expect(confirm).toBeDisabled();
    expect(confirm.className).toMatch(/\bh-8\b|\bh-9\b/);
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });

  it('does not show rename or delete while the unsaved modal is open', () => {
    requestUnsavedDialog({
      open: true,
      mode: 'leave',
      action: { type: 'logout' },
      message: LEAVE_MESSAGE,
    });
    render(
      <>
        <UnsavedChangesDialog
          open
          mode="leave"
          message={LEAVE_MESSAGE}
          onDiscard={() => {}}
          onCancel={() => {}}
        />
        <FileMutationDialogs
          open
          kind="delete"
          targetPath="pom.xml"
          targetKind="file"
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      </>,
    );

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: '有未保存的修改' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '删除' })).not.toBeInTheDocument();
  });
});
