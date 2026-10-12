import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import {
  changePythonDependencyBatch,
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
import {
  createMockEntry,
  getWorkspaceRevision as mockWorkspaceRevision,
  saveMockFile,
} from '../../mocks/fileFixtures';
import { server } from '../../mocks/node';
import { getFileRequestCount, setDependencyScenario } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { PythonDependencyRecovery } from './PythonDependencyRecovery';
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

function batchDependencyPosts(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return dependencyPosts(spy).filter((call) => call.path.endsWith('/python-dependencies/batch'));
}

function singleDependencyPosts(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return dependencyPosts(spy).filter((call) => !call.path.endsWith('/python-dependencies/batch'));
}

function treeGetCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => String(call[0]).includes('/files/tree')).length;
}

function seedRootRequirements(projectId: string, content: string): void {
  const created = createMockEntry(projectId, 'file', 'requirements.txt');
  if (!created.ok) {
    throw new Error('test fixture cannot create requirements.txt');
  }
  const saved = saveMockFile(projectId, 'requirements.txt', content);
  if (!saved.ok) {
    throw new Error('test fixture cannot save requirements.txt');
  }
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
  onBusyChange?: (busy: boolean) => void;
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
          onBusyChange={options.onBusyChange}
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
  it('answers PROJECT_LOCKED as a proven pre-flight rejection: id cleared, Run message, no recovery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Pre-flight Lock');
    primeRevision(project.id);
    // The backend's active-Run gate refuses before any operation row is registered:
    // nothing was applied for the request, so the answer stays the pre-flight lock.
    server.use(
      http.post('/api/v1/projects/:projectId/python-dependencies', () =>
        HttpResponse.json(
          { code: 'PROJECT_LOCKED', message: 'Project is locked', traceId: 'mock-trace-locked' },
          { status: 409 },
        ),
      ),
    );
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await fillForm(user, 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Finish or stop the active Run before changing dependencies.');
    // A proven no-side-effect rejection never reports a lost response and removes
    // the stored id, so a corrected change may start a NEW operation.
    expect(onResponseLost).not.toHaveBeenCalled();
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();

    fetchSpy.mockRestore();
  });

  it('answers PYTHON_DEPENDENCY_NO_WHEEL as a proven no-side-effect rejection with the fixed wheel message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('No Wheel');
    primeRevision(project.id);
    // The helper's installability verification rejects the change before any journal or
    // operation row exists: a proven no-side-effect answer, so the stored id is removed and
    // a corrected change may start a NEW operation.
    server.use(
      http.post('/api/v1/projects/:projectId/python-dependencies', () =>
        HttpResponse.json(
          {
            code: 'PYTHON_DEPENDENCY_NO_WHEEL',
            message: 'No compatible wheel is available for the requested package or version.',
            traceId: 'mock-trace-no-wheel',
          },
          { status: 422 },
        ),
      ),
    );
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await fillForm(user, 'pywin32', '312');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'No compatible wheel is available for the requested package or version.',
    );
    expect(onResponseLost).not.toHaveBeenCalled();
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();

    fetchSpy.mockRestore();
  });

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

  it('answers WORKSPACE_RECONCILIATION_REQUIRED as an unknown result: id kept, recovery reported, fixed message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Reconciliation Required');
    primeRevision(project.id);
    // The mock registers the operation PENDING and refuses to confirm the result,
    // like the backend's fail-closed commit scene.
    setDependencyScenario('reconciliation-required');
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await fillForm(user, 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // The result is unknown: the recovery entry engages and the message never
    // tells the user to stop a Run.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The result of the dependency change is unknown. Check it before making another change.',
    );
    expect(alert).not.toHaveTextContent(/stop the/i);
    const posts = dependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const operationId = (posts[0]!.body as Record<string, unknown>).operationId;
    expect(onResponseLost).toHaveBeenCalledTimes(1);
    expect(onResponseLost).toHaveBeenCalledWith(operationId);
    // The id stays available for the recovery check.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBe(operationId);
    // No automatic retry was sent.
    expect(dependencyPosts(fetchSpy)).toHaveLength(1);

    setDependencyScenario('normal');
    fetchSpy.mockRestore();
  });
});

