import { useMemo } from 'react';
import type { RunId } from '@/contracts/run';
import type { TerminalAuditEntry } from '@/contracts/terminal';
import type { JobTerminalPhase } from '@/features/terminal/JobTerminalController';
import { useTerminalAuditQuery } from '@/features/terminal/terminalQueries';

export type TerminalAuditViewProps = {
  items: readonly TerminalAuditEntry[];
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore(): void;
  onRetry(): void;
};

function safeCommandText(command: string): string {
  return [...command]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? '\uFFFD' : character;
    })
    .join('');
}

function formatAuditTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.000Z$/, 'Z');
}

function terminalAuditError(error: unknown): string {
  return error instanceof Error && /network request failed/i.test(error.message)
    ? 'Network request failed'
    : 'Unable to load terminal audit';
}

export function TerminalAuditQueryView({
  projectId,
  runId,
  phase,
}: {
  projectId: string;
  runId: RunId;
  phase: JobTerminalPhase;
}) {
  const query = useTerminalAuditQuery(projectId, runId, phase);
  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  return (
    <TerminalAuditView
      items={items}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage={query.isError ? terminalAuditError(query.error) : null}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onLoadMore={() => {
        void query.fetchNextPage();
      }}
      onRetry={() => {
        void query.refetch();
      }}
    />
  );
}

export function TerminalAuditView({
  items,
  isPending,
  isError,
  errorMessage,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
}: TerminalAuditViewProps) {
  if (isPending && items.length === 0) {
    return (
      <div
        role="status"
        aria-label="Loading terminal audit"
        className="flex h-full min-h-32 items-center justify-center px-3 text-sm text-muted-foreground"
      >
        Loading terminal audit
      </div>
    );
  }

  if (isError && items.length === 0) {
    return (
      <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-3">
        <p role="alert" className="text-sm text-destructive">
          {errorMessage ?? 'Unable to load terminal audit'}
        </p>
        <button
          type="button"
          className="h-8 rounded-md border px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={onRetry}
        >
          Retry terminal audit
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p
        role="status"
        aria-label="Terminal audit empty"
        className="flex h-full min-h-32 items-center justify-center px-3 text-sm text-muted-foreground"
      >
        No commands recorded for this run
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {isError ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
            {errorMessage ?? 'Unable to refresh terminal audit'}
          </p>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md border px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetry}
          >
            Retry terminal audit
          </button>
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <table aria-label="Terminal command audit" className="w-full min-w-[760px] table-fixed border-collapse text-left text-sm">
          <thead className="sticky top-0 z-[1] bg-background text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="w-[42%] px-3 py-2 font-medium">Command</th>
              <th scope="col" className="w-[12%] px-3 py-2 font-medium">State</th>
              <th scope="col" className="w-[18%] px-3 py-2 font-medium">Started</th>
              <th scope="col" className="w-[18%] px-3 py-2 font-medium">Finished</th>
              <th scope="col" className="w-[10%] px-3 py-2 font-medium">Exit code</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const command = safeCommandText(item.command);
              return (
                <tr key={item.id} className="border-b align-top last:border-b-0">
                  <td className="max-w-0 px-3 py-2">
                    <code
                      title={command}
                      aria-label={`Command: ${command}`}
                      className="block max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5"
                    >
                      {command}
                    </code>
                  </td>
                  <td className="px-3 py-2 font-medium">{item.state}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <time dateTime={item.startedAt}>{formatAuditTime(item.startedAt)}</time>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {item.finishedAt === null ? (
                      <span aria-label="Not finished">-</span>
                    ) : (
                      <time dateTime={item.finishedAt}>{formatAuditTime(item.finishedAt)}</time>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {item.exitCode === null ? <span aria-label="No exit code">-</span> : item.exitCode}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasNextPage ? (
        <button
          type="button"
          className="h-9 shrink-0 border-t px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-64"
          aria-label="Load more terminal audit"
          disabled={isFetchingNextPage}
          onClick={onLoadMore}
        >
          {isFetchingNextPage ? 'Loading more' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
