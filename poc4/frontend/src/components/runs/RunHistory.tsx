import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Spinner } from '@/components/ui/spinner';
import type { RunId, RunSummary } from '@/contracts/run';
import { cn } from '@/lib/utils';
import { runStateLabels, formatLabDate } from '@/components/ui/labPresentation';

export type RunHistoryProps = {
  items: readonly RunSummary[];
  selectedRunId: RunId | null;
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onSelect: (runId: RunId) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

export function RunHistory({
  items,
  selectedRunId,
  isPending,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onSelect,
  onLoadMore,
  onRetry,
}: RunHistoryProps) {
  return (
    <aside
      aria-label="Recent runs"
      className="lab-run-history flex shrink-0 flex-col overflow-hidden border-r"
    >
      <h2 className="lab-run-history-heading">运行历史 / HISTORY</h2>
      {isPending && items.length === 0 ? (
        <div role="status" aria-label="Loading recent runs" className="flex justify-center p-3">
          <Spinner />
        </div>
      ) : null}
      {isError ? (
        <div className="flex flex-col items-start gap-2 p-2">
          <InlineAlert>无法加载运行历史</InlineAlert>
          <button
            type="button"
            className="h-8 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetry}
            aria-label="Retry loading run history"
          >
            重试加载运行历史
          </button>
        </div>
      ) : null}
      {!isPending && !isError && items.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground"><p>暂无运行记录</p><p className="lab-machine-state mt-2">No recent runs</p></div>
      ) : null}
      {items.length > 0 ? (
        <ul role="list" aria-label="Recent runs" className="min-h-0 flex-1 overflow-auto py-1">
          {items.map((item) => {
            const selected = item.id === selectedRunId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-run-id={item.id}
                  aria-label={`${item.createdAt} ${item.state}`}
                  aria-current={selected ? 'true' : undefined}
                  title={`${item.createdAt} ${item.state}`}
                  className={cn(
                    'flex w-full flex-col items-start truncate px-2 py-1 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    selected ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                  onClick={() => {
                    onSelect(item.id);
                  }}
                >
                  <span className="w-full truncate">{runStateLabels[item.state]}</span>
                  <span className="w-full truncate text-xs text-muted-foreground">{formatLabDate(item.createdAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hasNextPage ? (
        <button
          type="button"
          className="h-8 shrink-0 border-t px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-64"
          disabled={isFetchingNextPage}
          aria-label="Load more"
          onClick={onLoadMore}
        >
          {isFetchingNextPage ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </aside>
  );
}
