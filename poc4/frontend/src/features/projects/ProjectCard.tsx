import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectSummary } from '../../contracts/project';

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const titleId = `project-${project.id}-name`;

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-lg border bg-background p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-sm font-medium">
            {project.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.state === 'DELETING' ? 'Deleting' : project.state}
          </p>
          {project.state === 'FAILED' && project.failureReason ? (
            <p className="mt-2 text-sm text-destructive">{project.failureReason}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.state === 'CREATING' ? <Spinner /> : null}
          {project.state === 'READY' ? (
            <Button render={<Link to={`/projects/${encodeURIComponent(project.id)}`} />}>
              Open
            </Button>
          ) : null}
          {project.state === 'CREATING' ? (
            <Button type="button" disabled>
              Open
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
