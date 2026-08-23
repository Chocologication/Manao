import { cleanup, render, screen } from '@testing-library/react';
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

    const dialog = screen.getByRole('dialog', { name: 'New file' });
    const input = screen.getByLabelText('Name');
    expect(dialog).toContainElement(input);
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute('placeholder', expect.stringMatching(/src\//));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
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

    expect(screen.getByRole('dialog', { name: 'New folder' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('submits a valid basename with Enter and Create', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <FileMutationDialogs open kind="create-file" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    await user.type(screen.getByLabelText('Name'), '你好.java');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('你好.java');

    onSubmit.mockClear();
    await user.click(screen.getByRole('button', { name: 'Create' }));
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

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
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

      const input = screen.getByLabelText('Name');
      if (value !== '') {
        await user.type(input, value);
      }
      await user.keyboard('{Enter}');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Entry name required');
      expect(screen.getByRole('dialog', { name: 'New folder' })).toBeInTheDocument();
      expect(input).toHaveValue(value);
    },
  );

  it('keeps the dialog open when a server error is shown', async () => {
    const user = userEvent.setup();
    render(
      <FileMutationDialogs
        open
        kind="create-file"
        errorMessage="An entry with this name already exists"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const input = screen.getByLabelText('Name');
    await user.type(input, 'pom.xml');
    expect(screen.getByRole('alert')).toHaveTextContent('An entry with this name already exists');
    expect(screen.getByRole('dialog', { name: 'New file' })).toBeInTheDocument();
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

    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
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
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New file' })).not.toBeInTheDocument();
  });
});
