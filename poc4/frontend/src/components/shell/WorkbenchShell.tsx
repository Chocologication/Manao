import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, FileCode, LogOut, Package, Play, SquareTerminal } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { Link } from 'react-router';
import { logout } from '@/app/appRuntime';
import { getAgentTask } from '@/api/agentTaskApi';
import { EditorWorkspace } from '@/components/files/EditorWorkspace';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { FileTree } from '@/components/files/FileTree';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { projectFileWritePredicate } from '@/components/files/editorSaveCommand';
import { RunPanel } from '@/components/runs/RunPanel';
import { Button } from '@/components/ui/button';
import type { AgentTaskSnapshot } from '@/contracts/agentTask';
import type { ProjectSummary } from '@/contracts/project';
import { isPythonRuntimeTemplate } from '@/contracts/project';
import {
  listPendingPythonDependencies,
  readPythonDependencyOperationId,
  storePythonDependencyOperationId,
} from '@/api/pythonDependencyApi';
import { readWithProjectBusyRetry } from '@/api/projectBusyRetry';
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
import {
  AgentTaskPanel,
} from '@/features/ai/AgentTaskPanel';
import {
  agentTaskKeys,
  useCloseAgentTaskMutation,
  useCurrentAgentTaskQuery,
} from '@/features/ai/agentTaskQueries';
import { resolveAgentTaskPreconditions } from '@/features/ai/agentTaskPreconditions';
import { WorkspaceFileReadsPaused, getWorkspaceRevision } from '@/features/files/fileQueries';
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
const AGENT_PANEL_ID = 'workbench-agent-panel';

type WorkbenchPanel = 'file' | 'run' | 'dependencies' | 'terminal' | 'agent';

/**
 * One-shot discovery of a server-pending dependency operation for a READY
 * workbench that knows no unconfirmed operation (design 6.1). It never polls:
 * 'inFlight'/'settled' end the episode, only an explicit user retry re-runs it.
 */
type PendingDependencyDiscovery = 'notAttempted' | 'inFlight' | 'settled' | 'failed';

export function isExperimentalTerminalEnabled(value: string | undefined): boolean {
  return value === 'true';
}

/** The agent stage ships switched off; the panel only exists when explicitly enabled. */
export function isAgentPanelEnabled(value: string | undefined): boolean {
  return value === 'true';
}

const experimentalTerminalEnabled = isExperimentalTerminalEnabled(
  import.meta.env.VITE_ENABLE_EXPERIMENTAL_TERMINAL,
);

