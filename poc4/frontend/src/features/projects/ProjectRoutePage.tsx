import { lazy, Suspense, useEffect } from 'react';
import { Link, useParams, useLocation } from 'react-router';
import { ProjectOverview } from './ProjectOverview';
import { RunCompare } from './RunCompare';
import { ApiRequestError } from '../../api/ApiRequestError';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import { AccessDeniedPage } from '@/components/feedback/AccessDeniedPage';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { UnsavedChangesDialog } from '@/components/files/UnsavedChangesDialog';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/contracts/project';
import { Spinner } from '@/components/ui/spinner';
import { StudioRecovery } from '@/features/ai/studio/StudioRecovery';
import {
  isPythonDependencyRecoveryFailure,
  PythonDependencyRecovery,
} from '@/features/dependencies/PythonDependencyRecovery';
import {
  dismissUnsavedDialog,
  getUnsavedDialogState,
  LEAVE_MESSAGE,
  requestUnsavedDialog,
  useUnsavedDialogState,
  useWorkbenchLeaveBlocker,
} from '@/features/editor/unsavedChangesGuard';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { useAuth } from '../auth/AuthProvider';
import { AppChrome } from './ProjectsPage';
import { useProjectQuery } from './projectQueries';
import { markProjectVisited } from './projectPreferences';

const WorkbenchPage = lazy(() => import('./WorkbenchPage'));

function WorkbenchRoute({ project }: { project: ProjectSummary }) {
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const blocker = useWorkbenchLeaveBlocker(dirtyCount);
  const dialog = useUnsavedDialogState();

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      return;
    }
    const current = getUnsavedDialogState();
    if (current.open && current.action.type === 'leave-workbench') {
      return;
    }
    const result = requestUnsavedDialog({
      open: true,
      mode: 'leave',
      action: { type: 'leave-workbench' },
      message: LEAVE_MESSAGE,
    });
    if (result === 'busy') {
      blocker.reset();
    }
  }, [blocker]);

  function handleCancel(): void {
    if (blocker.state === 'blocked') {
      blocker.reset();
    }
    dismissUnsavedDialog();
  }

  function handleDiscard(): void {
    const session = useWorkspaceSession.getState();
    for (const path of [...session.dirtyPaths]) {
      workspaceBufferRegistry.get(project.id, path)?.discard();
    }
    dismissUnsavedDialog();
    if (blocker.state === 'blocked') {
      blocker.proceed();
    }
  }

  return (
    <>
      <WorkbenchPage project={project} />
      <UnsavedChangesDialog
        open={dialog.open && dialog.action.type === 'leave-workbench'}
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

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function ProjectRoutePage() {
  const location = useLocation();
  const { projectId } = useParams();
  const id = decodeProjectId(typeof projectId === 'string' ? projectId : undefined);
  const { snapshot } = useAuth();
  const userId = snapshot.status === 'authenticated' ? snapshot.user.id : '';
  const query = useProjectQuery(id);
  useEffect(() => {
    if (query.data?.state === 'READY' && !query.isError) markProjectVisited(userId, id);
  }, [id, userId, query.data?.state, query.isError]);

  if (query.isPending) {
    return (
      <AppChrome title="项目">
        <LoadingState label="正在加载项目" />
      </AppChrome>
    );
  }

  if (query.isError && isForbiddenError(query.error)) {
    return (
      <AppChrome title="项目">
        <AccessDeniedPage />
      </AppChrome>
    );
  }

  // A missing project must keep its real semantics even when cached data is
  // still around; it must not be shown as a normal workbench.
  if (query.isError && isNotFoundError(query.error)) {
    return (
      <AppChrome title="项目">
        <div className="flex flex-col items-start gap-2">
          <InlineAlert>项目已不可用</InlineAlert>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
          <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
            返回项目列表
          </Link>
        </div>
      </AppChrome>
    );
  }

  if (query.data === undefined) {
    if (query.isError) {
      const message = isNetworkError(query.error)
        ? '网络请求失败，请检查连接后重试'
        : '无法加载项目';

      return (
        <AppChrome title="项目">
          <div className="flex flex-col items-start gap-2">
            <InlineAlert>{message}</InlineAlert>
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        </AppChrome>
      );
    }

    return (
      <AppChrome title="项目">
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
          <p>正在准备工作区</p>
        </div>
      </AppChrome>
    );
  }

  if (project.state === 'FAILED') {
    return (
      <AppChrome title={project.name}>
        <InlineAlert>{project.failureReason ?? '项目创建失败'}</InlineAlert>
        {import.meta.env.VITE_ENABLE_AI === 'true' && project.failureReason === 'WORKSPACE_RECONCILIATION_REQUIRED' && <StudioRecovery userId={userId} projectId={project.id} onRecovered={() => void query.refetch()} />}
        {isPythonDependencyRecoveryFailure(project) ? (
          <PythonDependencyRecovery
            projectId={project.id}
            userId={userId}
            variant="failed"
            onRecovered={() => void query.refetch()}
          />
        ) : null}
        <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
          返回项目列表
        </Link>
      </AppChrome>
    );
  }

  if (project.state === 'DELETING') {
    return (
      <AppChrome title={project.name}>
        <div role="status" className="text-sm text-muted-foreground">
          项目尚未删除完成，请返回项目列表继续处理。
        </div>
        <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
          返回项目列表
        </Link>
      </AppChrome>
    );
  }

  if (project.state !== 'READY') {
    return (
      <AppChrome title={project.name}>
        <InlineAlert>项目不可用</InlineAlert>
        <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
          返回项目列表
        </Link>
      </AppChrome>
    );
  }

  if (location.pathname.endsWith('/overview')) return <ProjectOverview project={project} />;
  if (location.pathname.endsWith('/compare')) return <RunCompare project={project} />;

  // A failed background refresh keeps the workbench mounted with a local,
  // actionable hint instead of a full-page error. The hint appears once the
  // bounded PROJECT_BUSY retries are exhausted (no fetch in flight); during the
  // retry window the existing interface stays untouched. The conditional slot
  // stays ahead of the Suspense boundary so the workbench is never remounted
  // when the hint appears or disappears.
  return (
    <>
      {query.isError && !query.isFetching ? (
        <div className="flex flex-col items-start gap-2 border-b bg-background px-4 py-2">
          <InlineAlert>项目状态更新失败</InlineAlert>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div role="status" aria-label="正在加载工作台" className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <WorkbenchRoute project={project} />
      </Suspense>
    </>
  );
}
