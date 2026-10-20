import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { ArrowUpRight, Code2, Database, Trash2, Eye, Star } from 'lucide-react';
import { formatLabDate } from '@/components/ui/labPresentation';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  isPythonDependencyRecoveryFailure,
} from '@/features/dependencies/PythonDependencyRecovery';
import { RUNTIME_TEMPLATE_META } from '../../contracts/project';
import type { ProjectSummary } from '../../contracts/project';

export function ProjectCard({ project, onDelete, deleting = false, deleteDisabled = false, runSummary, favorite = false, onToggleFavorite, lastVisited }: {
  project: ProjectSummary;
  onDelete?(): void;
  deleting?: boolean;
  deleteDisabled?: boolean;
  runSummary?: ReactNode;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  lastVisited?: number;
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
      className="lab-project-card"
    >
      <div className="lab-project-card-body">
        <span className="lab-project-icon"><Code2 size={23} /></span>
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-base font-medium">
            {project.name}
          </h2>
          <p className="lab-project-state" data-state={project.state}>
            <span />{{ READY: '环境就绪', CREATING: '正在创建', FAILED: '创建失败', DELETING: '正在删除' }[project.state] ?? project.state}
          </p>
          {runtime ? (
            <p className="lab-runtime-line">
              {RUNTIME_TEMPLATE_META[runtime.templateId].label}
              {runtime.mysql ? ' · MySQL' : ''}
              {runtime.redis ? ' · Redis' : ''}
              {runtime.publicPorts
                .map((port) => ` · ${port.targetPort}→${port.publicPort}`)
                .join('')}
            </p>
          ) : <p className="lab-runtime-line">Java console · 默认环境</p>}
          {dependenciesLine ? (
            <p className="lab-dependency-line"><Database size={13} />{dependenciesLine}</p>
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
          {lastVisited ? <p className="lab-project-visited">最近访问：{formatLabDate(new Date(lastVisited).toISOString())}</p> : null}
          {project.state === 'FAILED' && project.failureReason ? (
            <p className="mt-2 text-sm text-destructive">{project.failureReason}</p>
          ) : null}
        </div>
        {runSummary}
        <div className="lab-card-actions">
          {onToggleFavorite && <Button variant="ghost" size="icon" title={favorite ? '取消收藏' : '收藏项目'} aria-label={favorite ? '取消收藏' : '收藏项目'} aria-pressed={favorite} onClick={onToggleFavorite}><Star fill={favorite ? 'currentColor' : 'none'} /></Button>}
          {project.state === 'READY' && <Button variant="ghost" size="icon" render={<Link to={`/projects/${encodeURIComponent(project.id)}/overview`} />} title="项目概览" aria-label="项目概览"><Eye /></Button>}
          {onDelete ? (
            <Button
              variant="ghost" size="icon" className="text-destructive hover:text-destructive"
              aria-label={project.state === 'DELETING' ? 'Continue deletion' : 'Delete project'}
              title={project.state === 'DELETING' ? '继续删除' : '删除项目'}
              disabled={deleteDisabled || deleting || project.state === 'CREATING'}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          ) : null}
          {project.state === 'CREATING' ? <Spinner /> : null}
          {isPythonDependencyRecoveryFailure(project) ? (
            <Button
              render={<Link to={`/projects/${encodeURIComponent(project.id)}`} />}
              variant="outline"
            >
              Check dependency change
            </Button>
          ) : null}
          {project.state === 'READY' && !deleting ? (
            <Button aria-label="Open" render={<Link to={`/projects/${encodeURIComponent(project.id)}`} />}>
              <ArrowUpRight />进入工作台
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
