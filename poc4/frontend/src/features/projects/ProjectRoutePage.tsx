import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiRequestError } from '../../api/ApiRequestError';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import { AccessDeniedPage } from '@/components/feedback/AccessDeniedPage';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';
import { Spinner } from '@/components/ui/spinner';
import {
  LEAVE_MESSAGE,
  useWorkbenchLeaveBlocker,
} from '@/features/editor/unsavedChangesGuard';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { AppChrome } from './ProjectsPage';
import { useProjectQuery } from './projectQueries';

const ReadonlyWorkbenchPage = lazy(() => import('./ReadonlyWorkbenchPage'));

function WorkbenchRoute({ project }: { project: ProjectSummary }) {
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const blocker = useWorkbenchLeaveBlocker(dirtyCount);
  const [leaveOpen, setLeaveOpen] = useState(false);

  useEffect(() => {
    if (blocker.state === 'blocked') {
      setLeaveOpen(true);
      return;
    }
    if (blocker.state === 'unblocked') {
      setLeaveOpen(false);
    }
  }, [blocker.state]);

  function handleCancel(): void {
    if (blocker.state === 'blocked') {
      blocker.reset();
    }
    setLeaveOpen(false);
  }

  function handleDiscard(): void {
    const session = useWorkspaceSession.getState();
    for (const path of [...session.dirtyPaths]) {
      workspaceBufferRegistry.get(project.id, path)?.discard();
    }
    setLeaveOpen(false);
    if (blocker.state === 'blocked') {
      blocker.proceed();
    }
  }

  return (
    <>
      <ReadonlyWorkbenchPage project={project} />
      <UnsavedChangesDialog
        open={leaveOpen}
        mode="leave"
        message={LEAVE_MESSAGE}
        onDiscard={handleDiscard}
        onCancel={handleCancel}
      />
    </>
  );
}

function decodeProjectId(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    return '';
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isForbiddenError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 403 || error.body?.code === 'FORBIDDEN')
  );
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function ProjectRoutePage() {
  const { projectId } = useParams();
  const id = decodeProjectId(typeof projectId === 'string' ? projectId : undefined);
  const query = useProjectQuery(id);

  if (query.isPending) {
    return (
      <AppChrome title="Project">
        <LoadingState label="Loading project" />
      </AppChrome>
    );
  }

  if (query.isError) {
    if (isForbiddenError(query.error)) {
      return (
        <AppChrome title="Project">
          <AccessDeniedPage />
        </AppChrome>
      );
    }

    const message = isNetworkError(query.error)
      ? 'Network request failed'
      : 'Unable to load project';

    return (
      <AppChrome title="Project">
        <div className="flex flex-col items-start gap-2">
          <InlineAlert>{message}</InlineAlert>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      </AppChrome>
    );
  }

  if (query.data === undefined) {
    return (
      <AppChrome title="Project">
        <AccessDeniedPage />
      </AppChrome>
    );
  }

  const project = query.data;

  if (project.state === 'CREATING') {
    return (
      <AppChrome title={project.name}>
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          <p>Provisioning workspace</p>
        </div>
      </AppChrome>
    );
  }

  if (project.state === 'FAILED') {
    return (
      <AppChrome title={project.name}>
        <InlineAlert>{project.failureReason ?? 'Project creation failed'}</InlineAlert>
        <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
          Back to projects
        </Link>
      </AppChrome>
    );
  }

  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading workbench" className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <WorkbenchRoute project={project} />
    </Suspense>
  );
}
