import { ArrowLeft, FileCode, LogOut, Play, SquareTerminal } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { logout } from '@/app/appRuntime';
import { EditorWorkspace } from '@/components/files/EditorWorkspace';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { FileTree } from '@/components/files/FileTree';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { RunPanel } from '@/components/runs/RunPanel';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';
import { terminalPreconditionDescription } from '@/features/editor/runPreconditions';
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
  isWorkspaceEditable,
  useRunAuthorityCoordinator,
} from '@/features/runs/RunAuthorityCoordinator';
import { useActiveRunQuery } from '@/features/runs/runQueries';
import { cn } from '@/lib/utils';

const EDITOR_REGION_ID = 'workbench-editor';
const RUN_PANEL_ID = 'workbench-run-panel';
const TERMINAL_REASON_ID = 'workbench-terminal-reason';

type WorkbenchPanel = 'file' | 'run';

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
  const coordinator = useRunAuthorityCoordinator(project.id);
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const writesLocked = !isWorkspaceEditable(snapshot);
  const unconfirmedLock =
    snapshot.observedLockingRunId !== null &&
    snapshot.phase !== 'RELOADING_WORKSPACE' &&
    snapshot.phase !== 'RELOAD_FAILED';
  const activeQuery = useActiveRunQuery(project.id, unconfirmedLock);
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const leaveGuard = useUnsavedDialogState();
  const terminalDescription = terminalPreconditionDescription(
    dirtyCount > 0 ? 'DIRTY_FILES' : 'STAGE_4_UNAVAILABLE',
  );
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
          <span id={TERMINAL_REASON_ID} className="sr-only">
            {terminalDescription}
          </span>
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
            <button
              type="button"
              role="tab"
              aria-label="Terminal"
              aria-selected={false}
              aria-describedby={TERMINAL_REASON_ID}
              title={terminalDescription}
              disabled
              className={cn(panelTabClassName, 'text-muted-foreground disabled:opacity-64')}
            >
              <SquareTerminal className="h-4 w-4" aria-hidden />
              Terminal
            </button>
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
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <EditorWorkspace projectId={project.id} writesLocked={writesLocked} />
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
              <RunPanel key={project.id} projectId={project.id} coordinator={coordinator} />
            </div>
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
  );
}
