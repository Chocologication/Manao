import { ArrowLeft, FileCode, LogOut, Play, SquareTerminal } from 'lucide-react';
import { useCallback, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { logout } from '@/app/appRuntime';
import { EditorWorkspace } from '@/components/files/EditorWorkspace';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { ReadonlyFileTree } from '@/components/files/ReadonlyFileTree';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';
import {
  dismissUnsavedDialog,
  LEAVE_MESSAGE,
  requestLogout,
  requestUnsavedDialog,
  useDirtyBeforeUnload,
  useUnsavedDialogState,
} from '@/features/editor/unsavedChangesGuard';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { cn } from '@/lib/utils';

const EDITOR_REGION_ID = 'workbench-editor';

const panelTabClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

function skipToEditor(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  document.getElementById(EDITOR_REGION_ID)?.focus();
}

export function WorkbenchShell({ project }: { project: ProjectSummary }) {
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const leaveGuard = useUnsavedDialogState();
  useDirtyBeforeUnload(dirtyCount);

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
      <a href={`#${EDITOR_REGION_ID}`} className="skip-to-editor" onClick={skipToEditor}>
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
            <ReadonlyFileTree projectId={project.id} />
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
              aria-label="File"
              aria-selected={true}
              className={cn(panelTabClassName, 'bg-accent text-accent-foreground')}
            >
              <FileCode className="h-4 w-4" aria-hidden />
              File
            </button>
            <button
              type="button"
              role="tab"
              aria-label="Run"
              aria-selected={false}
              disabled
              className={cn(panelTabClassName, 'text-muted-foreground disabled:opacity-64')}
            >
              <Play className="h-4 w-4" aria-hidden />
              Run
            </button>
            <button
              type="button"
              role="tab"
              aria-label="Terminal"
              aria-selected={false}
              disabled
              className={cn(panelTabClassName, 'text-muted-foreground disabled:opacity-64')}
            >
              <SquareTerminal className="h-4 w-4" aria-hidden />
              Terminal
            </button>
          </div>
          <div
            id={EDITOR_REGION_ID}
            tabIndex={-1}
            aria-label="Editor"
            className="min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
          >
            <EditorWorkspace projectId={project.id} />
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
