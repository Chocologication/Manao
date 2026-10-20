import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { pythonDependencyStorageKey } from '../../api/pythonDependencyApi';
import { createProject, getProject } from '../../api/projectApi';
import { authSession } from '../../app/appRuntime';
import type { ProjectSummary } from '../../contracts/project';
import { setDependencyScenario } from '../../mocks/state';
import {
  getFileRequestCount,
  markMockProjectDependencyReconciliationFailed,
  MOCK_FAILURE_REASON,
} from '../../mocks/state';
import { resetAppRuntime, renderApp } from '../../test/renderApp';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ALICE_USER_ID = 'usr-alice';
const FAILED_OPERATION_ID = '11111111-1111-4111-8111-111111111111';

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function createReadyProject(
  name: string,
  templateId: 'python-console' | 'java-spring-boot-web',
): Promise<ProjectSummary> {
  const created = await createProject({
    name,
    templateId,
    mysql: false,
    redis: false,
    publicPorts: [],
  });
  await getProject(created.id);
  const ready = await getProject(created.id);
  expect(ready.state).toBe('READY');
  return ready;
}

type RecordedCall = { method: string; path: string; body: unknown };

function recordedDependencyCalls(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return spy.mock.calls.flatMap((call) => {
    const input = call[0];
    const init = call[1];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    if (!/\/python-dependencies/.test(url)) {
      return [];
    }
    const method =
      typeof init === 'object' && init !== null && 'method' in init
        ? String((init as { method?: unknown }).method ?? 'GET').toUpperCase()
        : 'GET';
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

function dependencyChangePosts(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return recordedDependencyCalls(spy).filter(
    (call) => call.method === 'POST' && !call.path.endsWith('/reconcile'),
  );
}

function dependencyStatusGets(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return recordedDependencyCalls(spy).filter(
    (call) => call.method === 'GET' && /\/python-dependencies\/(?!pending$)[^/]+$/.test(call.path),
  );
}

function dependencyReconciles(spy: { mock: { calls: unknown[][] } }): RecordedCall[] {
  return recordedDependencyCalls(spy).filter((call) => call.method === 'POST' && call.path.endsWith('/reconcile'));
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  resetAppRuntime();
});

describe('ProjectRoutePage dependency recovery after refresh', () => {
  it('redrives a committed-but-lost change by its original id after a full remount and never posts twice', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyProject('Dep Lost Response', 'python-console');

    setDependencyScenario('lost-response');
    const first = renderApp({ initialEntries: [`/projects/${project.id}`] });
    // The first workbench mount in this worker pays the lazy editor chunk cost.
    await user.click(await screen.findByRole('tab', { name: 'Dependencies' }, { timeout: 30_000 }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // The response is lost: the entry appears and the original id is kept in the session.
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    const posts = dependencyChangePosts(fetchSpy);
    expect(posts).toHaveLength(1);
    const originalOperationId = (posts[0]!.body as Record<string, unknown>).operationId;
    expect(sessionStorage.getItem(pythonDependencyStorageKey(ALICE_USER_ID, project.id))).toBe(
      originalOperationId,
    );
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled();

    // Refresh = a full route remount, not an isolated recovery component render.
    first.unmount();
    setDependencyScenario('normal');
    renderApp({ initialEntries: [`/projects/${project.id}`] });

    const check = await screen.findByRole('button', { name: 'Check dependency change' });
    expect(check).toBeEnabled();
    const treeCountBeforeCheck = getFileRequestCount('tree', project.id, '');
    await user.click(check);

    await waitFor(() => {
      expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    });
    // The captured GET carried the first operation id; no second ADD was sent.
    expect(dependencyChangePosts(fetchSpy)).toHaveLength(1);
    expect(dependencyStatusGets(fetchSpy).map((call) => call.path)).toEqual([
      `/api/v1/projects/${project.id}/python-dependencies/${originalOperationId}`,
    ]);
    expect(dependencyReconciles(fetchSpy)).toHaveLength(0);
    // The current workspace was reloaded after the confirmation, and the stored id is gone.
    await waitFor(() => {
      expect(getFileRequestCount('tree', project.id, '')).toBeGreaterThan(treeCountBeforeCheck);
    });
    expect(sessionStorage.getItem(pythonDependencyStorageKey(ALICE_USER_ID, project.id))).toBeNull();
    expect(await screen.findByRole('treeitem', { name: 'pyproject.toml' })).toBeInTheDocument();

    fetchSpy.mockRestore();
  }, 60_000);

  it('keeps the check button reachable on a refreshed FAILED project and reconciles the original operation to READY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyProject('Dep Pending Failed', 'python-console');
    markMockProjectDependencyReconciliationFailed(project.id, FAILED_OPERATION_ID);
    sessionStorage.setItem(
      pythonDependencyStorageKey(ALICE_USER_ID, project.id),
      FAILED_OPERATION_ID,
    );

    renderApp({ initialEntries: [`/projects/${project.id}`] });

    expect(await screen.findByText('WORKSPACE_RECONCILIATION_REQUIRED')).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Check dependency change' });
    expect(check).toBeEnabled();
    await user.click(check);

    // Reconciling the PENDING operation lifts exactly this failure and reopens the workbench.
    expect(await screen.findByRole('heading', { name: project.name }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Editor' })).toBeInTheDocument();
    expect(dependencyChangePosts(fetchSpy)).toHaveLength(0);
    expect(dependencyStatusGets(fetchSpy).map((call) => call.path)).toEqual([
      `/api/v1/projects/${project.id}/python-dependencies/${FAILED_OPERATION_ID}`,
    ]);
    expect(dependencyReconciles(fetchSpy).map((call) => call.path)).toEqual([
      `/api/v1/projects/${project.id}/python-dependencies/${FAILED_OPERATION_ID}/reconcile`,
    ]);
    expect(sessionStorage.getItem(pythonDependencyStorageKey(ALICE_USER_ID, project.id))).toBeNull();

    fetchSpy.mockRestore();
  }, 20_000);

  it('recovers a new session through the owner-scoped pending list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createReadyProject('Dep Pending New Session', 'python-console');
    markMockProjectDependencyReconciliationFailed(project.id, FAILED_OPERATION_ID);

    renderApp({ initialEntries: [`/projects/${project.id}`] });

    expect(await screen.findByText('WORKSPACE_RECONCILIATION_REQUIRED')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    expect(await screen.findByRole('heading', { name: project.name }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Editor' })).toBeInTheDocument();
    expect(dependencyStatusGets(fetchSpy).map((call) => call.path)).toEqual([
      `/api/v1/projects/${project.id}/python-dependencies/${FAILED_OPERATION_ID}`,
    ]);
    expect(dependencyReconciles(fetchSpy).map((call) => call.path)).toEqual([
      `/api/v1/projects/${project.id}/python-dependencies/${FAILED_OPERATION_ID}/reconcile`,
    ]);
    expect(dependencyChangePosts(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  }, 20_000);
});

describe('ProjectRoutePage recovery entry eligibility', () => {
  it('offers no recovery entry for a different failure reason', async () => {
    await authenticateAsAlice();
    // The mock flips 'fail-' named projects to FAILED with its own provisioning reason.
    const failing = await createProject({ name: 'fail-dep-other' });
    await getProject(failing.id);
    const failed = await getProject(failing.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failureReason).toBe(MOCK_FAILURE_REASON);

    renderApp({ initialEntries: [`/projects/${failing.id}`] });
    expect(await screen.findByText(MOCK_FAILURE_REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check dependency change' })).not.toBeInTheDocument();
    expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
  });

  it('offers no recovery entry when the failed project is not a Python runtime', async () => {
    await authenticateAsAlice();
    const project = await createReadyProject('Java Broken Dep', 'java-spring-boot-web');
    markMockProjectDependencyReconciliationFailed(project.id, FAILED_OPERATION_ID);

    renderApp({ initialEntries: [`/projects/${project.id}`] });

    expect(await screen.findByText('WORKSPACE_RECONCILIATION_REQUIRED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check dependency change' })).not.toBeInTheDocument();
  });
});
