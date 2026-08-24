import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import type { RunState, RunSummary } from '@/contracts/run';

export const RUN_ICON_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-64';

export type RunToolbarProps = {
  run: RunSummary | null;
  statusText: string;
  nowMs: number;
  canStart: boolean;
  startTitle: string;
  startPending: boolean;
  canStop: boolean;
  stopWaiting: boolean;
  stopPending: boolean;
  authorityError: string | null;
  startError: string | null;
  stopError: string | null;
  reloadFailed: boolean;
  onStart: () => void;
  onStop: () => void;
  onRetryAuthority: () => void;
  onRetryReload: () => void;
};

export function formatRunElapsed(fromIso: string, toMs: number): string {
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) {
    return '0:00';
  }
  const elapsed = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stateIcon(state: RunState | null, loading: boolean): ReactNode {
  const className = 'h-4 w-4';
  if (loading) {
    return <Loader2 className={className} aria-hidden />;
  }
  if (state === 'STARTING') {
    return <Loader2 className={className} aria-hidden />;
  }
  if (state === 'RUNNING') {
    return <Play className={className} aria-hidden />;
  }
  if (state === 'STOPPING') {
    return <Square className={className} aria-hidden />;
  }
  if (state === 'RECOVERING') {
    return <RefreshCw className={className} aria-hidden />;
  }
  if (state === 'SUCCEEDED') {
    return <CircleCheck className={className} aria-hidden />;
  }
  if (state === 'FAILED') {
    return <CircleX className={className} aria-hidden />;
  }
  if (state === 'CANCELLED') {
    return <Ban className={className} aria-hidden />;
  }
  if (state === 'TIMED_OUT') {
    return <Clock className={className} aria-hidden />;
  }
  return <CircleAlert className={className} aria-hidden />;
}

function clockLabel(run: RunSummary | null, nowMs: number): string | null {
  if (run === null) {
    return null;
  }
  if (run.finishedAt !== null) {
    return `Finished ${run.finishedAt}`;
  }
  const origin = run.startedAt ?? run.createdAt;
  return `Elapsed ${formatRunElapsed(origin, nowMs)}`;
}

export function RunToolbar({
  run,
  statusText,
  nowMs,
  canStart,
  startTitle,
  startPending,
  canStop,
  stopWaiting,
  stopPending,
  authorityError,
  startError,
  stopError,
  reloadFailed,
  onStart,
  onStop,
  onRetryAuthority,
  onRetryReload,
}: RunToolbarProps) {
  const command = run?.policy.command ?? 'mvn clean test';
  const timeoutSeconds = run?.policy.timeoutSeconds ?? 1800;
  const clock = clockLabel(run, nowMs);
  const loading = /loading/i.test(statusText);
  const stopTitle = stopWaiting ? 'Waiting for the server' : 'Stop run';

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-2 py-1">
      <div role="toolbar" aria-label="Run controls" className="flex h-8 min-w-0 items-center gap-2">
        <button
          type="button"
          title={startTitle}
          aria-label="Start run"
          aria-busy={startPending}
          className={RUN_ICON_BUTTON_CLASS}
          disabled={!canStart || startPending}
          onClick={onStart}
        >
          <Play className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title={stopTitle}
          aria-label="Stop run"
          aria-busy={stopPending}
          className={RUN_ICON_BUTTON_CLASS}
          disabled={!canStop || stopPending}
          onClick={onStop}
        >
          <Square className="h-4 w-4" aria-hidden />
        </button>
        <div role="status" aria-label="Run state" className="flex min-w-0 items-center gap-1.5 text-sm">
          {stateIcon(run?.state ?? null, loading)}
          <span className="truncate">{statusText}</span>
        </div>
        <span className="font-mono truncate text-sm">{command}</span>
        {clock !== null ? (
          <span className="shrink-0 text-sm text-muted-foreground">{clock}</span>
        ) : null}
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          Java 17 · Maven 3 · timeout {timeoutSeconds}s
        </span>
      </div>
      {authorityError !== null ? (
        <div className="flex items-center gap-2 pb-1">
          <InlineAlert>{authorityError}</InlineAlert>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetryAuthority}
          >
            Retry loading run authority
          </button>
        </div>
      ) : null}
      {reloadFailed ? (
        <div className="flex items-center gap-2 pb-1">
          <InlineAlert>Workspace reload failed</InlineAlert>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetryReload}
          >
            Retry workspace reload
          </button>
        </div>
      ) : null}
      {startError !== null ? <InlineAlert>{startError}</InlineAlert> : null}
      {stopError !== null ? <InlineAlert>{stopError}</InlineAlert> : null}
    </div>
  );
}
