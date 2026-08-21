import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { logout } from '../../app/appRuntime';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { useAuth } from '../auth/AuthProvider';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectCard } from './ProjectCard';
import { useProjectsQuery } from './projectQueries';

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function AppChrome({ title, children }: { title: string; children: ReactNode }) {
  const { snapshot } = useAuth();
  const username = snapshot.status === 'authenticated' ? snapshot.user.username : '';

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <span className="text-sm">{username}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Log out"
          onClick={() => logout()}
        >
          <LogOut />
        </Button>
      </header>
      <main className="flex flex-1 flex-col gap-4 px-6 py-5">
        <h1 className="text-lg font-medium">{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function ProjectsPage() {
  const query = useProjectsQuery();
  const listReady = query.data !== undefined;
  const limit = query.data?.limit ?? 3;
  const items = query.data?.items ?? [];
  const atLimit = listReady && items.length >= limit;
  const formLocked = !listReady || query.isError;

  return (
    <AppChrome title="Projects">
      <CreateProjectForm locked={formLocked} limitReached={atLimit} />
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
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {query.data.items.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
        </ul>
      ) : null}
    </AppChrome>
  );
}
