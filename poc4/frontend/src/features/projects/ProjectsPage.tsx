import { DEFAULT_PROJECT_LIMIT } from '../../contracts/project';
import { LogOut, Plus, Search, FolderCode, Layers, CircleCheck, CircleAlert, X, LayoutGrid, List, Star } from 'lucide-react';
import { Brand } from '@/components/ui/Brand';
import { useRef, useState, type ReactNode } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { ProjectSummary } from '../../contracts/project';
import { ApiRequestError } from '../../api/ApiRequestError';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { logout } from '../../app/appRuntime';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { AccountPanel } from '@/components/shell/AccountPanel';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectCard } from './ProjectCard';
import { ProjectLatestRun } from './ProjectLatestRun';
import { useDeleteProject, useProjectsQuery } from './projectQueries';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProjectPreferences, type ProjectSort } from './projectPreferences';
import { useReducedMotion } from '@/features/preferences/motionPreferences';

gsap.registerPlugin(useGSAP);

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function AppChrome({ title, children }: { title: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  useGSAP(() => {
    if (reducedMotion) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.lab-page-heading, .lab-console-intro, .lab-summary-strip',
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0, duration: 0.55, stagger: 0.08, ease: 'power3.out' });
    });
    return () => media.revert();
  }, { scope: root, dependencies: [reducedMotion], revertOnUpdate: true });

  return (
    <div ref={root} className="lab-console flex min-h-full flex-col bg-background text-foreground">
      <header className="lab-app-header">
        <Brand />
        <span className="lab-header-section">项目控制台</span>
        <div className="lab-user"><AccountPanel onLogout={logout} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Log out"
          title="退出登录"
          onClick={() => logout()}
        >
          <LogOut />
        </Button>
        </div>
      </header>
      <main className="lab-console-main">
        <div className="lab-page-heading"><p className="lab-eyebrow">WORKSPACE / PROJECTS</p><h1>{title === 'Projects' ? '我的实验项目' : title}</h1></div>
        {children}
      </main>
    </div>
  );
}

function deletionErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.body?.code) {
      case 'RUN_ALREADY_ACTIVE': return 'Finish or stop the active Run before deleting this project.';
      case 'PROJECT_CREATING': return 'Wait for project creation to finish before deleting.';
      case 'PROJECT_BUSY': return 'Project is busy. Wait for the current operation to finish, then try again.';
      case 'PROJECT_CLEANUP_INCOMPLETE': return 'Cleanup is incomplete. The project is not deleted; use Continue deletion to try again.';
      default: return 'Unable to delete this project. Refresh the list to check its status.';
    }
  }
  return error instanceof Error && /^(Unable to confirm deletion|Deletion has not completed|Session changed)/.test(error.message)
    ? error.message
    : 'Deletion status is uncertain. Refresh the project list before trying again.';
}

