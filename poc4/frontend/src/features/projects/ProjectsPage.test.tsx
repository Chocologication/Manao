import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { createProject, getProject } from '../../api/projectApi';
import { authSession, queryClient } from '../../app/appRuntime';
import type { ProjectListResponse, ProjectSummary } from '../../contracts/project';
import { server } from '../../mocks/node';
import {
  ALICE_SEED_PROJECT_ID,
  BOB_SEED_PROJECT_ID,
  MOCK_FAILURE_REASON,
} from '../../mocks/state';
import { renderApp, resetAppRuntime } from '../../test/renderApp';
import {
  projectDetailRefetchInterval,
  projectKeys,
  projectsRefetchInterval,
} from './projectQueries';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ACCESS_DENIED_LEAK = /not found|does not exist|bob|prj-bob|exist/i;

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function readyProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 'prj-x',
    name: 'Demo',
    state: 'READY',
    createdAt: '2026-08-21T00:00:00.000Z',
    failureReason: null,
    ...overrides,
  };
}

const THREE_PROJECTS: ProjectListResponse = {
  limit: 3,
  items: [
    readyProject({ id: 'prj-one', name: 'One' }),
    readyProject({ id: 'prj-two', name: 'Two', createdAt: '2026-08-21T00:00:01.000Z' }),
    readyProject({ id: 'prj-three', name: 'Three', createdAt: '2026-08-21T00:00:02.000Z' }),
  ],
};

