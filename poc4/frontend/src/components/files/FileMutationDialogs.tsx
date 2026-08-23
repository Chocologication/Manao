import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUnsavedDialogState } from '@/features/editor/unsavedChangesGuard';
import { parseEntryBasename } from '@/features/files/entryNamePolicy';

export type FileMutationDialogKind = 'create-file' | 'create-folder';

export type FileMutationDialogsProps = {
  open: boolean;
  kind: FileMutationDialogKind | null;
  pending?: boolean;
  errorMessage?: string | null;
  onSubmit: (basename: string) => void;
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
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])')];
}

function dialogTitle(kind: FileMutationDialogKind): string {
  return kind === 'create-folder' ? 'New folder' : 'New file';
}

export function FileMutationDialogs({
  open,
  kind,
  pending = false,
  errorMessage = null,
  onSubmit,
  onCancel,
}: FileMutationDialogsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const unsavedOpen = useUnsavedDialogState().open;
  const visible = open && kind !== null && !unsavedOpen;
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const alertMessage = localError ?? errorMessage;

  useEffect(() => {
    if (!visible) {
      return;
    }
    setName('');
    setLocalError(null);
  }, [visible, kind]);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const root: HTMLElement = dialog;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showNativeModal(dialog);
    inputRef.current?.focus();

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
  }, [visible]);

  if (!visible || kind === null) {
    return null;
  }

  const title = dialogTitle(kind);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="file-mutation-title"
      aria-describedby={alertMessage !== null ? 'file-mutation-error' : undefined}
      aria-modal="true"
      className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 text-foreground shadow-lg [&::backdrop]:bg-black/40"
    >
      <h2 id="file-mutation-title" className="text-sm font-medium">
        {title}
      </h2>
      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) {
            return;
          }
          try {
            const basename = parseEntryBasename(name);
            setLocalError(null);
            onSubmit(basename);
          } catch (error) {
            setLocalError(error instanceof Error ? error.message : 'Entry name required');
          }
        }}
      >
        <label htmlFor="file-mutation-name" className="text-sm">
          Name
        </label>
        <Input
          ref={inputRef}
          id="file-mutation-name"
          type="text"
          value={name}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          aria-invalid={alertMessage !== null}
          className="mt-1"
          onChange={(event) => {
            setName(event.target.value);
            setLocalError(null);
          }}
        />
        {alertMessage !== null ? (
          <p id="file-mutation-error" role="alert" className="mt-2 text-sm text-destructive">
            {alertMessage}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="submit" disabled={pending}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  );
}
