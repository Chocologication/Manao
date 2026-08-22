import { Link, useParams } from 'react-router';
import { ApiRequestError } from '../../api/ApiRequestError';
import { AccessDeniedPage } from '@/components/feedback/AccessDeniedPage';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AppChrome } from './ProjectsPage';
import { useProjectQuery } from './projectQueries';

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
  const id = typeof projectId === 'string' ? projectId : '';
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
    <AppChrome title={project.name}>
      <p className="text-sm text-muted-foreground">{project.state}</p>
    </AppChrome>
  );
}