function queryState<T>(data: T | undefined): { state: { data: T | undefined } } {
  return { state: { data } };
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('projectKeys and polling', () => {
  it('uses stable list and detail keys', () => {
    expect(projectKeys.all).toEqual(['projects']);
    expect(projectKeys.detail('prj-1')).toEqual(['projects', 'prj-1']);
  });

  it('polls every 1000ms only while a visible project is CREATING', () => {
    expect(projectsRefetchInterval(queryState(undefined))).toBe(false);
    expect(
      projectsRefetchInterval(
        queryState({ items: [readyProject({ id: 'prj-1' })], limit: 3 }),
      ),
    ).toBe(false);
    expect(
      projectsRefetchInterval(
        queryState({
          items: [
            readyProject({ id: 'prj-1' }),
            readyProject({ id: 'prj-2', name: 'Booting', state: 'CREATING' }),
          ],
          limit: 3,
        }),
      ),
    ).toBe(1000);
    expect(projectDetailRefetchInterval(queryState(undefined))).toBe(false);
    expect(
      projectDetailRefetchInterval(queryState(readyProject({ id: 'prj-1' }))),
    ).toBe(false);
    expect(
      projectDetailRefetchInterval(
        queryState(readyProject({ id: 'prj-1', state: 'CREATING' })),
      ),
    ).toBe(1000);
  });
});

describe('ProjectsPage', () => {
  it('shows a loading skeleton with stable dimensions', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects', async () => {
        await gate;
        return HttpResponse.json({ items: [], limit: 3 });
      }),
    );
    await authenticateAsAlice();
    renderApp();

    const skeleton = await screen.findByTestId('loading-state');
    const placeholders = skeleton.querySelectorAll(':scope > div');
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    for (const placeholder of placeholders) {
      expect(placeholder).toHaveClass('h-24');
      expect(placeholder).toHaveClass('w-full');
    }

    release();
  });

  it('shows an empty state and the create form', async () => {
    server.use(
      http.get('/api/v1/projects', () => HttpResponse.json({ items: [], limit: 3 })),
    );
    await authenticateAsAlice();
    renderApp();

    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('shows a CREATING card with a spinner and a disabled open action', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp();
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Project name'), 'Workspace Alpha');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    const card = await screen.findByRole('article', { name: 'Workspace Alpha' });
    expect(within(card).getByText('CREATING')).toBeInTheDocument();
    expect(within(card).getByTestId('spinner')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(card.parentElement?.closest('article')).toBeNull();
  });

  it('shows a READY card with an enabled open action', async () => {
    await authenticateAsAlice();
    renderApp();

    const card = await screen.findByRole('article', { name: 'Alice Notebook' });
    expect(within(card).getByText('READY')).toBeInTheDocument();
    const open = within(card).getByRole('link', { name: 'Open' });
    expect(open).toBeEnabled();
    expect(open).toHaveAttribute('href', `/projects/${ALICE_SEED_PROJECT_ID}`);
    expect(card.parentElement?.closest('article')).toBeNull();
  });

  it('shows a FAILED card with the backend reason and no open action', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp();
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Project name'), 'fail-demo');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    const card = await screen.findByRole('article', { name: 'fail-demo' });
    await waitFor(
      () => {
        expect(within(card).getByText(MOCK_FAILURE_REASON)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(within(card).getByText('FAILED')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('disables creation before submit when the list already has 3 projects', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/projects', () => HttpResponse.json(THREE_PROJECTS)));
    await authenticateAsAlice();
    renderApp();

    expect(await screen.findByRole('article', { name: 'One' })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /create project/i });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Project name'), 'Four');
    expect(submit).toBeDisabled();
  });

  it('handles 409 PROJECT_LIMIT_REACHED when creation is submitted anyway', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/projects', () =>
        HttpResponse.json(
          {
            code: 'PROJECT_LIMIT_REACHED',
            message: 'Project limit reached',
            traceId: 'mock-trace-project-limit',
          },
          { status: 409 },
        ),
      ),
    );
    await authenticateAsAlice();
    renderApp();
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Project name'), 'Bypass');
    await user.click(screen.getByRole('button', { name: /create project/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/project limit reached/i);
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('retries a list network failure without discarding auth', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/projects', () => HttpResponse.error()));
    await authenticateAsAlice();
    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent(/network request failed/i);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('retries a list 5xx without calling it a network failure', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/projects', () =>
        HttpResponse.json(
          {
            code: 'INTERNAL_ERROR',
            message: 'stack-trace-should-not-leak',
            traceId: 'mock-trace-list-internal',
          },
          { status: 500 },
        ),
      ),
    );
    await authenticateAsAlice();
    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unable to load projects/i);
    expect(alert).not.toHaveTextContent(/network request failed/i);
    expect(alert).not.toHaveTextContent('stack-trace-should-not-leak');
    expect(alert).not.toHaveTextContent('mock-trace-list-internal');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });
});

describe('ProjectRoutePage', () => {
  it('shows provisioning while CREATING', async () => {
    await authenticateAsAlice();
    const created = await createProject({ name: 'Pending shell' });
    server.use(
      http.get('/api/v1/projects/:projectId', () =>
        HttpResponse.json({
          ...created,
          state: 'CREATING',
          failureReason: null,
        }),
      ),
    );
    renderApp({ initialEntries: [`/projects/${created.id}`] });

    expect(await screen.findByText(/provisioning/i)).toBeInTheDocument();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows the backend reason and a back action when FAILED', async () => {
    await authenticateAsAlice();
    const created = await createProject({ name: 'fail-route' });
    await getProject(created.id);
    const failed = await getProject(created.id);
    expect(failed.state).toBe('FAILED');

    renderApp({ initialEntries: [`/projects/${created.id}`] });

    expect(await screen.findByText(MOCK_FAILURE_REASON)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to projects/i })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it('shows a quiet READY shell without Stage 0 terminal or files', async () => {
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });

    expect(await screen.findByRole('heading', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-spike-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/mock file tree/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-editor')).not.toBeInTheDocument();
  });

  it('shows the same generic access denied for another owner id and an unknown id', async () => {
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${BOB_SEED_PROJECT_ID}`] });

    const foreignAlert = await screen.findByRole('alert');
    expect(foreignAlert).toHaveTextContent(/access denied/i);
    expect(foreignAlert).not.toHaveTextContent(ACCESS_DENIED_LEAK);
    expect(screen.getByRole('link', { name: /back to projects/i })).toBeInTheDocument();
    const foreignCopy = foreignAlert.textContent;

    cleanup();
    resetAppRuntime();
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects/prj-does-not-exist'] });

    const unknownAlert = await screen.findByRole('alert');
    expect(unknownAlert).toHaveTextContent(/access denied/i);
    expect(unknownAlert).not.toHaveTextContent(ACCESS_DENIED_LEAK);
    expect(unknownAlert.textContent).toBe(foreignCopy);
  });

  it('shows a retryable local error for network failure on the project route', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    server.use(http.get('/api/v1/projects/:projectId', () => HttpResponse.error()));
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/network request failed/i);
    expect(alert).not.toHaveTextContent(/access denied/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /something went wrong/i })).not.toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByRole('heading', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('shows a retryable local error for 5xx on the project route, not access denied', async () => {
    await authenticateAsAlice();
    server.use(
      http.get('/api/v1/projects/:projectId', () =>
        HttpResponse.json(
          {
            code: 'INTERNAL_ERROR',
            message: 'stack-trace-should-not-leak',
            traceId: 'mock-trace-internal',
          },
          { status: 500 },
        ),
      ),
    );
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/access denied/i);
    expect(alert).not.toHaveTextContent('stack-trace-should-not-leak');
    expect(alert).not.toHaveTextContent('mock-trace-internal');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /something went wrong/i })).not.toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });
});
