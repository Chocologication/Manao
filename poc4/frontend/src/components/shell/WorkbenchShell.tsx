import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileCode, LogOut, Package, Play, SquareTerminal } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { Link } from 'react-router';
import { logout } from '@/app/appRuntime';
import { EditorWorkspace } from '@/components/files/EditorWorkspace';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { FileTree } from '@/components/files/FileTree';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { RunPanel } from '@/components/runs/RunPanel';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';
import { isPythonRuntimeTemplate } from '@/contracts/project';
import { readPythonDependencyOperationId } from '@/api/pythonDependencyApi';
import {
  PythonDependenciesPanel,
} from '@/features/dependencies/PythonDependenciesPanel';
import {
  PythonDependencyRecovery,
} from '@/features/dependencies/PythonDependencyRecovery';
import {
  dismissUnsavedDialog,
  LEAVE_MESSAGE,
  requestLogout,
  requestUnsavedDialog,
  useDirtyBeforeUnload,
  useUnsavedDialogState,
} from '@/features/editor/unsavedChangesGuard';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { WorkspaceFileReadsPaused } from '@/features/files/fileQueries';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  isWorkspaceEditable,
  useRunAuthorityCoordinator,
} from '@/features/runs/RunAuthorityCoordinator';
import { useActiveRunQuery } from '@/features/runs/runQueries';
import { reloadWorkspaceAfterTerminalRun } from '@/features/runs/workspaceReload';
import { cn } from '@/lib/utils';

const EDITOR_REGION_ID = 'workbench-editor';
const RUN_PANEL_ID = 'workbench-run-panel';
const DEPENDENCIES_PANEL_ID = 'workbench-dependencies-panel';
const TERMINAL_PANEL_ID = 'workbench-terminal-panel';

type WorkbenchPanel = 'file' | 'run' | 'dependencies' | 'terminal';

export function isExperimentalTerminalEnabled(value: string | undefined): boolean {
  return value === 'true';
}

const experimentalTerminalEnabled = isExperimentalTerminalEnabled(
  import.meta.env.VITE_ENABLE_EXPERIMENTAL_TERMINAL,
);

const LazyJobTerminalPanel = lazy(() => import('@/components/terminal/JobTerminalPanel'));

const panelTabClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

const panelSurfaceClassName =
  'absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden outline-none';

function authorityErrorMessage(error: unknown): string {
  if (error instanceof Error && /network request failed/i.test(error.message)) {
    return 'Network request failed';
  }
  return 'Unable to load run authority';
}

