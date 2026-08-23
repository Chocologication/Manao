import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANCEL_LABEL,
  CLOSE_TAB_MESSAGE,
  DISCARD_AND_LEAVE_LABEL,
  DISCARD_LABEL,
  LEAVE_MESSAGE,
  REMAINING_CHANGES_MESSAGE,
  SAVE_AND_CLOSE_LABEL,
} from '@/features/editor/unsavedChangesGuard';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

afterEach(() => {
  cleanup();
});

describe('UnsavedChangesDialog', () => {
  it('renders Save and close, Discard and Cancel for a dirty tab and never Save All', async () => {
    const user = userEvent.setup();
    const onSaveAndClose = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        open
        mode="close-tab"
        message={CLOSE_TAB_MESSAGE}
        onSaveAndClose={onSaveAndClose}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
    expect(dialog).toHaveTextContent(CLOSE_TAB_MESSAGE);
    expect(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL })).toBeEnabled();
    expect(screen.getByRole('button', { name: DISCARD_LABEL })).toBeEnabled();
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toBeEnabled();
    expect(screen.queryByRole('button', { name: DISCARD_AND_LEAVE_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save all/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL }));
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders Discard and leave / Cancel for leave and never Save All', async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        open
        mode="leave"
        message={LEAVE_MESSAGE}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toHaveTextContent(LEAVE_MESSAGE);
    expect(screen.getByRole('button', { name: DISCARD_AND_LEAVE_LABEL })).toBeEnabled();
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toBeEnabled();
    expect(screen.queryByRole('button', { name: SAVE_AND_CLOSE_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save all/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: DISCARD_AND_LEAVE_LABEL }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('treats Escape as Cancel with no discard or save', async () => {
    const user = userEvent.setup();
    const onSaveAndClose = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        open
        mode="close-tab"
        message={CLOSE_TAB_MESSAGE}
        onSaveAndClose={onSaveAndClose}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onSaveAndClose).not.toHaveBeenCalled();
  });

  it('initializes focus, contains Tab, and restores the trigger on close', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Open guard';
    document.body.append(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { rerender } = render(
      <UnsavedChangesDialog
        open
        mode="close-tab"
        message={REMAINING_CHANGES_MESSAGE}
        onSaveAndClose={() => {}}
        onDiscard={() => {}}
        onCancel={onCancel}
      />,
    );

    const first = screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL });
    expect(first).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: DISCARD_LABEL })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toHaveFocus();

    rerender(
      <UnsavedChangesDialog
        open={false}
        mode="close-tab"
        message={REMAINING_CHANGES_MESSAGE}
        onSaveAndClose={() => {}}
        onDiscard={() => {}}
        onCancel={onCancel}
      />,
    );

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('focuses Cancel when opening a leave dialog', () => {
    render(
      <UnsavedChangesDialog
        open
        mode="leave"
        message={LEAVE_MESSAGE}
        onDiscard={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toHaveFocus();
    expect(screen.getByRole('button', { name: DISCARD_AND_LEAVE_LABEL })).not.toHaveFocus();
  });
});
