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
import { terminalThemes, useThemePreferences } from '@/features/preferences/themePreferences';
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
      return '运行正在启动';
    case 'RUNNING':
      return '可以打开终端';
    case 'STOPPING':
      return '运行正在停止';
    case 'RECOVERING':
      return '正在恢复运行状态';
    case 'SUCCEEDED':
      return '运行成功';
    case 'FAILED':
      return '运行失败';
    case 'CANCELLED':
      return '运行已停止';
    case 'TIMED_OUT':
      return '运行超时';
  }
}

function terminalStatusText(options: {
  authorityLoading: boolean;
  authorityError: string | null;
  run: JobTerminalRunAuthority | null;
  snapshot: JobTerminalSnapshot;
}): string {
  if (options.authorityLoading) return '正在读取运行状态';
  if (options.authorityError !== null) return '运行状态暂不可用';
  if (options.run === null) return '当前没有运行中的任务';
  if (options.run.state !== 'RUNNING') return runStateText(options.run.state);
  switch (options.snapshot.phase) {
    case 'unavailable':
    case 'available':
      return '可以打开终端';
    case 'creating':
      return '正在创建会话';
    case 'connecting':
      return '正在连接';
    case 'ready':
      return '已就绪';
    case 'paused':
      return '已暂停输入';
    case 'closing':
      return '正在关闭';
    case 'closed':
      return '已关闭';
    case 'exited':
      return '已退出';
    case 'error':
      return '终端异常';
  }
}

function terminalFailureText(failure: JobTerminalSnapshot['failure']): string {
  if (failure === 'input-overflow') {
    return '输入队列已满，会话已关闭，部分输入可能已经发送。';
  }
  if (failure === 'terminal-not-available') {
    return '终端已不可用，正在重新核对运行状态。';
  }
  if (failure === 'terminal-session-already-active') {
    return '已有终端会话，请等待原会话结束后再重试。';
  }
  return '终端会话异常，请打开新会话重试。';
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
  const theme = useThemePreferences((state) => state.theme);
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
      aria-label="运行终端"
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
          aria-label="终端会话错误"
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
            'absolute inset-0 min-h-0 min-w-0 overflow-hidden bg-background',
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
              theme={terminalThemes[theme]}
              onOpenChange={setSearchOpen}
            />
          ) : null}
          {usesBlockingViewportStatus(snapshot.phase) ? (
            <p
              role="status"
              aria-label="终端显示状态"
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-sm text-muted-foreground"
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
              aria-label="命令记录暂不可用"
              className="flex h-full items-center justify-center px-3 text-sm text-muted-foreground"
            >
              暂无终端命令记录
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