export function WorkbenchShell({ project }: { project: ProjectSummary }) {
  const [activePanel, setActivePanel] = useState<WorkbenchPanel>('file');
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const queryClient = useQueryClient();
  const coordinator = useRunAuthorityCoordinator(project.id);
  const { snapshot: authSnapshot } = useAuth();
  const userId = authSnapshot.status === 'authenticated' ? authSnapshot.user.id : '';
  const pythonWorkbench = isPythonRuntimeTemplate(project.runtime?.templateId);
  // Seeded from sessionStorage so a refresh keeps the unconfirmed operation reachable;
  // the panel reports a fresh lost response while the shell stays mounted.
  const [unconfirmedOperationId, setUnconfirmedOperationId] = useState<string | null>(() =>
    pythonWorkbench ? readPythonDependencyOperationId(userId, project.id) : null,
  );
  // A post-recovery reload failure is user-visible: the change is committed but the
  // surface may be stale until the reload succeeds. Nothing is unlocked by it.
  const [recoveryReloadFailed, setRecoveryReloadFailed] = useState(false);
  const reloadAfterRecovery = useCallback(() => {
    reloadWorkspaceAfterTerminalRun({ projectId: project.id, queryClient })
      .then(() => setRecoveryReloadFailed(false))
      .catch(() => setRecoveryReloadFailed(true));
  }, [project.id, queryClient]);
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const terminalAuthority = useSyncExternalStore(
    coordinator.subscribeTerminalAuthority,
    coordinator.getTerminalAuthoritySnapshot,
    coordinator.getTerminalAuthoritySnapshot,
  );
  const writesLocked = !isWorkspaceEditable(snapshot);
  const reloadingWorkspace = snapshot.phase === 'RELOADING_WORKSPACE' || snapshot.phase === 'RELOAD_FAILED';

  useEffect(() => {
    if (snapshot.phase !== 'RELOADING_WORKSPACE') {
      return undefined;
    }
    const generation = coordinator.getReloadGeneration();
    let cancelled = false;
    void reloadWorkspaceAfterTerminalRun({
      projectId: project.id,
      queryClient,
    }).then(
      () => {
        if (cancelled || coordinator.getReloadGeneration() !== generation) {
          return;
        }
        coordinator.completeReload();
      },
      () => {
        if (cancelled || coordinator.getReloadGeneration() !== generation) {
          return;
        }
        coordinator.markReloadFailed();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [coordinator, project.id, queryClient, snapshot.phase]);
  const unconfirmedLock =
    snapshot.observedLockingRunId !== null &&
    snapshot.phase !== 'RELOADING_WORKSPACE' &&
    snapshot.phase !== 'RELOAD_FAILED';
  const activeQuery = useActiveRunQuery(project.id, unconfirmedLock);
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const leaveGuard = useUnsavedDialogState();
  const terminalAuthorityError = terminalAuthority.status === 'error'
    ? authorityErrorMessage(activeQuery.error)
    : null;
  useDirtyBeforeUnload(dirtyCount);

  const handleSkipToEditor = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setActivePanel('file');
    document.getElementById(EDITOR_REGION_ID)?.focus();
  }, []);

  const handleLogoutClick = useCallback(() => {
    const decision = requestLogout(useWorkspaceSession.getState().dirtyPaths.size);
    if (decision.kind === 'proceed') {
      logout();
      return;
    }
    requestUnsavedDialog({
      open: true,
      mode: 'leave',
      action: { type: 'logout' },
      message: LEAVE_MESSAGE,
    });
  }, []);

  const handleCancelLeave = useCallback(() => {
    dismissUnsavedDialog();
  }, []);

  const handleDiscardLeave = useCallback(() => {
    dismissUnsavedDialog();
    logout();
  }, []);

  return (
    <WorkspaceFileReadsPaused.Provider value={reloadingWorkspace}>
    <div className="workbench-shell flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <a href={`#${EDITOR_REGION_ID}`} className="skip-to-editor" onClick={handleSkipToEditor}>
        Skip to editor
      </a>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <Button
          render={<Link to="/projects" />}
          variant="ghost"
          size="icon"
          aria-label="Back to projects"
          title="Back to projects"
        >
          <ArrowLeft />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</h1>
        <span className="shrink-0 text-sm text-muted-foreground">{project.state}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Log out"
          title="Log out"
          onClick={handleLogoutClick}
        >
          <LogOut />
        </Button>
      </header>
      {unconfirmedOperationId !== null ? (
        <div className="border-b bg-background px-4 py-2">
          <PythonDependencyRecovery
            projectId={project.id}
            userId={userId}
            variant="ready"
            operationId={unconfirmedOperationId}
            onRecovered={() => {
              setUnconfirmedOperationId(null);
              reloadAfterRecovery();
            }}
          />
        </div>
      ) : null}
      {recoveryReloadFailed ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>Dependency change confirmed, but reloading the workspace failed.</InlineAlert>
          <Button type="button" variant="outline" onClick={reloadAfterRecovery}>
            Reload workspace
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside
          aria-label="Project files"
          className="relative flex w-[256px] min-w-[256px] max-w-[256px] shrink-0 flex-col overflow-hidden border-r"
        >
          <span className="pointer-events-none absolute top-0 left-3 z-10 flex h-12 items-center font-mono text-sm text-muted-foreground">
            /
          </span>
          <div className="min-h-0 min-w-0 flex-1">
            <FileTree projectId={project.id} writesLocked={writesLocked} />
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            role="tablist"
            aria-label="Workbench panels"
            className="flex h-10 shrink-0 items-center gap-1 border-b px-2"
          >
            <button
              type="button"
              role="tab"
              id="workbench-tab-file"
              aria-label="File"
              aria-controls={EDITOR_REGION_ID}
              aria-selected={activePanel === 'file'}
              className={cn(
                panelTabClassName,
                activePanel === 'file'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
              onClick={() => {
                setActivePanel('file');
              }}
            >
              <FileCode className="h-4 w-4" aria-hidden />
              File
            </button>
            <button
              type="button"
              role="tab"
              id="workbench-tab-run"
              aria-label="Run"
              aria-controls={RUN_PANEL_ID}
              aria-selected={activePanel === 'run'}
              className={cn(
                panelTabClassName,
                activePanel === 'run'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
              onClick={() => {
                setActivePanel('run');
              }}
            >
              <Play className="h-4 w-4" aria-hidden />
              Run
            </button>
            {pythonWorkbench ? (
              <button
                type="button"
                role="tab"
                id="workbench-tab-dependencies"
                aria-label="Dependencies"
                aria-controls={DEPENDENCIES_PANEL_ID}
                aria-selected={activePanel === 'dependencies'}
                className={cn(
                  panelTabClassName,
                  activePanel === 'dependencies'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onClick={() => {
                  setActivePanel('dependencies');
                }}
              >
                <Package className="h-4 w-4" aria-hidden />
                Dependencies
              </button>
            ) : null}
            {experimentalTerminalEnabled ? (
              <button
                type="button"
                role="tab"
                id="workbench-tab-terminal"
                aria-label="Terminal"
                aria-controls={TERMINAL_PANEL_ID}
                aria-selected={activePanel === 'terminal'}
                className={cn(
                  panelTabClassName,
                  activePanel === 'terminal'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onClick={() => {
                  setTerminalLoaded(true);
                  setActivePanel('terminal');
                }}
              >
                <SquareTerminal className="h-4 w-4" aria-hidden />
                Terminal
              </button>
            ) : null}
          </div>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <div
              id={EDITOR_REGION_ID}
              role="tabpanel"
              tabIndex={-1}
              aria-label="Editor"
              aria-hidden={activePanel !== 'file'}
              inert={activePanel !== 'file' ? true : undefined}
              className={cn(
                panelSurfaceClassName,
                activePanel === 'file' ? 'z-10' : 'invisible pointer-events-none',
              )}
            >
              {activeQuery.isError ? (
                <div className="flex items-center gap-2 border-b px-3 py-2">
                  <InlineAlert>{authorityErrorMessage(activeQuery.error)}</InlineAlert>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void activeQuery.refetch();
                    }}
                  >
                    Retry loading run authority
                  </Button>
                </div>
              ) : null}
              {snapshot.phase === 'RELOADING_WORKSPACE' ? (
                <div role="status" className="border-b px-3 py-2 text-sm text-muted-foreground">
                  Reloading workspace
                </div>
              ) : null}
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {!reloadingWorkspace && <EditorWorkspace projectId={project.id} writesLocked={writesLocked} />}
              </div>
            </div>
            <div
              id={RUN_PANEL_ID}
              role="tabpanel"
              aria-labelledby="workbench-tab-run"
              aria-hidden={activePanel !== 'run'}
              inert={activePanel !== 'run' ? true : undefined}
              className={cn(
                panelSurfaceClassName,
                activePanel === 'run' ? 'z-10' : 'invisible pointer-events-none',
              )}
            >
              <RunPanel
                key={project.id}
                projectId={project.id}
                projectTemplateId={project.runtime?.templateId ?? 'java-console'}
                coordinator={coordinator}
              />
            </div>
            {pythonWorkbench ? (
              <div
                id={DEPENDENCIES_PANEL_ID}
                role="tabpanel"
                aria-labelledby="workbench-tab-dependencies"
                aria-hidden={activePanel !== 'dependencies'}
                inert={activePanel !== 'dependencies' ? true : undefined}
                className={cn(
                  panelSurfaceClassName,
                  activePanel === 'dependencies' ? 'z-10' : 'invisible pointer-events-none',
                )}
              >
                <PythonDependenciesPanel
                  projectId={project.id}
                  userId={userId}
                  workspaceLocked={writesLocked}
                  unconfirmedOperationId={unconfirmedOperationId}
                  onResponseLost={setUnconfirmedOperationId}
                />
              </div>
            ) : null}
            {experimentalTerminalEnabled && terminalLoaded ? (
              <div
                id={TERMINAL_PANEL_ID}
                role="tabpanel"
                aria-labelledby="workbench-tab-terminal"
                aria-hidden={activePanel !== 'terminal'}
                inert={activePanel !== 'terminal' ? true : undefined}
                className={cn(
                  panelSurfaceClassName,
                  activePanel === 'terminal' ? 'z-10' : 'invisible pointer-events-none',
                )}
              >
                <Suspense
                  fallback={
                    <p role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading terminal
                    </p>
                  }
                >
                  <LazyJobTerminalPanel
                    projectId={project.id}
                    active={activePanel === 'terminal'}
                    authorityLoading={terminalAuthority.status === 'pending'}
                    authorityError={terminalAuthorityError}
                    run={terminalAuthority.run}
                  />
                </Suspense>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <UnsavedChangesDialog
        open={leaveGuard.open && leaveGuard.action.type === 'logout'}
        mode="leave"
        message={leaveGuard.open ? leaveGuard.message : LEAVE_MESSAGE}
        onDiscard={handleDiscardLeave}
        onCancel={handleCancelLeave}
      />
    </div>
    </WorkspaceFileReadsPaused.Provider>
  );
}
