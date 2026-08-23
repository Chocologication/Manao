import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

export const STOP_DIALOG_TITLE = 'Stop run';
export const STOP_DIALOG_MESSAGE =
  'Stop the current Maven run? The server remains the authority for run state.';
export const STOP_CONFIRM_LABEL = 'Stop';
export const STOP_CANCEL_LABEL = 'Cancel';

export type StopRunDialogProps = {
  open: boolean;
  pending?: boolean;
  onConfirm: () => void;
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

export function StopRunDialog({ open, pending = false, onConfirm, onCancel }: StopRunDialogProps) {
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
    cancelRef.current?.focus();

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
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="stop-run-title"
      aria-describedby="stop-run-message"
      aria-modal="true"
      className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 text-foreground shadow-lg [&::backdrop]:bg-black/40"
    >
      <h2 id="stop-run-title" className="text-sm font-medium">
        {STOP_DIALOG_TITLE}
      </h2>
      <p id="stop-run-message" className="mt-2 text-sm text-muted-foreground">
        {STOP_DIALOG_MESSAGE}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {STOP_CANCEL_LABEL}
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
          {STOP_CONFIRM_LABEL}
        </Button>
      </div>
    </dialog>
  );
}
