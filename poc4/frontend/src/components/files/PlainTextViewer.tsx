import type { FileMetadata } from '@/contracts/file';
import { formatFileSize } from '@/lib/languageForFile';

export function PlainTextViewer({
  metadata,
  content,
}: {
  metadata: FileMetadata;
  content: string;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <span className="truncate font-medium">{metadata.name}</span>
        <span className="text-muted-foreground">{formatFileSize(metadata.sizeBytes)}</span>
        <span className="text-muted-foreground">Plain text</span>
      </div>
      <textarea
        readOnly
        wrap="off"
        spellCheck={false}
        value={content}
        aria-label={metadata.name}
        className="min-h-0 w-full flex-1 resize-none bg-background p-3 font-mono text-sm text-foreground outline-none"
      />
    </div>
  );
}
