import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export const CLOSE_TERMINAL_TITLE = 'Close terminal session';
export const CLOSE_TERMINAL_MESSAGE =
  'This terminal session cannot be resumed after it is closed. The Maven run continues independently.';

export type CloseTerminalDialogProps = {
  open: boolean;
  onConfirm(): void | Promise<void>;
  onCancel(): void;
};

function showNativeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
    return;
  }
  dialog.setAttribute('open', '');
}

function closeNativeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') {
    if (dialog.open) dialog.close();
    return;
  }
  dialog.removeAttribute('open');
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href]')];
}

export function CloseTerminalDialog({
  open,
  onConfirm,
  onCancel,
}: CloseTerminalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const onCancelRef = useRef(onCancel);
  const onConfirmRef = useRef(onConfirm);
  const [pending, setPending] = useState(false);
  onCancelRef.current = onCancel;
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const root: HTMLElement = dialog;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showNativeModal(dialog);
    cancelRef.current?.focus();

    function cancel(): void {
      if (!pendingRef.current) onCancelRef.current();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== 'Tab') return;
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
      cancel();
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

  if (!open) return null;

  const handleConfirm = (): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    let confirmation: void | Promise<void>;
    try {
      confirmation = onConfirmRef.current();
    } catch {
      pendingRef.current = false;
      setPending(false);
      return;
    }
    void Promise.resolve(confirmation).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="close-terminal-title"
      aria-describedby="close-terminal-message"
      aria-modal="true"
      className="fixed top-1/2 left-1/2 z-50 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background p-4 text-foreground shadow-lg [&::backdrop]:bg-black/50"
    >
      <h2 id="close-terminal-title" className="text-sm font-medium">
        {CLOSE_TERMINAL_TITLE}
      </h2>
      <p id="close-terminal-message" className="mt-2 text-sm text-muted-foreground">
        {CLOSE_TERMINAL_MESSAGE}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          ref={cancelRef}
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => onCancelRef.current()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          aria-busy={pending}
          disabled={pending}
          onClick={handleConfirm}
        >
          Close session
        </Button>
      </div>
    </dialog>
  );
}
