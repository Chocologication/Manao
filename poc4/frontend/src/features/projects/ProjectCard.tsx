import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectSummary } from '../../contracts/project';

export function ProjectCard({ project, onDelete, deleting = false, deleteDisabled = false }: {
  project: ProjectSummary;
  onDelete?(): void;
  deleting?: boolean;
  deleteDisabled?: boolean;
}) {
  const titleId = `project-${project.id}-name`;
  const runtime = project.runtime;
  // Selected dependencies report live readiness; never-selected ones stay ABSENT and hidden.
  const dependenciesLine = (
    [
      ['MySQL', project.dependencies?.mysql],
      ['Redis', project.dependencies?.redis],
    ] as const
  )
    .filter(([, state]) => state !== undefined && state !== 'ABSENT')
    .map(([name, state]) => `${name} ${state}`)
    .join(' · ');

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
          {runtime ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {runtime.templateId === 'java-spring-boot-web' ? 'Spring Boot web' : 'Console'}
              {runtime.mysql ? ' · MySQL' : ''}
              {runtime.redis ? ' · Redis' : ''}
              {runtime.publicPorts
                .map((port) => ` · ${port.targetPort}→${port.publicPort}`)
                .join('')}
            </p>
          ) : null}
          {dependenciesLine ? (
            <p className="mt-1 text-sm text-muted-foreground">{dependenciesLine}</p>
          ) : null}
          {project.endpointState === 'ASSIGNED' && (project.endpoints?.length ?? 0) > 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {project.endpoints
                ?.map((endpoint) =>
                  endpoint.url === null
                    ? `public ${endpoint.publicPort}`
                    : `${endpoint.publicPort}: ${endpoint.url}`,
                )
                .join(' · ')}
            </p>
          ) : null}
          {project.endpointState === 'UNKNOWN' ? (
            <p className="mt-1 text-sm text-muted-foreground">Public endpoint unconfirmed</p>
          ) : null}
          {project.state === 'DELETING' && !deleting ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Deletion has not completed. Continue deletion to finish releasing resources.
            </p>
          ) : null}
          {deleting ? <p role="status" className="mt-2 text-sm">Releasing project resources…</p> : null}
          {project.state === 'FAILED' && project.failureReason ? (
            <p className="mt-2 text-sm text-destructive">{project.failureReason}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onDelete ? (
            <Button
              variant="outline" className="text-destructive hover:text-destructive"
              disabled={deleteDisabled || deleting || project.state === 'CREATING'}
              onClick={onDelete}
            >
              {project.state === 'DELETING' ? 'Continue deletion' : 'Delete project'}
            </Button>
          ) : null}
          {project.state === 'CREATING' ? <Spinner /> : null}
          {project.state === 'READY' && !deleting ? (
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