const agentPanelEnabled = isAgentPanelEnabled(import.meta.env.VITE_ENABLE_AI);

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
  // The dependencies panel reports its in-flight operations; the shell then holds
  // the write gate even while another panel tab is visible.
  const [dependencyOperationBusy, setDependencyOperationBusy] = useState(false);
  // A post-recovery reload failure is user-visible: the change is committed but the
  // surface may be stale until the reload succeeds. Nothing is unlocked by it.
  const [recoveryReloadFailed, setRecoveryReloadFailed] = useState(false);
  // The authoritative reload after a confirmed recovery spans its in-flight window
  // AND the failed state while the Retry affordance exists; only SUCCESS releases it.
  const [recoveryReloadPending, setRecoveryReloadPending] = useState(false);
  const reloadAfterRecovery = useCallback(() => {
    setRecoveryReloadPending(true);
    reloadWorkspaceAfterTerminalRun({ projectId: project.id, queryClient })
      .then(() => {
        setRecoveryReloadFailed(false);
        setRecoveryReloadPending(false);
      })
      .catch(() => setRecoveryReloadFailed(true));
  }, [project.id, queryClient]);
  // A READY workbench that knows no unconfirmed operation asks the server once
  // whether a durable PENDING exists (design 6.1): after a backend restart a new
  // browser session has no stored id, yet the pending operation still gates the
  // workspace — the shell must surface it instead of dead-ending.
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingDependencyDiscovery>('notAttempted');
  // Invalidates a discovery result whose episode is over (retried or superseded)
  // without cancelling its fetch, so the state machine can never stick in-flight.
  const pendingDiscoveryEpochRef = useRef(0);
  useEffect(() => {
    if (!pythonWorkbench || userId === '' || unconfirmedOperationId !== null) {
      return;
    }
    if (pendingDiscovery !== 'notAttempted') {
      return;
    }
    const epoch = ++pendingDiscoveryEpochRef.current;
    setPendingDiscovery('inFlight');
    // Transient PROJECT_BUSY contention with the concurrent file reads is retried
    // with the shared read-only retry policy; real errors still surface below.
    readWithProjectBusyRetry(() => listPendingPythonDependencies(project.id))
      .then((pending) => {
        if (pendingDiscoveryEpochRef.current !== epoch) {
          return;
        }
        setPendingDiscovery('settled');
        // Design 6.1: the query must not override an operation id the client
        // saved while it ran — a discovered result is ignored entirely then.
        if (readPythonDependencyOperationId(userId, project.id) !== null) {
          return;
        }
        const discovered = pending[0]?.operationId ?? null;
        if (discovered !== null) {
          storePythonDependencyOperationId(userId, project.id, discovered);
          setUnconfirmedOperationId(discovered);
        }
      })
      .catch(() => {
        if (pendingDiscoveryEpochRef.current !== epoch) {
          return;
        }
        setPendingDiscovery('failed');
      });
  }, [pendingDiscovery, project.id, pythonWorkbench, unconfirmedOperationId, userId]);
  const retryPendingDiscovery = useCallback(() => {
    setPendingDiscovery('notAttempted');
  }, []);
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
  const runWritesLocked = !isWorkspaceEditable(snapshot);
  // The full write gate: besides the run authority, a dependency operation in flight,
  // one with an unconfirmed result, or the authoritative reload after a recovered
  // operation also locks workspace writes — the workspace content is not
  // authoritative until every one of them resolves (design 6.1, fail-closed).
  // ---------------------------------------------------------------------
  // Stage-one agent task: the shell polls GET current every two seconds while
  // the AI stage is enabled, derives the write lock from the backend's
  // writesLocked, and reloads the workspace at a safe node whenever the task
  // reports a new revision (the agent saved code the editor must show).
  // ---------------------------------------------------------------------
  const agentTaskQuery = useCurrentAgentTaskQuery(project.id, agentPanelEnabled);
  const agentTask = agentTaskQuery.data ?? null;
  const closeAgentTaskMutation = useCloseAgentTaskMutation(project.id);
  const fileWritePending =
    useIsMutating({ predicate: projectFileWritePredicate(project.id) }) > 0;
  const agentWritePending =
    fileWritePending ||
    dependencyOperationBusy ||
    unconfirmedOperationId !== null ||
    recoveryReloadPending;
  // Agent-driven reload state: pending spans the in-flight reload (the editor
  // is unmounted and file reads paused), failed keeps the workspace read-only
  // behind a Retry affordance, and blocked marks a dirty-buffer conflict that
  // must never be silently replaced.
  const [agentReloadPending, setAgentReloadPending] = useState(false);
  const [agentReloadFailed, setAgentReloadFailed] = useState(false);
  const [agentReloadBlocked, setAgentReloadBlocked] = useState(false);
  const [agentReloadAttempt, setAgentReloadAttempt] = useState(0);
  const agentReloadRevisionRef = useRef<string | null>(null);
  const [settledAgentTask, setSettledAgentTask] = useState<AgentTaskSnapshot | null>(null);
  const lastAgentTaskIdRef = useRef<string | null>(null);
  const agentTaskOccupying = agentTask !== null && agentTask.writesLocked;
  const agentReloading = agentReloadPending || agentReloadFailed || agentReloadBlocked;
  // The shell reuses the panel's start gate for its write-lock decision: the
  // workspace is locked exactly while the shared function would refuse a task
  // start because one occupies the project or a reload is in flight, failed or
  // blocked (the neutral inputs pin everything the shell is not deciding here).
  const agentTaskLocked = !resolveAgentTaskPreconditions({
    dirtyCount: 0,
    writePending: false,
    hasActiveRun: false,
    workspaceRevision: '0',
    taskWritesLocked: agentTaskOccupying,
    reloading: agentReloading,
  }).canStart;
  const seedAgentTask = useCallback(
    (snapshot: AgentTaskSnapshot) => {
      queryClient.setQueryData(agentTaskKeys.current(project.id), snapshot);
    },
    [project.id, queryClient],
  );
  const retryAgentReload = useCallback(() => {
    agentReloadRevisionRef.current = null;
    setAgentReloadFailed(false);
    setAgentReloadBlocked(false);
    setAgentReloadAttempt((attempt) => attempt + 1);
  }, []);
  // The reload always settles its own pending/failed state. It runs outside the
  // effect's cancellation reach (like reloadAfterRecovery): the effect's own
  // pending state would otherwise re-run the effect, run the cleanup and mark
  // the in-flight reload cancelled forever, leaving the editor unmounted.
  // A project switch is guarded inside reloadWorkspaceAfterTerminalRun itself.
  const runAgentReload = useCallback(() => {
    setAgentReloadPending(true);
    reloadWorkspaceAfterTerminalRun({ projectId: project.id, queryClient }).then(
      () => {
        setAgentReloadFailed(false);
        setAgentReloadPending(false);
      },
      () => {
        setAgentReloadFailed(true);
        setAgentReloadPending(false);
      },
    );
  }, [project.id, queryClient]);
  // One settled snapshot per released task: GET current only answers while a
  // task occupies the project, so the final result is fetched by its id once.
  useEffect(() => {
    if (agentTask !== null) {
      if (lastAgentTaskIdRef.current !== agentTask.taskId) {
        lastAgentTaskIdRef.current = agentTask.taskId;
        setSettledAgentTask(null);
      }
      return undefined;
    }
    const taskId = lastAgentTaskIdRef.current;
    if (taskId === null) {
      return undefined;
    }
    let cancelled = false;
    getAgentTask(project.id, taskId)
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSettledAgentTask(snapshot);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSettledAgentTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentTask, project.id]);
  // The reload trigger observes the occupying task's revision and, after the
  // task settled between two polls, the settled snapshot's final revision.
  const agentReloadRevision = agentTask?.workspaceRevision ?? settledAgentTask?.workspaceRevision ?? null;
  useEffect(() => {
    if (!agentPanelEnabled || agentReloadRevision === null) {
      return undefined;
    }
    if (agentReloadRevision === agentReloadRevisionRef.current) {
      return undefined;
    }
    if (agentReloadRevisionRef.current === null) {
      // First observation of a task: it was submitted against this browser's
      // saved revision, so only a difference from the local cache needs a reload.
      const localRevision = getWorkspaceRevision(queryClient, project.id);
      if (agentReloadRevision === localRevision) {
        agentReloadRevisionRef.current = agentReloadRevision;
        return undefined;
      }
    }
    if (agentReloadPending || recoveryReloadPending) {
      // One reload at a time: concurrent polls never start a second one.
      return undefined;
    }
    if (snapshot.phase === 'RELOADING_WORKSPACE' || snapshot.phase === 'RELOAD_FAILED') {
      // The run authority reload owns the workspace; the agent reload re-runs
      // once the phase settles back to editable.
      return undefined;
    }
    if (useWorkspaceSession.getState().dirtyPaths.size > 0) {
      // A start racing local input left a dirty buffer: replacing it would
      // silently drop the user's edits, so the conflict is surfaced instead.
      setAgentReloadBlocked(true);
      return undefined;
    }
    setAgentReloadBlocked(false);
    agentReloadRevisionRef.current = agentReloadRevision;
    runAgentReload();
  }, [
    agentReloadAttempt,
    agentReloadPending,
    agentReloadRevision,
    project.id,
    queryClient,
    recoveryReloadPending,
    runAgentReload,
    snapshot.phase,
  ]);
  const writesLocked =
    runWritesLocked ||
    dependencyOperationBusy ||
    unconfirmedOperationId !== null ||
    recoveryReloadPending ||
    agentTaskLocked;
  const reloadingWorkspace =
    snapshot.phase === 'RELOADING_WORKSPACE' ||
    snapshot.phase === 'RELOAD_FAILED' ||
    agentReloadPending;

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
      {pendingDiscovery === 'failed' ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>Could not check for a pending dependency change.</InlineAlert>
          <Button type="button" variant="outline" onClick={retryPendingDiscovery}>
            Retry pending dependency check
          </Button>
        </div>
      ) : null}
      {agentReloadFailed || agentReloadBlocked ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>
            {agentReloadBlocked
              ? 'The agent changed workspace files. Save or discard your unsaved changes, then reload.'
              : 'The agent changed the workspace files, but reloading them failed.'}
          </InlineAlert>
          <Button type="button" variant="outline" onClick={retryAgentReload}>
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
            {agentPanelEnabled ? (
              <button
                type="button"
                role="tab"
                id="workbench-tab-agent"
                aria-label="AI"
                aria-controls={AGENT_PANEL_ID}
                aria-selected={activePanel === 'agent'}
                className={cn(
                  panelTabClassName,
                  activePanel === 'agent'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onClick={() => {
                  setActivePanel('agent');
                }}
              >
                <Bot className="h-4 w-4" aria-hidden />
                AI
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
                agentTaskActive={agentTaskLocked}
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
                  workspaceLocked={runWritesLocked}
                  unconfirmedOperationId={unconfirmedOperationId}
                  onResponseLost={setUnconfirmedOperationId}
                  onBusyChange={setDependencyOperationBusy}
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
            {agentPanelEnabled ? (
              <div
                id={AGENT_PANEL_ID}
                role="tabpanel"
                aria-labelledby="workbench-tab-agent"
                aria-hidden={activePanel !== 'agent'}
                inert={activePanel !== 'agent' ? true : undefined}
                className={cn(
                  panelSurfaceClassName,
                  activePanel === 'agent' ? 'z-10' : 'invisible pointer-events-none',
                )}
              >
                <AgentTaskPanel
                  projectId={project.id}
                  userId={userId}
                  task={agentTask}
                  settledTask={settledAgentTask}
                  pollFailed={agentTaskQuery.isError}
                  writePending={agentWritePending}
                  hasActiveRun={snapshot.observedLockingRunId !== null}
                  reloading={reloadingWorkspace}
                  closePending={closeAgentTaskMutation.isPending}
                  onTaskAccepted={seedAgentTask}
                  onClose={() => {
                    // The only close path: the owner's explicit button click.
                    if (agentTask !== null) {
                      closeAgentTaskMutation.mutate(agentTask.taskId);
                    }
                  }}
                />
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
