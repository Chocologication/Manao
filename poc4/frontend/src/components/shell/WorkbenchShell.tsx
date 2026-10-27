import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, FileCode, LogOut, Package, Play, SquareTerminal, PanelLeft, PanelRight, Scan, X } from 'lucide-react';
import { Brand } from '@/components/ui/Brand';
import { ActivityCenter } from './ActivityCenter';
import { AccountPanel } from './AccountPanel';
import { RunInsights } from '@/components/runs/RunInsights';
import { RUNTIME_TEMPLATE_META } from '@/contracts/project';
import { WorkbenchCommands } from './WorkbenchCommands';
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
import { Link, useLocation } from 'react-router';
import { logout } from '@/app/appRuntime';
import { clearAgentTaskId, getAgentTask, readAgentTaskId } from '@/api/agentTaskApi';
import { ApiRequestError } from '@/api/ApiRequestError';
import { EditorWorkspace } from '@/components/files/EditorWorkspace';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { FileTree } from '@/components/files/FileTree';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { projectFileWritePredicate } from '@/components/files/editorSaveCommand';
import { RunPanel } from '@/components/runs/RunPanel';
import { type RunErrorLocation } from '@/components/runs/runErrorLocator';
import { resolveErrorFile } from '@/features/files/resolveErrorFile';
import { Button } from '@/components/ui/button';
import type { AgentTaskSnapshot } from '@/contracts/agentTask';
import { parseRunId, type RunId } from '@/contracts/run';
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
  AgentConversationPanel,
} from '@/features/ai/AgentConversationPanel';
import {
  agentTaskKeys,
  useCloseAgentTaskMutation,
  usePauseAgentTaskMutation,
  useCurrentAgentTaskQuery,
} from '@/features/ai/agentTaskQueries';
import { resolveAgentTaskPreconditions } from '@/features/ai/agentTaskPreconditions';
import { WorkspaceFileReadsPaused, getWorkspaceRevision } from '@/features/files/fileQueries';
import { useEditorNavigation } from '@/features/editor/editorNavigation';
import { parseProjectRelativePath } from '@/features/files/pathPolicy';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  isWorkspaceEditable,
  useRunAuthorityCoordinator,
} from '@/features/runs/RunAuthorityCoordinator';
import { useActiveRunQuery, runKeys } from '@/features/runs/runQueries';
import { reloadWorkspaceAfterTerminalRun } from '@/features/runs/workspaceReload';
import { cn } from '@/lib/utils';
import { useWorkbenchPreferences } from '@/features/preferences/workbenchPreferences';

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
  const location = useLocation();
  const layout = useWorkbenchPreferences();
  const [activePanel, setActivePanel] = useState<WorkbenchPanel>(() => new URLSearchParams(location.search).get('panel') === 'run' ? 'run' : 'file');
  const [runSelection, setRunSelection] = useState<{ projectId: string; runId: RunId; seq: number } | null>(null);
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => !window.matchMedia('(min-width: 1024px)').matches);
  const [filesVisible, setFilesVisible] = useState(() => layout.filesVisible && !layout.focusMode && window.matchMedia('(min-width: 1024px)').matches);
  const [insightsVisible, setInsightsVisible] = useState(() => layout.insightsVisible && !layout.focusMode && window.matchMedia('(min-width: 1024px)').matches);
  const filePanelRef = useRef<HTMLElement>(null);
  const insightsPanelRef = useRef<HTMLElement>(null);
  const historyPanelRef = useRef<HTMLElement>(null);
  const [historyTarget, setHistoryTarget] = useState<HTMLDivElement | null>(null);
  const aiMode = activePanel === 'agent';
  const fileToggleRef = useRef<HTMLButtonElement>(null);
  const insightsToggleRef = useRef<HTMLButtonElement>(null);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const resizePanels = () => {
      setCompactViewport(!media.matches);
      setFilesVisible(media.matches && layout.filesVisible && !layout.focusMode);
      setInsightsVisible(media.matches && layout.insightsVisible && !layout.focusMode);
    };
    resizePanels();
    media.addEventListener('change', resizePanels);
    return () => media.removeEventListener('change', resizePanels);
  }, [layout.filesVisible, layout.focusMode, layout.insightsVisible]);
  const drawerOpen = compactViewport && (filesVisible || insightsVisible);
  const closeDrawers = useCallback(() => {
    setFilesVisible(false);
    setInsightsVisible(false);
  }, []);
  const toggleFiles = useCallback(() => {
    if (compactViewport && !filesVisible) setInsightsVisible(false);
    setFilesVisible(!filesVisible);
    if (!compactViewport) layout.update({ filesVisible: !filesVisible, focusMode: false });
  }, [compactViewport, filesVisible, layout]);
  const toggleInsights = useCallback(() => {
    if (compactViewport && !insightsVisible) setFilesVisible(false);
    setInsightsVisible(!insightsVisible);
    if (!compactViewport) layout.update({ insightsVisible: !insightsVisible, focusMode: false });
  }, [compactViewport, insightsVisible, layout]);
  useEffect(() => {
    if (!drawerOpen) {
      drawerReturnFocusRef.current?.focus();
      drawerReturnFocusRef.current = null;
      return;
    }
    const drawer = filesVisible ? filePanelRef.current : aiMode ? historyPanelRef.current : insightsPanelRef.current;
    const returnFocus = filesVisible ? fileToggleRef.current : insightsToggleRef.current;
    drawerReturnFocusRef.current = returnFocus;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    const animation = window.requestAnimationFrame(() => (focusables()[0] ?? drawer)?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawers();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        drawer?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(animation);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDrawers, drawerOpen, filesVisible, aiMode]);
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
  const [agentSubmissionInFlight, setAgentSubmissionInFlight] = useState(false);
  const [agentSubmissionPending, setAgentSubmissionPending] = useState(() => readAgentTaskId(userId, project.id) !== null);
  const agentTaskQuery = useCurrentAgentTaskQuery(project.id, agentPanelEnabled, userId, !agentSubmissionInFlight);
  const agentTask = agentTaskQuery.data ?? null;
  useEffect(() => {
    if (agentTask !== null && !agentTask.writesLocked) clearAgentTaskId(userId, project.id, agentTask.taskId);
    setAgentSubmissionPending(agentSubmissionInFlight || readAgentTaskId(userId, project.id) !== null);
  }, [agentTask, agentTaskQuery.dataUpdatedAt, agentSubmissionInFlight, userId, project.id]);
  const closeAgentTaskMutation = useCloseAgentTaskMutation(project.id);
  const pauseAgentTaskMutation = usePauseAgentTaskMutation(project.id);
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
  const [controlReloadedTaskId, setControlReloadedTaskId] = useState<string | null>(null);
  const releasedControlTask = agentTask?.writesLocked === false ? agentTask : settledAgentTask;
  const controlReloadTaskId = releasedControlTask && !releasedControlTask.writesLocked
    && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(releasedControlTask.closeReasonCode ?? '')
    ? releasedControlTask.taskId : null;
  const controlReloadRequired = controlReloadTaskId !== null && controlReloadedTaskId !== controlReloadTaskId;
  // The settled snapshot fetch gates the release too: until the final revision is
  // confirmed (and any needed reload ran) the workspace must not unlock, and a
  // failed fetch keeps it locked behind its own Retry affordance.
  const [settledSnapshotPending, setSettledSnapshotPending] = useState(false);
  const [settledSnapshotFailed, setSettledSnapshotFailed] = useState(false);
  const [settledSnapshotAttempt, setSettledSnapshotAttempt] = useState(0);
  const lastAgentTaskIdRef = useRef<string | null>(null);
  const agentTaskOccupying = agentTask !== null && agentTask.writesLocked;
  const agentReloading = agentReloadPending || agentReloadFailed || agentReloadBlocked || controlReloadRequired;
  const settledSnapshotSettling = settledSnapshotPending || settledSnapshotFailed;
  // The shell reuses the panel's start gate for its write-lock decision: the
  // workspace is locked exactly while the shared function would refuse a task
  // start because one occupies the project or a reload is in flight, failed or
  // blocked (the neutral inputs pin everything the shell is not deciding here).
  const agentTaskLocked = agentSubmissionPending || agentPanelEnabled && (agentTaskQuery.isPending || agentTaskQuery.isError) || !resolveAgentTaskPreconditions({
    dirtyCount: 0,
    writePending: false,
    hasActiveRun: false,
    runAuthorityKnown: true,
    workspaceRevision: '0',
    taskWritesLocked: agentTaskOccupying,
    reloading: agentReloading || settledSnapshotSettling,
  }).canStart;
  const seedAgentTask = useCallback(
    (snapshot: AgentTaskSnapshot) => {
      queryClient.setQueryData(agentTaskKeys.current(project.id), snapshot);
    },
    [project.id, queryClient],
  );
  const observeReleasedControlTask = useCallback((snapshot: AgentTaskSnapshot) => {
    setSettledAgentTask(previous => previous?.taskId === snapshot.taskId ? previous : snapshot);
  }, []);
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
  const runAgentReload = useCallback((controlTaskId: string | null = null) => {
    setAgentReloadPending(true);
    Promise.all([reloadWorkspaceAfterTerminalRun({ projectId: project.id, queryClient }),
      queryClient.invalidateQueries({ queryKey: runKeys.all(project.id) })]).then(
      () => {
        if (controlTaskId !== null) setControlReloadedTaskId(controlTaskId);
        setAgentReloadFailed(false);
        setAgentReloadPending(false);
      },
      () => {
        setAgentReloadFailed(true);
        setAgentReloadPending(false);
      },
    );
  }, [project.id, queryClient]);
  const retrySettledSnapshot = useCallback(() => {
    setSettledSnapshotFailed(false);
    setSettledSnapshotAttempt((attempt) => attempt + 1);
  }, []);
  // One settled snapshot per released task: GET current only answers while a
  // task occupies the project, so the final result is fetched by its id once.
  // The fetch participates in the write gate: pending and failed both keep the
  // workspace locked, and a failure offers its own Retry affordance instead of
  // silently releasing it.
  useEffect(() => {
    if (agentTask !== null) {
      if (lastAgentTaskIdRef.current !== agentTask.taskId) {
        lastAgentTaskIdRef.current = agentTask.taskId;
        setSettledAgentTask(null);
      }
      // The project is occupied again: no settled fetch may hold or fail the gate.
      setSettledSnapshotPending(false);
      setSettledSnapshotFailed(false);
      return undefined;
    }
    const taskId = lastAgentTaskIdRef.current;
    if (taskId === null) {
      return undefined;
    }
    let cancelled = false;
    setSettledSnapshotPending(true);
    getAgentTask(project.id, taskId)
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSettledAgentTask(snapshot);
        setSettledSnapshotPending(false);
        setSettledSnapshotFailed(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSettledAgentTask(null);
        setSettledSnapshotPending(false);
        setSettledSnapshotFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentTask, project.id, settledSnapshotAttempt]);
  // The reload trigger observes the occupying task's revision and, after the
  // task settled between two polls, the settled snapshot's final revision.
  const agentReloadRevision = agentTask?.workspaceRevision ?? settledAgentTask?.workspaceRevision ?? null;
  useEffect(() => {
    if (!agentPanelEnabled || agentReloadRevision === null) {
      return undefined;
    }
    if (!controlReloadRequired && agentReloadRevision === agentReloadRevisionRef.current) {
      return undefined;
    }
    if (agentReloadRevisionRef.current === null) {
      // First observation of a task: it was submitted against this browser's
      // saved revision, so only a difference from the local cache needs a reload.
      const localRevision = getWorkspaceRevision(queryClient, project.id);
      if (!controlReloadRequired && agentReloadRevision === localRevision) {
        agentReloadRevisionRef.current = agentReloadRevision;
        return undefined;
      }
    }
    if (agentReloadPending || recoveryReloadPending) {
      // One reload at a time: concurrent polls never start a second one.
      return undefined;
    }
    if (controlReloadRequired && agentReloadFailed) return undefined;
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
    runAgentReload(controlReloadTaskId);
  }, [
    agentReloadAttempt,
    agentReloadFailed,
    agentReloadPending,
    agentReloadRevision,
    controlReloadRequired,
    controlReloadTaskId,
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

  const [locationFeedback, setLocationFeedback] = useState('');
  const locationAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    locationAbortRef.current?.abort();
    const target = useEditorNavigation.getState().target;
    if (target?.projectId === project.id) useEditorNavigation.getState().clear(target);
  }, [project.id]);
  const handleLocateRunError = useCallback(async (location: RunErrorLocation) => {
    if (reloadingWorkspace) {
      setLocationFeedback('工作区正在重新加载，请稍后再定位。');
      return;
    }
    locationAbortRef.current?.abort();
    const controller = new AbortController();
    locationAbortRef.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 15_000);
    setLocationFeedback('正在查找项目源文件…');
    try {
      const { path, reason } = await resolveErrorFile(queryClient, project.id, location, controller.signal);
      if (locationAbortRef.current !== controller) return;
      if (path === null) {
        const messages = { 'not-found': '项目中没有找到该文件，请查看原始日志。', ambiguous: '存在多个同名文件，请从文件树选择正确路径。', limit: '项目较大，已达到查找上限，请从文件树打开源文件。', external: '这是依赖环境中的文件，请查看原始错误上下文。', found: '' };
        setLocationFeedback(messages[reason]);
        return;
      }
      const session = useWorkspaceSession.getState();
      if (session.projectId !== project.id) return;
      const relative = parseProjectRelativePath(path);
      session.openFile(relative);
      session.selectPath(relative);
      useEditorNavigation.getState().request({ projectId: project.id, path: relative, line: location.line, column: location.column ?? 1 });
      setActivePanel('file');
      if (compactViewport) closeDrawers();
      setLocationFeedback(`已打开 ${path}:${location.line}（当前工作区；历史运行文件可能已变化）`);
    } catch {
      if (locationAbortRef.current === controller) setLocationFeedback(controller.signal.aborted ? '查找已超时，请从文件树打开源文件。' : '读取项目文件失败，请重试定位。');
    } finally {
      window.clearTimeout(deadline);
      if (locationAbortRef.current === controller) locationAbortRef.current = null;
    }
  }, [closeDrawers, compactViewport, project.id, queryClient, reloadingWorkspace]);

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
      <header className="lab-workbench-header" inert={drawerOpen ? true : undefined}>
        <Button
          render={<Link to="/projects" />}
          variant="ghost"
          size="icon"
          aria-label="Back to projects"
          title="Back to projects"
        >
          <ArrowLeft />
        </Button>
        <span className="lab-workbench-brand"><Brand compact /></span>
        <div className="lab-workbench-title"><h1>{project.name}</h1><span>{RUNTIME_TEMPLATE_META[project.runtime?.templateId ?? 'java-console'].label}</span></div>
        <span className="lab-save-indicator" data-dirty={dirtyCount > 0}><span />{dirtyCount > 0 ? `${dirtyCount} 个文件未保存` : '无未保存修改'}</span>
        <Button ref={fileToggleRef} variant="ghost" size="icon" aria-label="切换文件面板" title="文件面板" aria-expanded={filesVisible} onClick={toggleFiles}><PanelLeft /></Button>
        <Button ref={insightsToggleRef} variant="ghost" size="icon" aria-label={aiMode ? '切换对话历史' : '切换项目洞察'} title={aiMode ? '对话历史' : '项目洞察'} aria-expanded={insightsVisible} onClick={toggleInsights}><PanelRight /></Button>
        <WorkbenchCommands python={pythonWorkbench} insightsLabel={aiMode ? '对话历史' : undefined} onSelectPanel={setActivePanel} onToggleFiles={toggleFiles} onToggleInsights={toggleInsights} />
        <ActivityCenter key={`${userId}:${project.id}`} projectId={project.id} userId={userId} onOpenRuns={() => setActivePanel('run')} />
        <AccountPanel compact onLogout={handleLogoutClick} />
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
          <InlineAlert>依赖变更已确认，但工作区重新加载失败。</InlineAlert>
          <Button type="button" variant="outline" aria-label="Reload workspace" onClick={reloadAfterRecovery}>
            重新加载工作区
          </Button>
        </div>
      ) : null}
      {pendingDiscovery === 'failed' ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>无法核对待确认的依赖变更。</InlineAlert>
          <Button type="button" variant="outline" aria-label="Retry pending dependency check" onClick={retryPendingDiscovery}>
            重试依赖核对
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
      {settledSnapshotFailed ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>The agent task finished, but its final result could not be loaded.</InlineAlert>
          <Button type="button" variant="outline" onClick={retrySettledSnapshot}>
            Retry loading the result
          </Button>
        </div>
      ) : null}
      <div className="lab-workbench-body flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ ['--lab-file-width' as string]: `${layout.fileWidth}px` }} data-focus-mode={layout.focusMode ? 'true' : 'false'}>
        {drawerOpen && <button className="lab-files-backdrop" aria-label="关闭面板" onClick={closeDrawers} />}
        <aside
          ref={filePanelRef}
          aria-label="Project files"
          aria-modal={drawerOpen && filesVisible ? 'true' : undefined}
          role={drawerOpen && filesVisible ? 'dialog' : undefined}
          tabIndex={drawerOpen && filesVisible ? -1 : undefined}
          className="lab-file-sidebar relative flex shrink-0 flex-col overflow-hidden border-r"
          data-open={filesVisible}
        >
          <div className="lab-file-sidebar-title"><span>EXPLORER</span><button className="lab-mobile-close" aria-label="关闭文件面板" onClick={() => setFilesVisible(false)}><X size={16} /></button></div>
          <div className="min-h-0 min-w-0 flex-1">
            <FileTree projectId={project.id} writesLocked={writesLocked} />
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={drawerOpen ? true : undefined}>
          <div
            role="tablist"
            aria-label="Workbench panels"
            className="lab-workbench-tabs flex shrink-0 items-center gap-1 border-b px-2"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
              const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
              if (current < 0) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              tabs[next]?.focus();
              tabs[next]?.click();
            }}
          >
            <button
              type="button"
              role="tab"
              id="workbench-tab-file"
              aria-label="File"
              aria-controls={EDITOR_REGION_ID}
              aria-selected={activePanel === 'file'}
              tabIndex={activePanel === 'file' ? 0 : -1}
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
              代码
            </button>
            <button
              type="button"
              role="tab"
              id="workbench-tab-run"
              aria-label="Run"
              aria-controls={RUN_PANEL_ID}
              aria-selected={activePanel === 'run'}
              tabIndex={activePanel === 'run' ? 0 : -1}
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
              运行记录
            </button>
            {pythonWorkbench ? (
              <button
                type="button"
                role="tab"
                id="workbench-tab-dependencies"
                aria-label="Dependencies"
                aria-controls={DEPENDENCIES_PANEL_ID}
                aria-selected={activePanel === 'dependencies'}
                tabIndex={activePanel === 'dependencies' ? 0 : -1}
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
                依赖管理
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
                tabIndex={activePanel === 'terminal' ? 0 : -1}
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
                终端 <small>Beta</small>
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
                tabIndex={activePanel === 'agent' ? 0 : -1}
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
            <button type="button" className="lab-focus-toggle" aria-label="切换专注模式" title="专注模式" aria-pressed={layout.focusMode} onClick={() => layout.update({ focusMode: !layout.focusMode })}><Scan size={16} /></button>
          </div>
          {locationFeedback && <p className="lab-location-feedback" role="status">{locationFeedback}<button type="button" aria-label="关闭定位提示" onClick={() => setLocationFeedback('')}><X size={14} /></button></p>}
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
                  正在重新加载工作区
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
                onOpenAgentTask={agentPanelEnabled ? () => { setActivePanel('agent'); if (compactViewport) closeDrawers(); } : undefined}
                requestRunSelection={runSelection?.projectId === project.id ? runSelection : null}
                onLocateError={(target) => void handleLocateRunError(target)}
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
                <AgentConversationPanel
                  onReleasedControlTask={observeReleasedControlTask}
                  controlReloadedTaskId={controlReloadedTaskId}
                  historyTarget={historyTarget}
                  uiActive={aiMode}
                  projectId={project.id}
                  userId={userId}
                  task={agentTask}
                  settledTask={settledAgentTask}
                  pollFailed={agentTaskQuery.isError}
                  writePending={agentWritePending}
                  hasActiveRun={snapshot.observedLockingRunId !== null}
                  runAuthorityKnown={snapshot.phase !== 'LOADING_AUTHORITY' && activeQuery.isSuccess && !snapshot.startPending}
                  reloading={
                    reloadingWorkspace ||
                    agentReloadFailed ||
                    agentReloadBlocked ||
                    controlReloadRequired ||
                    settledSnapshotSettling
                  }
                  closePending={closeAgentTaskMutation.isPending}
                  pausePending={pauseAgentTaskMutation.isPending}
                  pauseError={pauseAgentTaskMutation.isError && pauseAgentTaskMutation.variables === agentTask?.taskId
                    ? `Could not pause the task${pauseAgentTaskMutation.error instanceof ApiRequestError && pauseAgentTaskMutation.error.body ? ` (${pauseAgentTaskMutation.error.body.code})` : ''}. Try again.` : null}
                  onPause={() => { if (agentTask !== null) pauseAgentTaskMutation.mutate(agentTask.taskId); }}
                  closeError={closeAgentTaskMutation.isError && closeAgentTaskMutation.variables === agentTask?.taskId
                    ? `Could not end the task${closeAgentTaskMutation.error instanceof ApiRequestError && closeAgentTaskMutation.error.body ? ` (${closeAgentTaskMutation.error.body.code})` : ''}. Try again.`
                    : null}
                  onTaskAccepted={seedAgentTask}
                  onSubmissionPendingChange={(pending) => {
                    setAgentSubmissionInFlight(pending);
                    setAgentSubmissionPending(pending || readAgentTaskId(userId, project.id) !== null);
                    if (!pending) void queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(project.id) });
                  }}
                  onViewRun={(runId) => {
                    let selectedRunId: RunId;
                    try {
                      selectedRunId = parseRunId(runId);
                    } catch {
                      return;
                    }
                    setRunSelection((previous) => ({ projectId: project.id, runId: selectedRunId, seq: (previous?.seq ?? 0) + 1 }));
                    setActivePanel('run');
                  }}
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
        {agentPanelEnabled ? <aside
          ref={historyPanelRef}
          aria-label="对话历史"
          hidden={!aiMode || !insightsVisible}
          inert={!aiMode || !insightsVisible ? true : undefined}
          role={drawerOpen && insightsVisible && aiMode ? 'dialog' : undefined}
          aria-modal={drawerOpen && insightsVisible && aiMode ? 'true' : undefined}
          tabIndex={drawerOpen && insightsVisible && aiMode ? -1 : undefined}
          className="lab-insights manao-ai-history-sidebar"
          data-open={aiMode && insightsVisible}
        >
          <div className="lab-file-sidebar-title"><span>对话历史</span><button className="lab-mobile-close" aria-label="关闭对话历史" onClick={() => setInsightsVisible(false)}><X size={16} /></button></div>
          <div ref={setHistoryTarget} className="min-h-0 flex-1" />
        </aside> : null}
        {insightsVisible && !aiMode && (
          <RunInsights
            ref={insightsPanelRef}
            compactViewport={compactViewport}
            project={project}
            activeRun={activeQuery.data?.run ?? null}
            activePending={activeQuery.isPending}
            activeError={activeQuery.isError}
            writesLocked={writesLocked}
            onOpenRuns={() => { setActivePanel('run'); if (compactViewport) closeDrawers(); }}
            onClose={() => setInsightsVisible(false)}
          />
        )}
      </div>
      <footer className="lab-workbench-status"><span role="status" aria-live="polite"><span className="lab-status-dot" />{writesLocked ? '工作区写入已锁定' : '工作区可编辑'}</span><span>{project.runtime?.templateId?.startsWith('python') ? 'Python / uv' : 'Java / Maven'}</span><span>MANAO CLOUD LAB</span></footer>
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
