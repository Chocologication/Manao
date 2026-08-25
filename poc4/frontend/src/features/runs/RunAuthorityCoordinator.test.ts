import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import { parseRunId, type RunSummary } from '../../contracts/run';
import { clonePoc4RunPolicy } from '../../mocks/runFixtures';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import {
  isWorkspaceEditable,
  RunAuthorityCoordinator,
  useRunAuthorityCoordinator,
} from './RunAuthorityCoordinator';
import { runKeys } from './runQueries';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POLICY = clonePoc4RunPolicy();

function lockingRun(id = 'run-lock'): RunSummary {
  return {
    id: parseRunId(id),
    state: 'RUNNING',
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: POLICY,
    createdAt: '2026-08-24T10:00:00.000Z',
    startedAt: '2026-08-24T10:00:01.000Z',
    finishedAt: null,
    terminationReason: null,
    exitCode: null,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: 2,
  };
}

function terminalRun(id = 'run-lock'): RunSummary {
  return {
    id: parseRunId(id),
    state: 'SUCCEEDED',
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: POLICY,
    createdAt: '2026-08-24T10:00:00.000Z',
    startedAt: '2026-08-24T10:00:01.000Z',
    finishedAt: '2026-08-24T10:00:02.000Z',
    terminationReason: 'BUILD_SUCCEEDED',
    exitCode: 0,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: 2,
  };
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('RunAuthorityCoordinator', () => {
  it('starts loading and is not editable', () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'LOADING_AUTHORITY',
      startPending: false,
      observedLockingRunId: null,
    });
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('becomes EDITABLE only after a successful null active with no prior lock', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    await coordinator.reconcile('pending', null);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    await coordinator.reconcile('error', null);
    expect(coordinator.getSnapshot().phase).toBe('LOADING_AUTHORITY');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);

    await coordinator.reconcile('success', null);
    expect(coordinator.getSnapshot().phase).toBe('EDITABLE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);
  });

  it('fail-closes from EDITABLE when a later active query errors', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    await coordinator.reconcile('success', null);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);

    await coordinator.reconcile('error', null);
    expect(coordinator.getSnapshot().phase).toBe('LOADING_AUTHORITY');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('does not copy a run summary and stays locked while a locking run is observed', async () => {
    const fetchRun = vi.fn();
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    const run = lockingRun();
    await coordinator.reconcile('success', run);
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.observedLockingRunId).toBe(run.id);
    expect(snapshot.phase).not.toBe('LOADING_AUTHORITY');
    expect(isWorkspaceEditable(snapshot)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toMatch(/STARTING|RUNNING|STOPPING|RECOVERING|SUCCEEDED/);
    expect(fetchRun).not.toHaveBeenCalled();
  });

  it('keeps start-pending locked before 202', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    await coordinator.reconcile('success', null);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);
    coordinator.noteStartPending();
    expect(coordinator.getSnapshot().startPending).toBe(true);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    coordinator.clearStartPending();
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);
  });

  it('requires a parsed terminal detail before reload and never unlocks on null active alone', async () => {
    const run = lockingRun();
    const fetchRun = vi.fn().mockResolvedValue(terminalRun());
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', run);
    await coordinator.reconcile('success', null);

    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(fetchRun.mock.calls[0]?.[0]).toBe(run.id);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(run.id);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);

    await coordinator.reconcile('success', null);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
  });

  it('revokes terminal authority synchronously while null-active confirmation is pending', async () => {
    let resolveDetail = (_run: RunSummary) => {};
    const fetchRun = vi.fn(
      () =>
        new Promise<RunSummary>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    const running = lockingRun();
    await coordinator.reconcile('success', running);

    const confirmation = coordinator.reconcile('success', null);

    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({ status: 'success', run: null });
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(running.id);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');

    resolveDetail(terminalRun());
    await confirmation;
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
  });

  it('keeps a fresh same-run RUNNING authoritative over a stale pending terminal detail', async () => {
    let resolveDetail = (_run: RunSummary) => {};
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: () =>
        new Promise<RunSummary>((resolve) => {
          resolveDetail = resolve;
        }),
    });
    const running = lockingRun();
    await coordinator.reconcile('success', running);
    const staleConfirmation = coordinator.reconcile('success', null);
    expect(coordinator.getTerminalAuthoritySnapshot().run).toBeNull();

    await coordinator.reconcile('success', running);
    resolveDetail(terminalRun());
    await staleConfirmation;

    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({
      status: 'success',
      run: { id: running.id, state: 'RUNNING' },
    });
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
  });

  it.each([
    ['nonterminal detail', () => Promise.resolve(lockingRun())],
    ['detail rejection', () => Promise.reject(new Error('Network request failed'))],
  ])('keeps terminal authority revoked after %s until a fresh active RUNNING', async (_case, fetchRun) => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    const running = lockingRun();
    await coordinator.reconcile('success', running);

    await coordinator.reconcile('success', null);

    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({ status: 'success', run: null });
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(running.id);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');

    await coordinator.reconcile('success', running);
    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({
      status: 'success',
      run: { id: running.id, state: 'RUNNING' },
    });
  });

  it('stays locked when disappeared active cannot be confirmed terminal', async () => {
    const fetchRun = vi.fn().mockResolvedValue(lockingRun());
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('stays locked when terminal detail fetch fails', async () => {
    const fetchRun = vi.fn().mockRejectedValue(new Error('Network request failed'));
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('retries terminal confirm after a failed detail fetch', async () => {
    const fetchRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(terminalRun());
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
    await coordinator.reconcile('success', null);
    expect(fetchRun).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('ignores a stale terminal confirm after a newer locking run is observed', async () => {
    let releaseA = () => {};
    const fetchRun = vi.fn((runId: string) => {
      if (runId === 'run-a') {
        return new Promise<RunSummary>((resolve) => {
          releaseA = () => {
            resolve(terminalRun('run-a'));
          };
        });
      }
      return Promise.reject(new Error(`unexpected detail ${runId}`));
    });
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', lockingRun('run-a'));
    const confirmA = coordinator.reconcile('success', null);
    await coordinator.reconcile('success', lockingRun('run-b'));
    releaseA();
    await confirmA;
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(parseRunId('run-b'));
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('markReloadFailed stays locked', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn().mockResolvedValue(terminalRun()),
    });
    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    coordinator.markReloadFailed();
    expect(coordinator.getSnapshot().phase).toBe('RELOAD_FAILED');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('completeReload unlocks only from RELOADING_WORKSPACE', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn().mockResolvedValue(terminalRun()),
    });
    coordinator.completeReload();
    expect(coordinator.getSnapshot().phase).toBe('LOADING_AUTHORITY');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);

    await coordinator.reconcile('success', null);
    coordinator.completeReload();
    expect(coordinator.getSnapshot().phase).toBe('EDITABLE');

    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(coordinator.getReloadGeneration()).toBe(1);
    coordinator.completeReload();
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'EDITABLE',
      startPending: false,
      observedLockingRunId: null,
    });
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);
  });

  it('completeReload does not unlock RELOAD_FAILED', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn().mockResolvedValue(terminalRun()),
    });
    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    coordinator.markReloadFailed();
    coordinator.completeReload();
    expect(coordinator.getSnapshot().phase).toBe('RELOAD_FAILED');
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(parseRunId('run-lock'));
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('retryReload re-enters RELOADING_WORKSPACE only from RELOAD_FAILED', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn().mockResolvedValue(terminalRun()),
    });
    coordinator.retryReload();
    expect(coordinator.getSnapshot().phase).toBe('LOADING_AUTHORITY');
    expect(coordinator.getReloadGeneration()).toBe(0);

    await coordinator.reconcile('success', lockingRun());
    await coordinator.reconcile('success', null);
    expect(coordinator.getReloadGeneration()).toBe(1);
    coordinator.retryReload();
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(coordinator.getReloadGeneration()).toBe(1);

    coordinator.markReloadFailed();
    coordinator.retryReload();
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(coordinator.getReloadGeneration()).toBe(2);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('does not start a second reload from a duplicate null active or terminal socket event', async () => {
    const fetchRun = vi.fn().mockResolvedValue(terminalRun());
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun,
    });
    await coordinator.reconcile('success', lockingRun());
    const first = coordinator.reconcile('success', null);
    const second = coordinator.reconcile('success', null);
    await Promise.all([first, second]);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(coordinator.getReloadGeneration()).toBe(1);

    await coordinator.reconcile('success', terminalRun());
    await coordinator.reconcile('success', null);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(coordinator.getReloadGeneration()).toBe(1);
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('publishes only changed current authority to the terminal channel', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    const observed = vi.fn();
    coordinator.subscribeTerminalAuthority(observed);
    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({ status: 'pending', run: null });

    const running = lockingRun();
    await coordinator.reconcile('success', running);
    expect(coordinator.getTerminalAuthoritySnapshot()).toEqual({
      status: 'success',
      run: { id: running.id, state: 'RUNNING' },
    });
    expect(observed).toHaveBeenCalledTimes(1);

    const stable = coordinator.getTerminalAuthoritySnapshot();
    await coordinator.reconcile('success', lockingRun());
    expect(coordinator.getTerminalAuthoritySnapshot()).toBe(stable);
    expect(observed).toHaveBeenCalledTimes(1);

    await coordinator.reconcile('success', { ...running, state: 'STOPPING' });
    expect(coordinator.getTerminalAuthoritySnapshot().run?.state).toBe('STOPPING');
    await coordinator.reconcile('success', { ...running, state: 'RECOVERING' });
    expect(coordinator.getTerminalAuthoritySnapshot().run?.state).toBe('RECOVERING');
    expect(observed).toHaveBeenCalledTimes(3);
  });

  it('publishes confirmed terminal authority before workspace reload notification', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn().mockResolvedValue(terminalRun()),
    });
    const trace: string[] = [];
    coordinator.subscribeTerminalAuthority(() => {
      trace.push(`terminal:${coordinator.getTerminalAuthoritySnapshot().run?.state ?? 'null'}`);
    });
    coordinator.subscribe(() => {
      if (coordinator.getSnapshot().phase === 'RELOADING_WORKSPACE') trace.push('reload');
    });
    await coordinator.reconcile('success', lockingRun());
    trace.length = 0;

    await coordinator.reconcile('success', null);

    expect(trace).toEqual(['terminal:null', 'terminal:SUCCEEDED', 'reload']);
    expect(coordinator.getReloadGeneration()).toBe(1);
  });

  it('publishes a direct terminal state without starting reload and ignores duplicates', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: vi.fn(),
    });
    const trace: string[] = [];
    coordinator.subscribeTerminalAuthority(() => {
      trace.push(`terminal:${coordinator.getTerminalAuthoritySnapshot().run?.state ?? 'null'}`);
    });
    coordinator.subscribe(() => {
      if (coordinator.getSnapshot().phase === 'RELOADING_WORKSPACE') trace.push('reload');
    });
    await coordinator.reconcile('success', lockingRun());
    trace.length = 0;

    await coordinator.reconcile('success', terminalRun());
    await coordinator.reconcile('success', terminalRun());

    expect(trace).toEqual(['terminal:SUCCEEDED']);
    expect(coordinator.getReloadGeneration()).toBe(0);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
  });
});

