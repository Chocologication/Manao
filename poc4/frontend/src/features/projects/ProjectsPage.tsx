import { DEFAULT_PROJECT_LIMIT } from '../../contracts/project';
import { LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ProjectSummary } from '../../contracts/project';
import { ApiRequestError } from '../../api/ApiRequestError';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { logout } from '../../app/appRuntime';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { useAuth } from '../auth/AuthProvider';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectCard } from './ProjectCard';
import { useDeleteProject, useProjectsQuery } from './projectQueries';

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
  const query = useProjectsQuery();
  const deletion = useDeleteProject();
  const [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);

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

  return (
    <AppChrome title="Projects">
      <CreateProjectForm locked={formLocked} limitReached={atLimit} />
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
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {query.data.items.map((project) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
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
    </AppChrome>
  );
}
