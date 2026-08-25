import { CircleX, Eraser, Search, SquareTerminal } from 'lucide-react';
import type { RefObject } from 'react';
import type { JobTerminalPhase } from '@/features/terminal/JobTerminalController';
import type { XtermRenderer } from '@/features/terminal/XtermTerminalAdapter';
import { cn } from '@/lib/utils';

export type JobTerminalView = 'session' | 'audit';

const ICON_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-64';

const VIEW_TAB_CLASS =
  'inline-flex h-8 shrink-0 items-center border-b-2 px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export type JobTerminalToolbarProps = {
  phase: JobTerminalPhase;
  statusText: string;
  renderer: XtermRenderer;
  sessionTabRef: RefObject<HTMLButtonElement | null>;
  activeView: JobTerminalView;
  canOpen: boolean;
  openPending: boolean;
  canClose: boolean;
  canUseXtermTools: boolean;
  onOpen(): void;
  onRequestClose(): void;
  onClear(): void;
  onSearch(): void;
  onViewChange(view: JobTerminalView): void;
};

export function JobTerminalToolbar({
  phase,
  statusText,
  renderer,
  sessionTabRef,
  activeView,
  canOpen,
  openPending,
  canClose,
  canUseXtermTools,
  onOpen,
  onRequestClose,
  onClear,
  onSearch,
  onViewChange,
}: JobTerminalToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 min-w-0 items-center gap-1 border-b px-2">
      <div role="toolbar" aria-label="Terminal controls" className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          title="Open terminal"
          aria-label="Open terminal"
          aria-busy={openPending}
          className={ICON_BUTTON_CLASS}
          disabled={!canOpen || openPending}
          onClick={onOpen}
        >
          <SquareTerminal className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="Close terminal"
          aria-label="Close terminal"
          className={ICON_BUTTON_CLASS}
          disabled={!canClose}
          onClick={onRequestClose}
        >
          <CircleX className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="Clear terminal"
          aria-label="Clear terminal"
          className={ICON_BUTTON_CLASS}
          disabled={!canUseXtermTools}
          onClick={onClear}
        >
          <Eraser className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="Search terminal"
          aria-label="Search terminal"
          className={ICON_BUTTON_CLASS}
          disabled={!canUseXtermTools}
          onClick={onSearch}
        >
          <Search className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div role="tablist" aria-label="Terminal views" className="ml-2 flex h-full shrink-0 items-center gap-1">
        {(['session', 'audit'] as const).map((view) => (
          <button
            key={view}
            type="button"
            ref={view === 'session' ? sessionTabRef : undefined}
            role="tab"
            id={`job-terminal-${view}-tab`}
            aria-controls={`job-terminal-${view}-view`}
            aria-selected={activeView === view}
            className={cn(
              VIEW_TAB_CLASS,
              activeView === view
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onViewChange(view)}
          >
            {view === 'session' ? 'Session' : 'Audit'}
          </button>
        ))}
      </div>

      <div
        role="status"
        aria-label="Terminal state"
        aria-live="polite"
        data-phase={phase}
        className="ml-auto flex w-36 shrink-0 items-center justify-end truncate text-sm"
      >
        {statusText}
      </div>
      <div
        role="status"
        aria-label="Terminal renderer"
        aria-live="polite"
        className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground"
      >
        {renderer === 'webgl' ? 'WebGL' : 'DOM fallback'}
      </div>
    </div>
  );
}
