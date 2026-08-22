import { useState } from 'react';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';
import type { FileBlockReason, FileMetadata } from '@/contracts/file';
import { formatFileSize } from '@/lib/languageForFile';
import { downloadFile } from './downloadFile';

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

function blockReasonMessage(reason: FileBlockReason): string {
  if (reason === 'BINARY_FILE') {
    return 'This file is binary and cannot be previewed';
  }
  if (reason === 'FILE_TOO_LARGE') {
    return 'This file is too large to preview';
  }
  return 'This file is not UTF-8 encoded and cannot be previewed';
}

export function BlockedFileView({
  projectId,
  metadata,
}: {
  projectId: string;
  metadata: FileMetadata;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = metadata.blockReason;

  async function runDownload(): Promise<void> {
    setDownloading(true);
    setError(null);
    try {
      await downloadFile(projectId, metadata.path, metadata.name);
    } catch (caught) {
      setError(isNetworkError(caught) ? 'Network request failed' : 'Unable to download file');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-4">
      <p className="text-sm font-medium">{metadata.name}</p>
      <p className="text-sm text-muted-foreground">{metadata.mediaType}</p>
      <p className="text-sm text-muted-foreground">{formatFileSize(metadata.sizeBytes)}</p>
      {reason !== null ? <p className="text-sm">{blockReasonMessage(reason)}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void runDownload()} disabled={downloading}>
          Download
        </Button>
      </div>
      {error !== null ? (
        <div className="flex flex-col items-start gap-2">
          <InlineAlert>{error}</InlineAlert>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runDownload()}
            disabled={downloading}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
