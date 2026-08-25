import '@xterm/xterm/css/xterm.css';
import './JobTerminalPanel.css';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  authSession,
  handleUnauthorized,
  registerTerminalRuntimeResource,
} from '@/app/appRuntime';
import type { RunState } from '@/contracts/run';
import { runKeys } from '@/features/runs/runQueries';
import {
  JobTerminalController,
  type JobTerminalAdapterPort,
  type JobTerminalRunAuthority,
  type JobTerminalSnapshot,
} from '@/features/terminal/JobTerminalController';
import { invalidateTerminalAudits } from '@/features/terminal/terminalQueries';
import {
  XtermTerminalAdapter,
  type XtermRenderer,
  type XtermSearchOptions,
  type XtermTerminalAdapterOptions,
} from '@/features/terminal/XtermTerminalAdapter';
import { cn } from '@/lib/utils';
import { CloseTerminalDialog } from './CloseTerminalDialog';
import { JobTerminalSearch } from './JobTerminalSearch';
import {
  resolveTerminalAuditRunId,
  type RetainedTerminalAuditRun,
} from './JobTerminalPanelState';
import { TerminalAuditQueryView } from './TerminalAuditView';
import {
  JobTerminalToolbar,
  type JobTerminalView,
} from './JobTerminalToolbar';

export type JobTerminalPanelController = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): JobTerminalSnapshot;
  setRun(run: JobTerminalRunAuthority | null): void;
  setActive(active: boolean): void;
  handlePageHide(persisted: boolean): void;
  open(element: HTMLElement): Promise<boolean>;
  close(): boolean;
  clear(): void;
  findNext(term: string, options?: XtermSearchOptions): boolean;
  findPrevious(term: string, options?: XtermSearchOptions): boolean;
  clearSearch(): void;
  focus(): void;
  dispose(): void;
};

export type JobTerminalPanelControllerFactoryOptions = {
  projectId: string;
  onRendererChange(renderer: XtermRenderer): void;
  invalidateAudits(projectId: string, runId: JobTerminalRunAuthority['id']): void | Promise<void>;
  invalidateRunAuthority(projectId: string): void | Promise<void>;
};

export type JobTerminalPanelControllerFactory = (
  options: JobTerminalPanelControllerFactoryOptions,
) => JobTerminalPanelController;

export type JobTerminalPanelProps = {
  projectId: string;
  active: boolean;
  authorityLoading: boolean;
  authorityError: string | null;
  run: JobTerminalRunAuthority | null;
  createController?: JobTerminalPanelControllerFactory;
};

const EMPTY_SNAPSHOT: JobTerminalSnapshot = {
  phase: 'unavailable',
  runId: null,
  failure: null,
};

function createDefaultController({
  projectId,
  onRendererChange,
  invalidateAudits: invalidate,
  invalidateRunAuthority,
}: JobTerminalPanelControllerFactoryOptions): JobTerminalPanelController {
  return new JobTerminalController({
    projectId,
    getAccessToken: () => authSession.getAccessToken(),
    onUnauthorized: handleUnauthorized,
    registerRuntimeResource: registerTerminalRuntimeResource,
    invalidateAudits: invalidate,
    invalidateRunAuthority,
    createAdapter: (options: XtermTerminalAdapterOptions): JobTerminalAdapterPort =>
      new XtermTerminalAdapter({ ...options, onRendererChange }),
  });
}

function runStateText(state: RunState): string {
  switch (state) {
    case 'STARTING':
      return 'Run starting';
    case 'RUNNING':
      return 'Ready to open';
    case 'STOPPING':
      return 'Run stopping';
    case 'RECOVERING':
      return 'Run recovering';
    case 'SUCCEEDED':
      return 'Run succeeded';
    case 'FAILED':
      return 'Run failed';
    case 'CANCELLED':
      return 'Run cancelled';
    case 'TIMED_OUT':
      return 'Run timed out';
  }
}

