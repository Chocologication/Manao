import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';

export function DeleteProjectDialog({ project, pending, onConfirm, onCancel }: {
  project: ProjectSummary;
  pending: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby="delete-project-title"
      aria-describedby="delete-project-description"
      className="fixed inset-0 m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => { event.preventDefault(); if (!pending) onCancel(); }}
    >
      <h2 id="delete-project-title" className="text-lg font-medium">Delete project?</h2>
      <p className="mt-3 break-words text-sm font-medium">{project.name}</p>
      <p id="delete-project-description" className="mt-2 text-sm text-muted-foreground">
        Files, run history and logs will be permanently removed. This cannot be undone.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onCancel} autoFocus>Cancel</Button>
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {pending ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </div>
    </dialog>
  );
}
