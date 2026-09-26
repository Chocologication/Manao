import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import {
  generateOperationId,
  readPythonDependencyOperationId,
} from '../../api/pythonDependencyApi';
import { createProject, getProject } from '../../api/projectApi';
import { authSession, queryClient } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import type { ProjectSummary } from '../../contracts/project';
import { AppProviders } from '../../app/AppProviders';
import { useWorkspaceSession, workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import { getWorkspaceRevision as mockWorkspaceRevision } from '../../mocks/fileFixtures';
import { setDependencyScenario } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { PythonDependenciesPanel } from './PythonDependenciesPanel';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ALICE_USER_ID = 'usr-alice';

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function createReadyPythonProject(name: string): Promise<ProjectSummary> {
  const created = await createProject({
    name,
    templateId: 'python-console',
    mysql: false,
    redis: false,
    publicPorts: [],
  });
  // The mock flips CREATING to READY on the second owner read.
  await getProject(created.id);
  const ready = await getProject(created.id);
  expect(ready.state).toBe('READY');
  return ready;
}

function primeRevision(projectId: string): void {
  queryClient.setQueryData(
    fileKeys.revision(projectId),
    parseWorkspaceRevision(mockWorkspaceRevision(projectId)),
  );
}

type RecordedCall = { method: string; path: string; body: unknown };

function recordedDependencyCalls(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return spy.mock.calls.flatMap((call) => {
    const input = call[0];
    const init = call[1];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const method =
      typeof init === 'object' && init !== null && 'method' in init
        ? String((init as { method?: unknown }).method ?? 'GET').toUpperCase()
        : 'GET';
    if (!/\/python-dependencies/.test(url)) {
      return [];
    }
    let body: unknown = undefined;
    if (
      typeof init === 'object' &&
      init !== null &&
      'body' in init &&
      typeof (init as { body?: unknown }).body === 'string'
    ) {
      try {
        body = JSON.parse((init as { body: string }).body);
      } catch {
        body = null;
      }
    }
    return [{ method, path: new URL(url, 'http://localhost').pathname, body }];
  });
}

function dependencyPosts(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return recordedDependencyCalls(spy).filter(
    (call) => call.method === 'POST' && !call.path.endsWith('/reconcile'),
  );
}

function uuidLike(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function renderPanel(options: {
  project: ProjectSummary;
  workspaceLocked?: boolean;
  unconfirmedOperationId?: string | null;
  onResponseLost?: (operationId: string) => void;
}) {
  workspaceSessionStore.getState().activateProject(options.project.id);
  return render(
    <AppProviders>
      <MemoryRouter>
        <PythonDependenciesPanel
          projectId={options.project.id}
          userId={ALICE_USER_ID}
          workspaceLocked={options.workspaceLocked ?? false}
          unconfirmedOperationId={options.unconfirmedOperationId ?? null}
          onResponseLost={options.onResponseLost ?? (() => {})}
        />
      </MemoryRouter>
    </AppProviders>,
  );
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  packageName: string,
  version?: string,
): Promise<void> {
  await user.type(screen.getByLabelText('Package name'), packageName);
  if (version !== undefined) {
    await user.type(screen.getByLabelText('Version (optional)'), version);
  }
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('PythonDependenciesPanel form', () => {
  it('offers package name, optional version and ADD/REMOVE actions', async () => {
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Form Visible');
    primeRevision(project.id);
    renderPanel({ project });

    expect(screen.getByLabelText('Package name')).toBeEnabled();
    expect(screen.getByLabelText('Version (optional)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove dependency' })).toBeEnabled();
  });

  it('disables both actions while the workspace write gate is locked (active Run)', async () => {
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Locked Form');
    primeRevision(project.id);
    renderPanel({ project, workspaceLocked: true });

    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove dependency' })).toBeDisabled();
  });

  it('disables both actions while unsaved file changes exist', async () => {
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Dirty Form');
    primeRevision(project.id);
    renderPanel({ project });
    act(() => {
      useWorkspaceSession.getState().setDirty(parseProjectRelativePath('main.py'), true);
    });

    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove dependency' })).toBeDisabled();
  });

  it('disables both actions while another operation result is unconfirmed', async () => {
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Unconfirmed Form');
    primeRevision(project.id);
    renderPanel({
      project,
      unconfirmedOperationId: generateOperationId(),
    });

    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove dependency' })).toBeDisabled();
  });
});

describe('PythonDependenciesPanel committed changes', () => {
  it('sends one ADD with a fresh stored operation id, reloads the workspace and clears the stored id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Add httpx');
    primeRevision(project.id);
    renderPanel({ project });

    // The change must carry the revision the browser saw BEFORE the commit.
    const revisionBeforeChange = mockWorkspaceRevision(project.id);
    await fillForm(user, 'httpx', '0.28.1');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    const posts = dependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as Record<string, unknown>;
    expect(body.action).toBe('ADD');
    expect(body.packageName).toBe('httpx');
    expect(body.version).toBe('0.28.1');
    expect(body.expectedWorkspaceRevision).toBe(revisionBeforeChange);
    expect(uuidLike(body.operationId)).toBe(true);
    // The id was stored before the POST and removed after the reload completed.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    // The reload re-read the workspace through the file API.
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('/files/tree'))).toBe(true);

    fetchSpy.mockRestore();
  });

  it('sends REMOVE by package name only even when a version is typed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Remove httpx');
    primeRevision(project.id);
    renderPanel({ project });

    await fillForm(user, 'HTTPX', '0.28.1');
    await user.click(screen.getByRole('button', { name: 'Remove dependency' }));

    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    const posts = dependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as Record<string, unknown>;
    expect(body.action).toBe('REMOVE');
    expect(body.packageName).toBe('HTTPX');
    expect(body.version).toBeNull();

    fetchSpy.mockRestore();
  });
});

describe('PythonDependenciesPanel rejected changes', () => {
  it('shows the fixed rejection, clears the stored id and allows a corrected new operation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Rejected Change');
    primeRevision(project.id);
    setDependencyScenario('resolution-failed');
    renderPanel({ project });

    await fillForm(user, 'left-pad');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/dependency resolution failed/i);

    // An explicitly rejected POST has no side effects: the stored id is gone and a
    // corrected resubmission starts a NEW operation id.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();

    await user.clear(screen.getByLabelText('Package name'));
    await user.type(screen.getByLabelText('Package name'), 'left-pad');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));
    await screen.findByRole('alert');

    const posts = dependencyPosts(fetchSpy);
    expect(posts).toHaveLength(2);
    const firstId = (posts[0]!.body as Record<string, unknown>).operationId;
    const secondId = (posts[1]!.body as Record<string, unknown>).operationId;
    expect(firstId).not.toBe(secondId);

    setDependencyScenario('normal');
    fetchSpy.mockRestore();
  });
});

describe('PythonDependenciesPanel lost responses', () => {
  it('keeps the stored id and reports the lost response instead of retrying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Lost Response');
    primeRevision(project.id);
    setDependencyScenario('lost-response');
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await fillForm(user, 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    await waitFor(() => {
      expect(onResponseLost).toHaveBeenCalledTimes(1);
    });
    const posts = dependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const operationId = (posts[0]!.body as Record<string, unknown>).operationId;
    expect(onResponseLost).toHaveBeenCalledWith(operationId);
    // The result is unknown: the id stays available for the recovery check.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBe(operationId);
    // No automatic retry was sent.
    expect(dependencyPosts(fetchSpy)).toHaveLength(1);

    setDependencyScenario('normal');
    fetchSpy.mockRestore();
  });
});
