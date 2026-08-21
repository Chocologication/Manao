import { Link, useParams } from 'react-router';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { Spinner } from '@/components/ui/spinner';
import { AppChrome } from './ProjectsPage';
import { useProjectQuery } from './projectQueries';

const ACCESS_DENIED_MESSAGE = 'Access denied';

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

  if (query.isError || query.data === undefined) {
    return (
      <AppChrome title="Project">
        <InlineAlert>{ACCESS_DENIED_MESSAGE}</InlineAlert>
        <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
          Back to projects
        </Link>
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