function terminalStatusText(options: {
  authorityLoading: boolean;
  authorityError: string | null;
  run: JobTerminalRunAuthority | null;
  snapshot: JobTerminalSnapshot;
}): string {
  if (options.authorityLoading) return 'Loading run authority';
  if (options.authorityError !== null) return 'Authority unavailable';
  if (options.run === null) return 'No active run';
  if (options.run.state !== 'RUNNING') return runStateText(options.run.state);
  switch (options.snapshot.phase) {
    case 'unavailable':
    case 'available':
      return 'Ready to open';
    case 'creating':
      return 'Creating session';
    case 'connecting':
      return 'Connecting';
    case 'ready':
      return 'Ready';
    case 'paused':
      return 'Input paused';
    case 'closing':
      return 'Closing';
    case 'closed':
      return 'Closed';
    case 'exited':
      return 'Exited';
    case 'error':
      return 'Terminal error';
  }
}

function terminalFailureText(failure: JobTerminalSnapshot['failure']): string {
  if (failure === 'input-overflow') {
    return 'Input queue overflow. The session closed; part of the input may already have been sent.';
  }
  if (failure === 'terminal-not-available') {
    return 'The terminal is no longer available. Run authority is being refreshed.';
  }
  if (failure === 'terminal-session-already-active') {
    return 'A terminal session is already active. The old session must end before an explicit retry.';
  }
  return 'Terminal session failed. Open a new session to retry.';
}

function isOpenable(phase: JobTerminalSnapshot['phase']): boolean {
  return ['available', 'closed', 'exited', 'error'].includes(phase);
}

function isCloseable(phase: JobTerminalSnapshot['phase']): boolean {
  return ['connecting', 'ready', 'paused'].includes(phase);
}

function isInteractiveXterm(phase: JobTerminalSnapshot['phase']): boolean {
  return phase === 'ready' || phase === 'paused';
}

function usesBlockingViewportStatus(phase: JobTerminalSnapshot['phase']): boolean {
  return ['unavailable', 'available', 'creating', 'connecting'].includes(phase);
}

function subscribeToNothing(): () => void {
  return () => {};
}

function getEmptySnapshot(): JobTerminalSnapshot {
  return EMPTY_SNAPSHOT;
}

