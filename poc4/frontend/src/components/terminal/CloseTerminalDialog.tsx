import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Button } from '@/components/ui/button';

export const CLOSE_TERMINAL_TITLE = 'Close terminal session';
export const CLOSE_TERMINAL_MESSAGE =
  'This terminal session cannot be resumed after it is closed. The Maven run continues independently.';
export const CLOSE_TERMINAL_ERROR = 'Unable to close terminal session. Try again.';

export type CloseTerminalDialogProps = {
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
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

function canRestoreFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (element === null || element === undefined || !element.isConnected) return false;
  if (element.closest('[inert], [aria-hidden="true"]') !== null) return false;
  return !(element instanceof HTMLButtonElement && element.disabled);
}

export function CloseTerminalDialog({
  open,
  returnFocusRef,
  onConfirm,
  onCancel,
}: CloseTerminalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const openRef = useRef(open);
  const requestGenerationRef = useRef(0);
  const onCancelRef = useRef(onCancel);
  const onConfirmRef = useRef(onConfirm);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  openRef.current = open;
  onCancelRef.current = onCancel;
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    requestGenerationRef.current += 1;
    pendingRef.current = false;
    setPending(false);
    setErrorMessage(null);
  }, [open]);

  const cancelCurrentCycle = useCallback(() => {
    if (pendingRef.current) return;
    requestGenerationRef.current += 1;
    setPending(false);
    setErrorMessage(null);
    onCancelRef.current();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const root: HTMLElement = dialog;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackReturnTarget = returnFocusRef?.current;
    showNativeModal(dialog);
    cancelRef.current?.focus();

    function cancel(): void {
      cancelCurrentCycle();
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
      const returnTarget = canRestoreFocus(trigger) ? trigger : fallbackReturnTarget;
      if (canRestoreFocus(returnTarget)) returnTarget.focus();
    };
  }, [cancelCurrentCycle, open, returnFocusRef]);

  if (!open) return null;

  const handleConfirm = (): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const requestGeneration = requestGenerationRef.current;
    setPending(true);
    setErrorMessage(null);
    const settle = (failed: boolean): void => {
      if (
        !mountedRef.current ||
        !openRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) {
        return;
      }
      pendingRef.current = false;
      setPending(false);
      setErrorMessage(failed ? CLOSE_TERMINAL_ERROR : null);
    };
    let confirmation: void | Promise<void>;
    try {
      confirmation = onConfirmRef.current();
    } catch {
      settle(true);
      return;
    }
    void Promise.resolve(confirmation).then(
      () => settle(false),
      () => settle(true),
    );
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
      {errorMessage !== null ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          ref={cancelRef}
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={cancelCurrentCycle}
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