describe('useRunAuthorityCoordinator', () => {
  it('loads null active into EDITABLE without a run summary store', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useRunAuthorityCoordinator(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await waitFor(() => expect(result.current.getSnapshot().phase).toBe('EDITABLE'));
    expect(isWorkspaceEditable(result.current.getSnapshot())).toBe(true);
    expect(result.current.getSnapshot().observedLockingRunId).toBeNull();
  });

  it('fetches detail after a locking run disappears and requires reload', async () => {
    const run = lockingRun('run-gone');
    const succeeded = terminalRun('run-gone');
    let active: RunSummary | null = run;
    let detailGets = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () => HttpResponse.json({ run: active })),
      http.get('/api/v1/projects/:projectId/runs/:runId', () => {
        detailGets += 1;
        return HttpResponse.json(succeeded);
      }),
    );
    await authenticateAsAlice();
    const { result } = renderHook(() => useRunAuthorityCoordinator(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await waitFor(() => expect(result.current.getSnapshot().observedLockingRunId).toBe(run.id));
    expect(isWorkspaceEditable(result.current.getSnapshot())).toBe(false);

    active = null;
    await queryClient.refetchQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => expect(result.current.getSnapshot().phase).toBe('RELOADING_WORKSPACE'));
    expect(detailGets).toBeGreaterThanOrEqual(1);
    expect(isWorkspaceEditable(result.current.getSnapshot())).toBe(false);
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toEqual({ run: null });
    expect(queryClient.getQueryData(runKeys.detail(ALICE_SEED_PROJECT_ID, run.id))).toEqual(succeeded);
  });
});