export function JobTerminalPanel({
  projectId,
  active,
  authorityLoading,
  authorityError,
  run,
  createController = createDefaultController,
}: JobTerminalPanelProps) {
  const queryClient = useQueryClient();
  const [controller, setController] = useState<JobTerminalPanelController | null>(null);
  const [renderer, setRenderer] = useState<XtermRenderer>('dom');
  const [activeView, setActiveView] = useState<JobTerminalView>('session');
  const [auditCreated, setAuditCreated] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [openPending, setOpenPending] = useState(false);
  const [lastAuditRun, setLastAuditRun] = useState<RetainedTerminalAuditRun | null>(() =>
    run === null ? null : { projectId, runId: run.id },
  );
  const openPendingRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sessionTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const next = createController({
      projectId,
      onRendererChange: setRenderer,
      invalidateAudits: (invalidateProjectId, runId) =>
        invalidateTerminalAudits(queryClient, invalidateProjectId, runId),
      invalidateRunAuthority: (invalidateProjectId) => queryClient.invalidateQueries({
        queryKey: runKeys.active(invalidateProjectId),
        exact: true,
        refetchType: 'active',
      }),
    });
    setController(next);
    return () => {
      next.dispose();
    };
  }, [createController, projectId, queryClient]);

  useEffect(() => {
    if (controller === null) return undefined;
    const handlePageHide = (event: PageTransitionEvent) => {
      controller.handlePageHide(event.persisted);
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [controller]);

  useLayoutEffect(() => {
    controller?.setRun(run);
  }, [controller, run]);

  useLayoutEffect(() => {
    controller?.setActive(active);
  }, [active, controller]);

  useEffect(() => {
    setLastAuditRun((current) => {
      if (run !== null) return { projectId, runId: run.id };
      return current?.projectId === projectId ? current : null;
    });
  }, [projectId, run]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeToNothing,
    controller?.getSnapshot ?? getEmptySnapshot,
    controller?.getSnapshot ?? getEmptySnapshot,
  );

  const statusText = terminalStatusText({
    authorityLoading,
    authorityError,
    run,
    snapshot,
  });
  const canOpen =
    active &&
    !authorityLoading &&
    authorityError === null &&
    run?.state === 'RUNNING' &&
    isOpenable(snapshot.phase);
  const canClose = active && isCloseable(snapshot.phase);
  const canUseXtermTools =
    active && activeView === 'session' && isInteractiveXterm(snapshot.phase);
  const auditRunId = resolveTerminalAuditRunId(projectId, run, lastAuditRun);

  useEffect(() => {
    if (active && activeView === 'session' && snapshot.phase === 'ready') {
      controller?.focus();
    }
  }, [active, activeView, controller, snapshot.phase]);

  useEffect(() => {
    if (!canClose) setCloseDialogOpen(false);
  }, [canClose]);

  const handleOpen = useCallback(() => {
    if (!canOpen || controller === null || viewportRef.current === null || openPendingRef.current) {
      return;
    }
    openPendingRef.current = true;
    setRenderer('dom');
    setOpenPending(true);
    setActiveView('session');
    void controller.open(viewportRef.current).finally(() => {
      openPendingRef.current = false;
      setOpenPending(false);
    });
  }, [canOpen, controller]);

  const handleViewChange = useCallback((view: JobTerminalView) => {
    if (view === 'audit') setAuditCreated(true);
    setActiveView(view);
  }, []);

  return (
    <section
      role="region"
      aria-label="Job terminal"
      aria-hidden={!active}
      inert={!active ? true : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      <JobTerminalToolbar
        phase={snapshot.phase}
        statusText={statusText}
        renderer={renderer}
        sessionTabRef={sessionTabRef}
        activeView={activeView}
        canOpen={canOpen}
        openPending={openPending}
        canClose={canClose}
        canUseXtermTools={canUseXtermTools}
        onOpen={handleOpen}
        onRequestClose={() => setCloseDialogOpen(true)}
        onClear={() => controller?.clear()}
        onSearch={() => setSearchOpen(true)}
        onViewChange={handleViewChange}
      />
      {authorityError !== null ? (
        <p role="alert" className="shrink-0 border-b px-3 py-2 text-sm text-destructive">
          {authorityError}
        </p>
      ) : null}
      {snapshot.phase === 'error' ? (
        <p
          role="alert"
          aria-label="Terminal session error"
          className="shrink-0 border-b px-3 py-1.5 text-sm text-destructive"
        >
          {terminalFailureText(snapshot.failure)}
        </p>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          id="job-terminal-session-view"
          role="tabpanel"
          aria-labelledby="job-terminal-session-tab"
          aria-hidden={activeView !== 'session'}
          inert={activeView !== 'session' ? true : undefined}
          className={cn(
            'absolute inset-0 min-h-0 min-w-0 overflow-hidden bg-[#1e1e1e]',
            activeView !== 'session' && 'invisible pointer-events-none',
          )}
        >
          <div
            ref={viewportRef}
            data-testid="job-terminal-viewport"
            className="job-terminal-viewport h-full min-h-0 w-full min-w-0 overflow-hidden"
          />
          {controller !== null ? (
            <JobTerminalSearch
              active={canUseXtermTools}
              isOpen={searchOpen}
              terminal={controller}
              onOpenChange={setSearchOpen}
            />
          ) : null}
          {usesBlockingViewportStatus(snapshot.phase) ? (
            <p
              role="status"
              aria-label="Terminal viewport state"
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-sm text-[#b8b8b8]"
            >
              {statusText}
            </p>
          ) : null}
        </div>
        <div
          id="job-terminal-audit-view"
          role="tabpanel"
          aria-labelledby="job-terminal-audit-tab"
          aria-hidden={activeView !== 'audit'}
          inert={activeView !== 'audit' ? true : undefined}
          className={cn(
            'absolute inset-0 min-h-0 min-w-0 overflow-hidden',
            activeView !== 'audit' && 'invisible pointer-events-none',
          )}
        >
          {auditCreated && auditRunId !== null ? (
            <TerminalAuditQueryView
              projectId={projectId}
              runId={auditRunId}
              phase={snapshot.phase}
            />
          ) : auditCreated ? (
            <p
              role="status"
              aria-label="Terminal audit unavailable"
              className="flex h-full items-center justify-center px-3 text-sm text-muted-foreground"
            >
              No terminal session audit available
            </p>
          ) : null}
        </div>
      </div>
      <CloseTerminalDialog
        open={closeDialogOpen}
        returnFocusRef={sessionTabRef}
        onCancel={() => setCloseDialogOpen(false)}
        onConfirm={() => {
          controller?.close();
          setCloseDialogOpen(false);
        }}
      />
    </section>
  );
}

export default JobTerminalPanel;
