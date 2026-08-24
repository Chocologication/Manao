import { useLayoutEffect, useState, type KeyboardEvent } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { FileMetadata, ProjectRelativePath } from '@/contracts/file';
import type { WorkspaceBuffer } from '@/features/editor/editorTypes';
import { formatFileSize } from '@/lib/languageForFile';
import { ensureWorkspaceBuffer, replacePlainTextContent } from './editorSaveCommand';

function currentPlainTextBuffer(
  projectId: string,
  path: ProjectRelativePath,
): WorkspaceBuffer | null {
  const existing = workspaceBufferRegistry.get(projectId, path);
  return existing?.kind === 'plain-text' ? existing : null;
}

export function PlainTextEditor({
  projectId,
  path,
  metadata,
  content,
  readOnly,
  onSave,
}: {
  projectId: string;
  path: ProjectRelativePath;
  metadata: FileMetadata;
  content: string;
  readOnly: boolean;
  onSave: () => void;
}) {
  const [buffer, setBuffer] = useState(() => currentPlainTextBuffer(projectId, path));
  const current = buffer !== null && buffer.path === path ? buffer : null;

  useLayoutEffect(() => {
    setBuffer(
      ensureWorkspaceBuffer({
        projectId,
        path,
        kind: 'plain-text',
        content,
      }),
    );
  }, [projectId, path, content]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (readOnly) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <span className="truncate font-medium">{metadata.name}</span>
        <span className="text-muted-foreground">{formatFileSize(metadata.sizeBytes)}</span>
        <span className="text-muted-foreground">Plain text</span>
      </div>
      {current !== null ? (
        <textarea
          key={`${projectId}:${path}:plain-text`}
          wrap="off"
          spellCheck={false}
          readOnly={readOnly}
          defaultValue={current.snapshot().content}
          aria-label={metadata.name}
          onChange={(event) => {
            if (readOnly) {
              return;
            }
            replacePlainTextContent(projectId, path, event.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="min-h-0 w-full flex-1 resize-none bg-background p-3 font-mono text-sm text-foreground outline-none"
        />
      ) : null}
    </div>
  );
}
