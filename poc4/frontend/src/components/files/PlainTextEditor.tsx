import { useLayoutEffect, type KeyboardEvent } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { FileMetadata, ProjectRelativePath } from '@/contracts/file';
import { formatFileSize } from '@/lib/languageForFile';
import { ensureWorkspaceBuffer, replacePlainTextContent } from './editorSaveCommand';

export function PlainTextEditor({
  projectId,
  path,
  metadata,
  content,
  onSave,
}: {
  projectId: string;
  path: ProjectRelativePath;
  metadata: FileMetadata;
  content: string;
  onSave: () => void;
}) {
  useLayoutEffect(() => {
    ensureWorkspaceBuffer({
      projectId,
      path,
      kind: 'plain-text',
      content,
    });
  }, [projectId, path, content]);

  const snapshot = workspaceBufferRegistry.get(projectId, path)?.snapshot().content ?? content;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
      <textarea
        wrap="off"
        spellCheck={false}
        defaultValue={snapshot}
        aria-label={metadata.name}
        onChange={(event) => {
          replacePlainTextContent(projectId, path, event.target.value);
        }}
        onKeyDown={handleKeyDown}
        className="min-h-0 w-full flex-1 resize-none bg-background p-3 font-mono text-sm text-foreground outline-none"
      />
    </div>
  );
}
