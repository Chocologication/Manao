import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { authSession, queryClient } from '../../app/appRuntime';
import type { ProjectSummary } from '../../contracts/project';
import { server } from '../../mocks/node';
import { renderApp, resetAppRuntime } from '../../test/renderApp';

const project: ProjectSummary = {
  id: 'delete-target', name: 'Delete me', state: 'READY',
  createdAt: '2026-09-16T00:00:00Z', failureReason: null,
};
let items: ProjectSummary[];
let deletes: number;
let listFails: boolean;

beforeEach(async () => {
  resetAppRuntime();
  items = [project, { ...project, id: 'keep', name: 'Keep me' }];
  deletes = 0;
  listFails = false;
  server.use(
    http.get('/api/v1/projects', () => listFails
      ? HttpResponse.error()
      : HttpResponse.json({ items, limit: 8 })),
    http.delete('/api/v1/projects/:projectId', ({ params }) => {
      deletes++;
      items = items.filter((item) => item.id !== params.projectId);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  authSession.authenticate(await login({ username: 'alice', password: 'demo-pass' }));
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

async function openDelete() {
  const user = userEvent.setup();
  const card = await screen.findByRole('article', { name: 'Delete me' });
  await user.click(within(card).getByRole('button', { name: 'Delete project' }));
  return user;
}
async function confirmDelete() {
  const user = await openDelete();
  const dialog = screen.getByRole('alertdialog', { name: 'Delete project?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  return user;
}
function apiError(code: string, status: number) {
  return HttpResponse.json({ code, message: 'safe error', traceId: 'test' }, { status });
}

describe('user project deletion', () => {
  it('requires confirmation and cancellation has no side effects', async () => {
    renderApp();
    const user = await openDelete();
    const dialog = screen.getByRole('alertdialog', { name: 'Delete project?' });
    expect(within(dialog).getByText(/files, run history and logs/i)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletes).toBe(0);
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
  });

  it('keeps the card while DELETE is pending and only clears the target cache after reconciliation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.delete('/api/v1/projects/:projectId', async () => {
      deletes++;
      await gate;
      items = items.filter((item) => item.id !== project.id);
      return new HttpResponse(null, { status: 204 });
    }));
    queryClient.setQueryData(['project-files', project.id, 'tree'], ['old-file']);
    queryClient.setQueryData(['project-runs', project.id, 'history'], ['old-run']);
    queryClient.setQueryData(['terminal-audits', project.id, 'run'], ['old-audit']);
    queryClient.setQueryData(['project-files', 'keep', 'tree'], ['keep-file']);
    renderApp();
    await confirmDelete();
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    release();
    expect(await screen.findByText('Project deleted.')).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Delete me' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Keep me' })).toBeVisible();
    expect(queryClient.getQueryData(['project-files', project.id, 'tree'])).toBeUndefined();
    expect(queryClient.getQueryData(['project-runs', project.id, 'history'])).toBeUndefined();
    expect(queryClient.getQueryData(['terminal-audits', project.id, 'run'])).toBeUndefined();
    expect(queryClient.getQueryData(['project-files', 'keep', 'tree'])).toEqual(['keep-file']);
    expect(deletes).toBe(1);
  });

  it('does not offer deletion during creation', async () => {
    items[0] = { ...project, state: 'CREATING' };
    renderApp();
    const card = await screen.findByRole('article', { name: 'Delete me' });
    expect(within(card).getByRole('button', { name: 'Delete project' })).toBeDisabled();
    expect(deletes).toBe(0);
  });

  it('keeps the project and explains an active Run conflict', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => {
      deletes++;
      return apiError('RUN_ALREADY_ACTIVE', 409);
    }));
    renderApp();
    await confirmDelete();
    expect(await screen.findByText(/finish or stop the active run/i)).toBeVisible();
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  it('retains incomplete deletion and resumes only on an explicit click', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => {
      deletes++;
      if (deletes === 1) {
        items[0] = { ...project, state: 'DELETING' };
        return apiError('PROJECT_CLEANUP_INCOMPLETE', 503);
      }
      items = items.filter((item) => item.id !== project.id);
      return new HttpResponse(null, { status: 204 });
    }));
    renderApp();
    const user = await confirmDelete();
    const resume = await screen.findByRole('button', { name: 'Continue deletion' });
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
    expect(deletes).toBe(1);
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
    await user.click(resume);
    expect(await screen.findByText('Project deleted.')).toBeVisible();
    expect(deletes).toBe(2);
  });

  it('offers explicit continuation for a DELETING project after a page reload', async () => {
    items[0] = { ...project, state: 'DELETING' };
    renderApp();
    const resume = await screen.findByRole('button', { name: 'Continue deletion' });
    expect(resume).toBeEnabled();
    expect(screen.getByText(/deletion has not completed/i)).toBeVisible();
    expect(deletes).toBe(0);
  });

  it('reconciles a lost success response with a read instead of replaying DELETE', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => {
      deletes++;
      items = items.filter((item) => item.id !== project.id);
      return HttpResponse.error();
    }));
    renderApp();
    await confirmDelete();
    expect(await screen.findByText('Project deleted.')).toBeVisible();
    expect(deletes).toBe(1);
  });

  it('does not remove cached project or report success if state confirmation fails', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => {
      deletes++;
      listFails = true;
      return new HttpResponse(null, { status: 204 });
    }));
    renderApp();
    await confirmDelete();
    expect(await screen.findByText(/unable to confirm deletion/i)).toBeVisible();
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  it('does not treat a 204 with a still-present project as reconciled deletion', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => {
      deletes++;
      return new HttpResponse(null, { status: 204 });
    }));
    renderApp();
    await confirmDelete();
    expect(await screen.findByText(/deletion has not completed/i)).toBeVisible();
    expect(screen.getByRole('article', { name: 'Delete me' })).toBeVisible();
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
  });

  it('treats an authentication failure as authentication failure, never successful deletion', async () => {
    server.use(http.delete('/api/v1/projects/:projectId', () => apiError('UNAUTHENTICATED', 401)));
    renderApp();
    await confirmDelete();
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeVisible());
    expect(screen.queryByText('Project deleted.')).not.toBeInTheDocument();
  });
  it('works with the shipped mock API rather than only test-specific handlers', async () => {
    server.resetHandlers();
    renderApp();
    const card = await screen.findByRole('article', { name: 'Alice Notebook' });
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Delete project' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText('Project deleted.')).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Alice Notebook' })).not.toBeInTheDocument();
  });

});
