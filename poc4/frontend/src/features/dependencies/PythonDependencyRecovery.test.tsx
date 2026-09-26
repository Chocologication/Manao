import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPythonDependencyOperationId,
  pythonDependencyStorageKey,
  readPythonDependencyOperationId,
} from '../../api/pythonDependencyApi';
import { queryClient } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { resetAppRuntime } from '../../test/renderApp';
import { http, HttpResponse } from 'msw';
import { PythonDependencyRecovery } from './PythonDependencyRecovery';

const ALICE_USER_ID = 'usr-alice';
const PROJECT_ID = 'prj-dependency-recovery';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATION_ID = '22222222-2222-4222-8222-222222222222';

type RecordedCall = { method: string; path: string };

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
    return [{ method, path: new URL(url, 'http://localhost').pathname }];
  });
}

function statusUrl(operationId: string): string {
  return `/api/v1/projects/${PROJECT_ID}/python-dependencies/${operationId}`;
}

function renderRecovery(options: {
  variant: 'ready' | 'failed';
  operationId?: string | null;
  onRecovered?: () => void;
}) {
  return render(
    <PythonDependencyRecovery
      projectId={PROJECT_ID}
      userId={ALICE_USER_ID}
      variant={options.variant}
      operationId={options.operationId}
      onRecovered={options.onRecovered ?? (() => {})}
    />,
  );
}
afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  server.resetHandlers();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('PythonDependencyRecovery ready page', () => {
  it('shows the unconfirmed entry for the passed operation and confirms a COMMITTED result by its GET', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    sessionStorage.setItem(pythonDependencyStorageKey(ALICE_USER_ID, PROJECT_ID), OPERATION_ID);
    server.use(
      http.get(statusUrl(OPERATION_ID), () =>
        HttpResponse.json({
          operationId: OPERATION_ID,
          state: 'COMMITTED',
          resultWorkspaceRevision: 'mock-rev-0002',
        }),
      ),
    );
    const user = userEvent.setup();
    const view = renderRecovery({ variant: 'ready', operationId: OPERATION_ID, onRecovered });

    expect(screen.getByText('Dependency change is unconfirmed')).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Check dependency change' });
    expect(check).toBeEnabled();
    await user.click(check);

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    // The GET carried the first operation id and no new change was posted.
    const calls = recordedDependencyCalls(fetchSpy);
    expect(calls).toEqual([{ method: 'GET', path: statusUrl(OPERATION_ID) }]);
    expect(readPythonDependencyOperationId(ALICE_USER_ID, PROJECT_ID)).toBeNull();
    // The parent (route/shell) hides the entry once the operation is confirmed.
    view.rerender(
      <PythonDependencyRecovery
        projectId={PROJECT_ID}
        userId={ALICE_USER_ID}
        variant="ready"
        operationId={null}
        onRecovered={onRecovered}
      />,
    );
    expect(screen.queryByText('Dependency change is unconfirmed')).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it('reconciles the same operation when the GET reports PENDING', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    server.use(
      http.get(statusUrl(OPERATION_ID), () =>
        HttpResponse.json({ operationId: OPERATION_ID, state: 'PENDING' }),
      ),
      http.post(`${statusUrl(OPERATION_ID)}/reconcile`, () =>
        HttpResponse.json({
          operationId: OPERATION_ID,
          state: 'COMMITTED',
          resultWorkspaceRevision: 'mock-rev-0003',
        }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'ready', operationId: OPERATION_ID, onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    expect(recordedDependencyCalls(fetchSpy)).toEqual([
      { method: 'GET', path: statusUrl(OPERATION_ID) },
      { method: 'POST', path: `${statusUrl(OPERATION_ID)}/reconcile` },
    ]);
    fetchSpy.mockRestore();
  });

  it('stays unconfirmed for UNCONFIRMED without unlocking or auto-retrying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    sessionStorage.setItem(pythonDependencyStorageKey(ALICE_USER_ID, PROJECT_ID), OPERATION_ID);
    server.use(
      http.get(statusUrl(OPERATION_ID), () =>
        HttpResponse.json({ operationId: OPERATION_ID, state: 'UNCONFIRMED' }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'ready', operationId: OPERATION_ID, onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    });
    expect(onRecovered).not.toHaveBeenCalled();
    // Only the read-only GET ran; no POST of any kind was sent.
    expect(recordedDependencyCalls(fetchSpy)).toEqual([
      { method: 'GET', path: statusUrl(OPERATION_ID) },
    ]);
    // A missing record is not a proof of absence: the id stays and the entry stays.
    expect(readPythonDependencyOperationId(ALICE_USER_ID, PROJECT_ID)).toBe(OPERATION_ID);
    expect(screen.getByText('Dependency change is unconfirmed')).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it('keeps the entry after a failed check so the user can check again', async () => {
    const onRecovered = vi.fn();
    server.use(
      http.get(statusUrl(OPERATION_ID), () => HttpResponse.error()),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'ready', operationId: OPERATION_ID, onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    });
    expect(onRecovered).not.toHaveBeenCalled();
    expect(screen.getByText('Dependency change is unconfirmed')).toBeInTheDocument();
  });
});

describe('PythonDependencyRecovery failed page', () => {
  it('uses the stored operation id without consulting the pending list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    sessionStorage.setItem(pythonDependencyStorageKey(ALICE_USER_ID, PROJECT_ID), OPERATION_ID);
    server.use(
      http.get(statusUrl(OPERATION_ID), () =>
        HttpResponse.json({
          operationId: OPERATION_ID,
          state: 'COMMITTED',
          resultWorkspaceRevision: 'mock-rev-0004',
        }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'failed', onRecovered });

    expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    expect(recordedDependencyCalls(fetchSpy)).toEqual([
      { method: 'GET', path: statusUrl(OPERATION_ID) },
    ]);
    fetchSpy.mockRestore();
  });

  it('falls back to the owner-scoped pending list when no local id exists', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    server.use(
      http.get(`/api/v1/projects/${PROJECT_ID}/python-dependencies/pending`, () =>
        HttpResponse.json({
          operations: [{ operationId: OTHER_OPERATION_ID, state: 'PENDING' }],
        }),
      ),
      http.get(statusUrl(OTHER_OPERATION_ID), () =>
        HttpResponse.json({ operationId: OTHER_OPERATION_ID, state: 'PENDING' }),
      ),
      http.post(`${statusUrl(OTHER_OPERATION_ID)}/reconcile`, () =>
        HttpResponse.json({
          operationId: OTHER_OPERATION_ID,
          state: 'COMMITTED',
          resultWorkspaceRevision: 'mock-rev-0005',
        }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'failed', onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    expect(recordedDependencyCalls(fetchSpy)).toEqual([
      { method: 'GET', path: `/api/v1/projects/${PROJECT_ID}/python-dependencies/pending` },
      { method: 'GET', path: statusUrl(OTHER_OPERATION_ID) },
      { method: 'POST', path: `${statusUrl(OTHER_OPERATION_ID)}/reconcile` },
    ]);
    fetchSpy.mockRestore();
  });

  it('stays unconfirmed when the pending list has no record and never unlocks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onRecovered = vi.fn();
    server.use(
      http.get(`/api/v1/projects/${PROJECT_ID}/python-dependencies/pending`, () =>
        HttpResponse.json({ operations: [] }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'failed', onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    });
    expect(onRecovered).not.toHaveBeenCalled();
    expect(screen.getByText('Dependency change is unconfirmed')).toBeInTheDocument();
    expect(recordedDependencyCalls(fetchSpy)).toEqual([
      { method: 'GET', path: `/api/v1/projects/${PROJECT_ID}/python-dependencies/pending` },
    ]);
    fetchSpy.mockRestore();
  });

  it('clears the stored id of the recovered operation only', async () => {
    const onRecovered = vi.fn();
    sessionStorage.setItem(pythonDependencyStorageKey(ALICE_USER_ID, PROJECT_ID), OPERATION_ID);
    sessionStorage.setItem(pythonDependencyStorageKey(ALICE_USER_ID, 'prj-other'), OTHER_OPERATION_ID);
    server.use(
      http.get(statusUrl(OPERATION_ID), () =>
        HttpResponse.json({
          operationId: OPERATION_ID,
          state: 'COMMITTED',
          resultWorkspaceRevision: 'mock-rev-0006',
        }),
      ),
    );
    const user = userEvent.setup();
    renderRecovery({ variant: 'failed', onRecovered });

    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));
    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });

    expect(readPythonDependencyOperationId(ALICE_USER_ID, PROJECT_ID)).toBeNull();
    expect(readPythonDependencyOperationId(ALICE_USER_ID, 'prj-other')).toBe(OTHER_OPERATION_ID);
    clearPythonDependencyOperationId(ALICE_USER_ID, 'prj-other');
  });
});