describe('PythonDependenciesPanel busy reporting', () => {
  it('reports busy while the change is in flight and idle again after a safe rejection', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/projects/:projectId/python-dependencies', async () => {
        await held;
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Busy Rejection');
    primeRevision(project.id);
    const onBusyChange = vi.fn();
    renderPanel({ project, onBusyChange });

    await fillForm(user, 'left-pad');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
    });

    // A proven no-side-effect rejection returns the phase to idle.
    setDependencyScenario('resolution-failed');
    release();
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/dependency resolution failed/i);

    setDependencyScenario('normal');
  });

  it('stays busy through the workspace reload and reports idle only after it completes', async () => {
    const user = userEvent.setup();
    let holdTree = false;
    let releaseTree = () => {};
    const heldTree = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (holdTree && path === '') {
          await heldTree;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Busy Reload');
    primeRevision(project.id);
    const onBusyChange = vi.fn();
    renderPanel({ project, onBusyChange });

    holdTree = true;
    await fillForm(user, 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // The commit succeeded; the reload of the workspace is still in flight.
    await screen.findByText('Reloading workspace');
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    releaseTree();
    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });
  });
});

describe('PythonDependenciesPanel requirements.txt import', () => {
  it('reads the fixed root requirements.txt and submits exactly one batch POST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import One Batch');
    const requirementsText = 'httpx==0.28.1\nleft-pad\n';
    seedRootRequirements(project.id, requirementsText);
    primeRevision(project.id);
    renderPanel({ project });

    // The change must carry the revision the file read saw BEFORE the commit.
    const revisionBeforeImport = mockWorkspaceRevision(project.id);
    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    const posts = batchDependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as Record<string, unknown>;
    expect(uuidLike(body.operationId)).toBe(true);
    // The file content goes to the batch API verbatim, never split or parsed.
    expect(body.requirementsText).toBe(requirementsText);
    expect(body.expectedWorkspaceRevision).toBe(revisionBeforeImport);
    // The read targeted the fixed project-root path, exactly once.
    expect(getFileRequestCount('content', project.id, 'requirements.txt')).toBe(1);
    expect(singleDependencyPosts(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('imports a three-line file as one batch POST and never per-line single-package POSTs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Three Lines');
    seedRootRequirements(project.id, 'httpx==0.28.1\nleft-pad\nrich==13.0.0\n');
    primeRevision(project.id);
    renderPanel({ project });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);
    expect(singleDependencyPosts(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('reloads the workspace exactly once and clears the stored id after a committed import', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Reload');
    seedRootRequirements(project.id, 'httpx\n');
    primeRevision(project.id);
    renderPanel({ project });
    const treeCallsBefore = treeGetCount(fetchSpy);

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    // One committed batch means ONE managed workspace reload.
    expect(treeGetCount(fetchSpy) - treeCallsBefore).toBe(1);
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();

    fetchSpy.mockRestore();
  });

  it('keeps the stored id and reports the lost response instead of retrying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Lost Response');
    seedRootRequirements(project.id, 'httpx\n');
    primeRevision(project.id);
    setDependencyScenario('lost-response');
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    await waitFor(() => {
      expect(onResponseLost).toHaveBeenCalledTimes(1);
    });
    const posts = batchDependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const operationId = (posts[0]!.body as Record<string, unknown>).operationId;
    expect(onResponseLost).toHaveBeenCalledWith(operationId);
    // The result is unknown: the id stays available for the recovery check.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBe(operationId);
    // No automatic retry was sent.
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);

    setDependencyScenario('normal');
    fetchSpy.mockRestore();
  });

  it('answers a retry of the SAME batch operation with the original COMMITTED result, not a revision conflict', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Registered First');
    const requirementsText = 'httpx\n';
    seedRootRequirements(project.id, requirementsText);
    primeRevision(project.id);
    renderPanel({ project });

    const revisionBeforeImport = mockWorkspaceRevision(project.id);
    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));
    expect(
      await screen.findByRole('status', { name: 'Dependency change result' }),
    ).toHaveTextContent('Dependency change saved.');
    // The commit advanced the workspace revision...
    const revisionAfterCommit = mockWorkspaceRevision(project.id);
    expect(revisionAfterCommit).not.toBe(revisionBeforeImport);
    const operationId = (batchDependencyPosts(fetchSpy)[0]!.body as Record<string, unknown>)
      .operationId as string;

    // ...and the response was "lost". The registered-first contract: the SAME
    // operation id with the SAME request — carrying the ORIGINAL, now stale
    // revision — re-POSTed directly returns the original durable COMMITTED result
    // instead of judging the stale revision.
    const retry = await changePythonDependencyBatch(project.id, {
      operationId,
      requirementsText,
      expectedWorkspaceRevision: revisionBeforeImport,
    });
    expect(retry.state).toBe('COMMITTED');
    expect(retry.operationId).toBe(operationId);
    expect(retry.resultWorkspaceRevision).toBe(revisionAfterCommit);
    // The retry did not commit a second time: the revision did not move.
    expect(mockWorkspaceRevision(project.id)).toBe(revisionAfterCommit);
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(2);

    fetchSpy.mockRestore();
  });

  it('answers PROJECT_BUSY as a proven pre-flight rejection: id cleared, busy message, no recovery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Busy');
    seedRootRequirements(project.id, 'httpx\n');
    primeRevision(project.id);
    // The backend lease gate refuses before any operation row is registered:
    // the same proven no-side-effect semantics as the single-package change.
    server.use(
      http.post('/api/v1/projects/:projectId/python-dependencies/batch', () =>
        HttpResponse.json(
          { code: 'PROJECT_BUSY', message: 'Project is busy', traceId: 'mock-trace-busy' },
          { status: 409 },
        ),
      ),
    );
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Project is busy. Wait for the current operation to finish, then try again.',
    );
    expect(onResponseLost).not.toHaveBeenCalled();
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import requirements.txt' })).toBeEnabled();

    fetchSpy.mockRestore();
  });

  it('answers WORKSPACE_RECONCILIATION_REQUIRED as an unknown result: id kept, recovery reported', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Reconciliation');
    seedRootRequirements(project.id, 'httpx\n');
    primeRevision(project.id);
    // The mock registers the batch operation PENDING and refuses to confirm the
    // result, like the backend's fail-closed commit scene.
    setDependencyScenario('reconciliation-required');
    const onResponseLost = vi.fn();
    renderPanel({ project, onResponseLost });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The result of the dependency change is unknown. Check it before making another change.',
    );
    const posts = batchDependencyPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const operationId = (posts[0]!.body as Record<string, unknown>).operationId;
    expect(onResponseLost).toHaveBeenCalledTimes(1);
    expect(onResponseLost).toHaveBeenCalledWith(operationId);
    // The id stays available for the recovery check.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBe(operationId);
    // No automatic retry was sent.
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);

    // The failed project's recovery entry checks the SAME stored batch operation: the
    // original id drives the status GET and the reconcile, and it is never replaced
    // while the result is unconfirmed.
    const onRecovered = vi.fn();
    render(
      <PythonDependencyRecovery
        projectId={project.id}
        userId={ALICE_USER_ID}
        variant="failed"
        onRecovered={onRecovered}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    expect(recordedDependencyCalls(fetchSpy).filter((call) => call.method === 'GET' || call.path.endsWith('/reconcile'))).toEqual([
      {
        method: 'GET',
        path: `/api/v1/projects/${project.id}/python-dependencies/${operationId}`,
        body: undefined,
      },
      {
        method: 'POST',
        path: `/api/v1/projects/${project.id}/python-dependencies/${operationId}/reconcile`,
        body: undefined,
      },
    ]);
    // Only the confirmed COMMITTED result cleared the stored id.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();

    setDependencyScenario('normal');
    fetchSpy.mockRestore();
  });

  it('surfaces the backend validation rejection for a requirements.txt over the line limit without fabricating success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Over Limit');
    // 51 requirement lines exceed the backend's cap of 50; the browser sends the text
    // verbatim and the backend answers the fixed validation rejection.
    seedRootRequirements(
      project.id,
      Array.from({ length: 51 }, (_, index) => `pkg-${index + 1}`).join('\n') + '\n',
    );
    primeRevision(project.id);
    renderPanel({ project });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The requirements.txt import only accepts plain public-PyPI requirement lines within the size and count limits.',
    );
    // The rejection is explicit: no fabricated success message.
    expect(
      screen.queryByRole('status', { name: 'Dependency change result' }),
    ).not.toHaveTextContent('Dependency change saved.');
    // A proven no-side-effect rejection clears the stored id.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);
    expect(singleDependencyPosts(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('surfaces PYTHON_DEPENDENCY_UNSUPPORTED for a line outside the plain requirement form', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Invalid Line');
    // An option-style line never matches the plain public-PyPI requirement form; the
    // helper-chain rejects it UNSUPPORTED before any operation row is registered.
    seedRootRequirements(project.id, '-r other-requirements.txt\n');
    primeRevision(project.id);
    renderPanel({ project });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Dependency changes are not supported for this project or package',
    );
    expect(
      screen.queryByRole('status', { name: 'Dependency change result' }),
    ).not.toHaveTextContent('Dependency change saved.');
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);
    expect(singleDependencyPosts(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('surfaces the backend validation rejection for an empty requirements.txt without fabricating success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Empty');
    // The browser sends the text verbatim; the backend owns the empty/limit validation.
    seedRootRequirements(project.id, '\n# only a comment\n');
    primeRevision(project.id);
    renderPanel({ project });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The requirements.txt import only accepts plain public-PyPI requirement lines within the size and count limits.',
    );
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import requirements.txt' })).toBeEnabled();
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);

    fetchSpy.mockRestore();
  });

  it('surfaces PYTHON_DEPENDENCY_UNSUPPORTED as a fixed safe rejection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const created = await createProject({
      name: 'Import Unsupported',
      templateId: 'java-console',
      mysql: false,
      redis: false,
      publicPorts: [],
    });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');
    seedRootRequirements(ready.id, 'httpx\n');
    primeRevision(ready.id);
    renderPanel({ project: ready });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Dependency changes are not supported for this project or package',
    );
    expect(readPythonDependencyOperationId(ALICE_USER_ID, ready.id)).toBeNull();
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(1);

    fetchSpy.mockRestore();
  });

  it('shows a safe error and submits nothing when requirements.txt does not exist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyPythonProject('Import Missing File');
    primeRevision(project.id);
    // The fresh project has no requirements.txt; the real backend answers 404
    // ENTRY_NOT_FOUND for the content read.
    server.use(
      http.get('/api/v1/projects/:projectId/files/content', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === 'requirements.txt') {
          return HttpResponse.json(
            {
              code: 'ENTRY_NOT_FOUND',
              message: 'Entry not found',
              traceId: 'mock-trace-entry-not-found',
            },
            { status: 404 },
          );
        }
        return undefined;
      }),
    );
    renderPanel({ project });

    await user.click(screen.getByRole('button', { name: 'Import requirements.txt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('requirements.txt was not found in the project root.');
    // No batch and no single-package change was ever submitted.
    expect(batchDependencyPosts(fetchSpy)).toHaveLength(0);
    expect(singleDependencyPosts(fetchSpy)).toHaveLength(0);
    expect(readPythonDependencyOperationId(ALICE_USER_ID, project.id)).toBeNull();

    fetchSpy.mockRestore();
  });
});
