import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { EntryKind } from '@/contracts/file';
import { useUnsavedDialogState } from '@/features/editor/unsavedChangesGuard';
import { parseEntryBasename } from '@/features/files/entryNamePolicy';
import { cn } from '@/lib/utils';
import { getFileIcon, getFileIconColor } from './fileIcons';

export type FileMutationDialogKind = 'create-file' | 'create-folder' | 'rename' | 'delete';

export type FileMutationDialogsProps = {
  open: boolean;
  kind: FileMutationDialogKind | null;
  pending?: boolean;
  errorMessage?: string | null;
  currentName?: string;
  targetPath?: string;
  targetKind?: EntryKind;
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
  if (kind === 'create-folder') {
    return 'New folder';
  }
  if (kind === 'rename') {
    return 'Rename';
  }
  if (kind === 'delete') {
    return 'Delete';
  }
  return 'New file';
}

function entryBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function FileMutationDialogs({
  open,
  kind,
  pending = false,
  errorMessage = null,
  currentName = '',
  targetPath = '',
  targetKind = 'file',
  onSubmit,
  onCancel,
}: FileMutationDialogsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const unsavedOpen = useUnsavedDialogState().open;
  const visible = open && kind !== null && !unsavedOpen;
  const [name, setName] = useState(kind === 'rename' ? currentName : '');
  const [localError, setLocalError] = useState<string | null>(null);
  const alertMessage = localError ?? errorMessage;

  useEffect(() => {
    if (!visible) {
      return;
    }
    setName(kind === 'rename' ? currentName : '');
    setLocalError(null);
  }, [visible, kind, currentName]);

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
    if (kind === 'delete') {
      cancelRef.current?.focus();
    } else {
      const input = inputRef.current;
      input?.focus();
      if (kind === 'rename' && input !== null) {
        input.setSelectionRange(0, input.value.length);
      }
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
  }, [visible, kind]);

  if (!visible || kind === null) {
    return null;
  }

  const title = dialogTitle(kind);
  const describedBy = [
    kind === 'delete' ? 'file-mutation-delete-path' : undefined,
    kind === 'delete' ? 'file-mutation-delete-warning' : undefined,
    alertMessage !== null ? 'file-mutation-error' : undefined,
  ]
    .filter((id): id is string => id !== undefined)
    .join(' ');
  const Icon = getFileIcon(entryBasename(targetPath), targetKind === 'directory');
  const iconColor = getFileIconColor(entryBasename(targetPath), targetKind === 'directory');

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="file-mutation-title"
      aria-describedby={describedBy === '' ? undefined : describedBy}
      aria-modal="true"
      data-entry-kind={kind === 'delete' ? targetKind : undefined}
      className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 text-foreground shadow-lg [&::backdrop]:bg-black/40"
    >
      <h2 id="file-mutation-title" className="text-sm font-medium">
        {title}
      </h2>
      {kind === 'delete' ? (
        <div className="mt-3">
          <div className="flex items-start gap-2">
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconColor)} aria-hidden />
            <p id="file-mutation-delete-path" className="min-w-0 flex-1 break-all font-mono text-sm">
              {targetPath}
            </p>
          </div>
          <p id="file-mutation-delete-warning" className="mt-2 text-sm text-muted-foreground">
            This cannot be undone.
            {targetKind === 'directory'
              ? ' This folder may contain nested files and folders.'
              : null}
          </p>
          {alertMessage !== null ? (
            <p id="file-mutation-error" role="alert" className="mt-2 text-sm text-destructive">
              {alertMessage}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              className="h-8 min-w-20"
              onClick={() => {
                if (pending) {
                  return;
                }
                onSubmit(entryBasename(targetPath));
              }}
            >
              Delete
            </Button>
            <Button ref={cancelRef} type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
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
              {kind === 'rename' ? 'Rename' : 'Create'}
            </Button>
            <Button ref={cancelRef} type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
