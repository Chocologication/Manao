import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Clock3, Play, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Spinner } from '@/components/ui/spinner';
import { runStateLabels, formatLabDate } from '@/components/ui/labPresentation';
import { flattenRunHistoryPages, useRunHistoryQuery } from '@/features/runs/runQueries';
import type { RunSummary } from '@/contracts/run';

const MAX_SEEN_RUNS = 100;

function activityStorageKey(userId: string, projectId: string): string {
  return `manao.activity-read.v1:${userId}:${projectId}`;
}

function readSeenRunIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_SEEN_RUNS)
      : [];
  } catch {
    return [];
  }
}

function writeSeenRunIds(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids.slice(0, MAX_SEEN_RUNS)));
  } catch {
    // The activity list remains usable when browser storage is unavailable.
  }
}

function RunActivity({ run }: { run: RunSummary }) {
  const Icon = run.state === 'SUCCEEDED' ? CircleCheck : run.state === 'FAILED' ? CircleAlert : Clock3;
  return (
    <li className="lab-activity-item" data-state={run.state}>
      <Icon aria-hidden="true" className="lab-activity-icon" />
      <div className="lab-activity-copy">
        <p>{runStateLabels[run.state]}</p>
        <span>{run.policy.command}</span>
        <code title={run.id}>{run.id}</code>
      </div>
      <time dateTime={run.createdAt}>{formatLabDate(run.createdAt)}</time>
    </li>
  );
}

export function ActivityCenter({
  projectId,
  userId,
  onOpenRuns,
}: {
  projectId: string;
  userId: string;
  onOpenRuns: () => void;
}) {
  const storageKey = activityStorageKey(userId, projectId);
  const [open, setOpen] = useState(false);
  const [seenRunIds, setSeenRunIds] = useState(() => readSeenRunIds(storageKey));
  const clearedStorageKey = `${storageKey}:cleared-through`;
  const [clearedThrough, setClearedThrough] = useState(() => {
    try {
      const value = Number(window.localStorage.getItem(clearedStorageKey) ?? '0');
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch { return 0; }
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRunHistoryQuery(projectId);
  const runs = useMemo(
    () => flattenRunHistoryPages(history.data?.pages ?? []),
    [history.data],
  );
  const seen = useMemo(() => new Set(seenRunIds), [seenRunIds]);
  const activities = runs.filter((run) => Date.parse(run.createdAt) > clearedThrough);
  const unreadCount = activities.slice(0, MAX_SEEN_RUNS).reduce((count, run) => count + (seen.has(run.id) ? 0 : 1), 0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);

  function markAllRead(): void {
    const next = [...new Set([...runs.map((run) => run.id), ...seenRunIds])].slice(0, MAX_SEEN_RUNS);
    setSeenRunIds(next);
    writeSeenRunIds(storageKey, next);
  }

  function clearActivities(): void {
    const latest = Math.max(clearedThrough, ...runs.map((run) => Date.parse(run.createdAt)).filter(Number.isFinite));
    setClearedThrough(latest);
    markAllRead();
    try { window.localStorage.setItem(clearedStorageKey, String(latest)); } catch { /* Storage may be unavailable. */ }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="lab-activity-trigger"
        aria-label={unreadCount > 0 ? `运行活动，有 ${unreadCount} 条未读` : '运行活动'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="运行活动"
        onClick={() => setOpen(true)}
      >
        <Bell aria-hidden="true" />
        {unreadCount > 0 ? <span className="lab-activity-count">{unreadCount > 9 ? '9+' : unreadCount}</span> : null}
      </Button>
      <dialog
        ref={dialog}
        className="lab-activity-dialog"
        aria-labelledby="lab-activity-title"
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      >
        <header className="lab-activity-header">
          <div>
            <p className="lab-eyebrow">RUN HISTORY</p>
            <h2 id="lab-activity-title">运行活动</h2>
            <p>来自当前项目的真实运行记录</p>
          </div>
          <div className="lab-activity-actions">
            <Button type="button" variant="ghost" size="icon" aria-label="清空本地运行通知" title="清空通知" disabled={activities.length === 0} onClick={clearActivities}><Trash2 aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="关闭运行活动" onClick={() => setOpen(false)}>
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>
        {unreadCount > 0 ? (
          <div className="lab-activity-toolbar">
            <span>{unreadCount} 条未读运行记录</span>
            <Button type="button" variant="ghost" size="sm" onClick={markAllRead}>
              <CheckCheck aria-hidden="true" />全部标为已读
            </Button>
          </div>
        ) : null}
        <div className="lab-activity-list-wrap">
          {history.isPending && runs.length === 0 ? (
            <div role="status" className="lab-activity-state"><Spinner />正在读取运行记录</div>
          ) : history.isError && runs.length === 0 ? (
            <div className="lab-activity-state lab-activity-error">
              <InlineAlert>无法读取运行活动</InlineAlert>
              <Button type="button" variant="outline" onClick={() => void history.refetch()}>重试</Button>
            </div>
          ) : activities.length === 0 ? (
            <div className="lab-activity-state">{runs.length === 0 ? '尚无运行记录' : '暂无新的运行活动'}</div>
          ) : (
            <ol className="lab-activity-list">
              {activities.map((run) => <RunActivity key={run.id} run={run} />)}
            </ol>
          )}
          {history.isError && runs.length > 0 ? <InlineAlert>运行活动更新失败，显示缓存记录</InlineAlert> : null}
          {history.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              className="lab-activity-more"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? '正在加载…' : '加载更早记录'}
            </Button>
          ) : null}
        </div>
        <footer className="lab-activity-footer">
          <span>清空通知不会删除运行历史</span>
          <Button type="button" variant="outline" onClick={() => { setOpen(false); onOpenRuns(); }}>
            <Play aria-hidden="true" />打开运行面板
          </Button>
        </footer>
      </dialog>
    </>
  );
}
