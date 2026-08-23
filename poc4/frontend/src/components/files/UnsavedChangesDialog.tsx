import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  CANCEL_LABEL,
  DIALOG_TITLE,
  DISCARD_AND_LEAVE_LABEL,
  DISCARD_LABEL,
  SAVE_AND_CLOSE_LABEL,
  type UnsavedDialogMode,
} from '@/features/editor/unsavedChangesGuard';

export type UnsavedChangesDialogProps = {
  open: boolean;
  mode: UnsavedDialogMode;
  message: string;
  busy?: boolean;
  onSaveAndClose?: () => void;
  onDiscard: () => void;
  onCancel: () => void;
};

function showNativeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) {
      dialog.showModal();
    }
    return;
  }
  dialog.setAttribute('open', '');
}

function closeNativeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') {
    if (dialog.open) {
      dialog.close();
    }
    return;
  }
  dialog.removeAttribute('open');
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href]')];
}

export function UnsavedChangesDialog({
  open,
  mode,
  message,
  busy = false,
  onSaveAndClose,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const root: HTMLElement = dialog;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showNativeModal(dialog);
    if (mode === 'leave') {
      cancelRef.current?.focus();
    } else {
      focusableElements(root)[0]?.focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const nodes = focusableElements(root);
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onNativeCancel(event: Event): void {
      event.preventDefault();
      onCancelRef.current();
    }

    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('cancel', onNativeCancel);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.removeEventListener('cancel', onNativeCancel);
      closeNativeModal(dialog);
      trigger?.focus();
    };
  }, [open, mode]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-message"
      aria-modal="true"
      className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 text-foreground shadow-lg [&::backdrop]:bg-black/40"
    >
      <h2 id="unsaved-changes-title" className="text-sm font-medium">
        {DIALOG_TITLE}
      </h2>
      <p id="unsaved-changes-message" className="mt-2 text-sm text-muted-foreground">
        {message}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {mode === 'close-tab' ? (
          <Button
            type="button"
            onClick={onSaveAndClose}
            disabled={busy || onSaveAndClose === undefined}
          >
            {SAVE_AND_CLOSE_LABEL}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={mode === 'leave' ? 'default' : 'outline'}
          onClick={onDiscard}
          disabled={busy}
        >
          {mode === 'leave' ? DISCARD_AND_LEAVE_LABEL : DISCARD_LABEL}
        </Button>
        <Button ref={cancelRef} type="button" variant="ghost" onClick={onCancel}>
          {CANCEL_LABEL}
        </Button>
      </div>
    </dialog>
  );
}