export function ProjectsPage() {
  const gridRef = useRef<HTMLUListElement>(null);
  const reducedMotion = useReducedMotion();
  const query = useProjectsQuery();
  const deletion = useDeleteProject();
  const [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { snapshot } = useAuth();
  const userId = snapshot.status === 'authenticated' ? snapshot.user.id : '';
  const { value: preferences, update: updatePreferences } = useProjectPreferences(userId);

  async function performDelete(project: ProjectSummary) {
    if (deletion.isPending) return;
    setFeedback(null);
    try {
      await deletion.mutateAsync(project.id);
      setFeedback({ error: false, message: 'Project deleted.' });
    } catch (error) {
      setFeedback({ error: true, message: deletionErrorMessage(error) });
    } finally {
      setSelected(null);
    }
  }
  const listReady = query.data !== undefined;
  const limit = query.data?.limit ?? DEFAULT_PROJECT_LIMIT;
  const items = query.data?.items ?? [];
  const atLimit = listReady && items.length >= limit;
  const formLocked = !listReady || query.isError;
  const filteredItems = items.filter((project) =>
    `${project.name} ${project.id}`.toLowerCase().includes(search.trim().toLowerCase()) &&
    (stateFilter === 'ALL' || project.state === stateFilter) &&
    (!favoritesOnly || preferences.favorites.includes(project.id)),
  ).sort((left, right) => {
    if (preferences.sort === 'name') return left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
    if (preferences.sort === 'visited') {
      const difference = (preferences.visits[right.id] ?? 0) - (preferences.visits[left.id] ?? 0);
      if (difference) return difference;
    }
    return (Date.parse(right.createdAt) - Date.parse(left.createdAt)) * (preferences.sort === 'oldest' ? -1 : 1) || left.id.localeCompare(right.id);
  });
  const visibleIds = filteredItems.map((project) => project.id).join(',');
  useGSAP(() => {
    if (reducedMotion) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      if (!gridRef.current?.children.length) return;
      gsap.fromTo(gridRef.current.children, { opacity: 0, y: 26 },
        { opacity: 1, y: 0, duration: 0.58, stagger: 0.08, ease: 'power3.out' });
    });
    return () => media.revert();
  }, { scope: gridRef, dependencies: [visibleIds, reducedMotion], revertOnUpdate: true });

  return (
    <AppChrome title="Projects">
      <div className="lab-console-intro"><p>管理你的云端工作空间，专注每一次代码实验。</p><Button onClick={() => setCreateOpen(!createOpen)} aria-expanded={createOpen}><Plus />新建项目</Button></div>
      <div className="lab-summary-strip">
        <div><Layers /><span>实验项目<strong>{items.length}<small> / {limit}</small></strong></span></div>
        <div><CircleCheck /><span>环境就绪<strong>{items.filter((p) => p.state === 'READY').length}</strong></span></div>
        <div><CircleAlert /><span>需要关注<strong>{items.filter((p) => p.state === 'FAILED' || p.state === 'DELETING').length}</strong></span></div>
        <div className="lab-summary-note"><span className="lab-eyebrow">SUPPORTED RUNTIMES</span><strong>Java <span>/</span> Python</strong></div>
      </div>
      <section className="lab-create-region" hidden={!createOpen}><div className="lab-section-heading"><h2>创建实验项目</h2><Button variant="ghost" size="icon" title="收起创建表单" aria-label="收起创建表单" onClick={() => setCreateOpen(false)}><X /></Button></div><CreateProjectForm guided locked={formLocked} limitReached={atLimit} /></section>
      <div className="lab-project-toolbar"><label className="lab-search"><Search size={17} /><input aria-label="搜索项目" placeholder="搜索项目名称或编号…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><select aria-label="筛选项目状态" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}><option value="ALL">全部状态</option><option value="READY">环境就绪</option><option value="CREATING">创建中</option><option value="FAILED">失败</option><option value="DELETING">删除中</option></select><span>{filteredItems.length} 个项目</span></div>
      <div className="lab-project-view-toolbar"><label>排序<select aria-label="项目排序" value={preferences.sort} onChange={(event) => updatePreferences({ sort: event.target.value as ProjectSort })}><option value="newest">创建时间：最新优先</option><option value="oldest">创建时间：最早优先</option><option value="name">项目名称</option><option value="visited">最近访问</option></select></label><Button variant="ghost" size="icon" aria-label="只看收藏" title="只看收藏" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Star fill={favoritesOnly ? 'currentColor' : 'none'} /></Button><div role="group" aria-label="项目视图"><Button variant="ghost" size="icon" aria-label="网格视图" title="网格视图" aria-pressed={preferences.view === 'grid'} onClick={() => updatePreferences({ view: 'grid' })}><LayoutGrid /></Button><Button variant="ghost" size="icon" aria-label="列表视图" title="列表视图" aria-pressed={preferences.view === 'list'} onClick={() => updatePreferences({ view: 'list' })}><List /></Button></div></div>
      {feedback ? (feedback.error
        ? <InlineAlert>{feedback.message}</InlineAlert>
        : <p role="status" className="text-sm">{feedback.message}</p>) : null}
      {selected ? (
        <DeleteProjectDialog
          project={selected}
          pending={deletion.isPending}
          onConfirm={() => void performDelete(selected)}
          onCancel={() => setSelected(null)}
        />
      ) : null}
      {query.isPending ? <LoadingState label="Loading projects" /> : null}
      {query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <InlineAlert>
            {isNetworkError(query.error) ? 'Network request failed' : 'Unable to load projects'}
          </InlineAlert>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.data && query.data.items.length === 0 ? (
        <div className="lab-empty"><FolderCode size={40} /><h2>你的第一个实验，从这里开始</h2><p>创建 Java 或 Python 项目。</p><Button onClick={() => setCreateOpen(true)}><Plus />新建项目</Button></div>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <ul ref={gridRef} className="lab-project-grid" data-view={preferences.view}>
          {filteredItems.map((project) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
                favorite={preferences.favorites.includes(project.id)}
                lastVisited={preferences.visits[project.id]}
                onToggleFavorite={() => updatePreferences({ favorites: preferences.favorites.includes(project.id) ? preferences.favorites.filter((id) => id !== project.id) : [...preferences.favorites, project.id] })}
                runSummary={project.state === 'READY' ? <ProjectLatestRun projectId={project.id} /> : undefined}
                deleting={deletion.isPending && deletion.variables === project.id}
                deleteDisabled={query.isError || deletion.isPending}
                onDelete={() => {
                  setFeedback(null);
                  if (project.state === 'DELETING') void performDelete(project);
                  else setSelected(project);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 0 && filteredItems.length === 0 && <div className="lab-empty"><Search size={30} /><h2>没有匹配的项目</h2><Button variant="outline" onClick={() => { setSearch(''); setStateFilter('ALL'); setFavoritesOnly(false); }}>清除筛选</Button></div>}
      <footer className="lab-console-footer"><span>MANAO / CLOUD LAB</span><span>AI Coding Agent · 规划中</span></footer>
    </AppChrome>
  );
}
