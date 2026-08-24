import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { getRun } from '../../api/runApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceBufferRegistry } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import { parseRunId, type RunSummary } from '../../contracts/run';
import { useWorkspaceSession } from '../editor/workspaceSession';
import { projectAuthorityScope, useSaveFileMutation } from '../files/fileMutations';
import { fileKeys, useDirectoryTreeQuery } from '../files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../files/pathPolicy';
import { clonePoc4RunPolicy } from '../../mocks/runFixtures';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID, setWriteScenario } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { isWorkspaceEditable, RunAuthorityCoordinator } from './RunAuthorityCoordinator';
import { captureStartRunVariables, useStartRunMutation, useStopRunMutation } from './runMutations';
import { runKeys, useActiveRunQuery } from './runQueries';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ROOT = parseProjectDirectoryPath('');
const POM = parseProjectRelativePath('pom.xml');
const POLICY = clonePoc4RunPolicy();
const AUTHORITY_SCOPE = `project-authority:${ALICE_SEED_PROJECT_ID}`;

function lockingRun(id: string, state: 'STARTING' | 'RUNNING' | 'STOPPING' = 'STARTING'): RunSummary {
  return {
    id: parseRunId(id),
    state,
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: POLICY,
    createdAt: '2026-08-24T10:00:00.000Z',
    startedAt: state === 'STARTING' ? null : '2026-08-24T10:00:01.000Z',
    finishedAt: null,
    terminationReason: null,
    exitCode: null,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: null,
  };
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function seedRootRevision(): Promise<void> {
  useWorkspaceSession.getState().activateProject(ALICE_SEED_PROJECT_ID);
  const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
    wrapper: AppProviders,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

function lastMutation() {
  const mutations = queryClient.getMutationCache().getAll();
  const mutation = mutations[mutations.length - 1];
  expect(mutation).toBeDefined();
  return mutation!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeCoordinator(): RunAuthorityCoordinator {
  return new RunAuthorityCoordinator({
    projectId: ALICE_SEED_PROJECT_ID,
    fetchRun: (runId, signal) => getRun(ALICE_SEED_PROJECT_ID, runId, signal),
  });
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('project authority scope', () => {
  it('uses project-authority scope and retry false for start and stop', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const coordinator = makeCoordinator();
    const { result } = renderHook(
      () => ({
        start: useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
        stop: useStopRunMutation(ALICE_SEED_PROJECT_ID),
      }),
      { wrapper: AppProviders },
    );

    await result.current.start.mutateAsync(
      captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID),
    );
    expect(lastMutation().options.scope).toEqual({ id: AUTHORITY_SCOPE });
    expect(lastMutation().options.retry).toBe(false);
    expect(projectAuthorityScope(ALICE_SEED_PROJECT_ID)).toEqual({ id: AUTHORITY_SCOPE });
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    expect(coordinator.getSnapshot().observedLockingRunId).not.toBeNull();

    await result.current.stop.mutateAsync();
    expect(lastMutation().options.scope).toEqual({ id: AUTHORITY_SCOPE });
    expect(lastMutation().options.retry).toBe(false);
  });

  it('serializes start behind a same-project file write and runs a different project immediately', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    queryClient.setQueryData(fileKeys.revision(BOB_SEED_PROJECT_ID), parseWorkspaceRevision('mock-rev-0001'));

    let releaseWrite = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let puts = 0;
    let startByProject: string[] = [];
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        puts += 1;
        await writeGate;
        return undefined;
      }),
      http.post('/api/v1/projects/:projectId/runs', async ({ params }) => {
        startByProject.push(String(params.projectId));
        return HttpResponse.json(lockingRun(`run-${params.projectId}`), { status: 202 });
      }),
      http.get('/api/v1/projects/:projectId/runs/active', ({ params }) => {
        if (params.projectId !== BOB_SEED_PROJECT_ID) {
          return undefined;
        }
        return HttpResponse.json({ run: lockingRun(`run-${params.projectId}`) });
      }),
    );

    const coordinator = makeCoordinator();
    const otherCoordinator = new RunAuthorityCoordinator({
      projectId: BOB_SEED_PROJECT_ID,
      fetchRun: async () => lockingRun('unused'),
    });
    const buffer = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: '<project />',
    });
    (buffer as typeof buffer & { replace(content: string): void }).replace('<project edited />');

    const { result } = renderHook(
      () => ({
        save: useSaveFileMutation(ALICE_SEED_PROJECT_ID),
        start: useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
        otherStart: useStartRunMutation(BOB_SEED_PROJECT_ID, otherCoordinator),
      }),
      { wrapper: AppProviders },
    );

    const captured = captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID);
    result.current.save.mutate({ path: POM, snapshot: buffer.snapshot() });
    await waitFor(() => expect(puts).toBe(1));
    const aliceStart = result.current.start.mutateAsync(captured);
    const otherStart = result.current.otherStart.mutateAsync({
      expectedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    });

    await waitFor(() => expect(startByProject).toContain(BOB_SEED_PROJECT_ID));
    expect(startByProject).not.toContain(ALICE_SEED_PROJECT_ID);

    releaseWrite();
    await waitFor(() => expect(startByProject).toContain(ALICE_SEED_PROJECT_ID));
    await otherStart;
    await aliceStart;
  });
});

describe('start mutation', () => {
  it('captures revision at mutate time so a queued write causes authoritative conflict', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    setWriteScenario('delayed');
    const coordinator = makeCoordinator();
    await coordinator.reconcile('success', null);

    const buffer = workspaceBufferRegistry.register({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'plain-text',
      content: '<project />',
    });
    (buffer as typeof buffer & { replace(content: string): void }).replace('<project edited />');
    const captured = captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID);
    expect(captured.expectedWorkspaceRevision).toBe('mock-rev-0001');

    const { result } = renderHook(
      () => ({
        save: useSaveFileMutation(ALICE_SEED_PROJECT_ID),
        start: useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
      }),
      { wrapper: AppProviders },
    );

    result.current.save.mutate({ path: POM, snapshot: buffer.snapshot() });
    const startPromise = result.current.start.mutateAsync(captured);

    const startError = await startPromise.then(
      () => {
        throw new Error('start should have failed');
      },
      (error: unknown) => error,
    );
    expect(startError).toBeInstanceOf(ApiRequestError);
    expect((startError as ApiRequestError).body?.code).toBe('WORKSPACE_REVISION_CONFLICT');
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toEqual({ run: null });
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0002');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(true);
  });

  it('sets pending lock, accepts only parsed 202, and never invents a run on network/409', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const coordinator = makeCoordinator();
    await coordinator.reconcile('success', null);
    let starts = 0;
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    server.use(
      http.post('/api/v1/projects/:projectId/runs', async () => {
        starts += 1;
        await startGate;
        return HttpResponse.error();
      }),
    );

    const { result } = renderHook(
      () => useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
      { wrapper: AppProviders },
    );
    const pending = result.current.mutateAsync(
      captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID),
    );
    await waitFor(() => expect(coordinator.getSnapshot().startPending).toBe(true));
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toBeUndefined();

    releaseStart();
    await expect(pending).rejects.toThrow(/network request failed/i);
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(starts).toBe(1);
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toEqual({ run: null });
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toMatch(
      /run-invented/,
    );
    expect(coordinator.getSnapshot().startPending).toBe(false);
  });

  it('keeps startPending when active refetch fails after a network start', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const coordinator = makeCoordinator();
    await coordinator.reconcile('success', null);
    server.use(
      http.post('/api/v1/projects/:projectId/runs', () => HttpResponse.error()),
      http.get('/api/v1/projects/:projectId/runs/active', () => HttpResponse.error()),
    );

    const { result } = renderHook(
      () => useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
      { wrapper: AppProviders },
    );
    await expect(
      result.current.mutateAsync(captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID)),
    ).rejects.toThrow(/network request failed/i);
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(coordinator.getSnapshot().startPending).toBe(true);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('refetches active before exposing retry on RUN_ALREADY_ACTIVE', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const existing = lockingRun('run-existing', 'RUNNING');
    let activeGets = 0;
    server.use(
      http.post('/api/v1/projects/:projectId/runs', () => {
        return HttpResponse.json(
          {
            code: 'RUN_ALREADY_ACTIVE',
            message: 'A run is already active',
            traceId: 'trace-already',
          },
          { status: 409 },
        );
      }),
      http.get('/api/v1/projects/:projectId/runs/active', () => {
        activeGets += 1;
        return HttpResponse.json({ run: existing });
      }),
    );
    const coordinator = makeCoordinator();
    const { result } = renderHook(
      () => ({
        active: useActiveRunQuery(ALICE_SEED_PROJECT_ID),
        start: useStartRunMutation(ALICE_SEED_PROJECT_ID, coordinator),
      }),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(result.current.active.isSuccess).toBe(true));
    const getsAfterObserve = activeGets;

    await expect(
      result.current.start.mutateAsync(captureStartRunVariables(queryClient, ALICE_SEED_PROJECT_ID)),
    ).rejects.toMatchObject({ body: { code: 'RUN_ALREADY_ACTIVE' } });
    await waitFor(() => expect(result.current.start.isPending).toBe(false));
    expect(activeGets).toBeGreaterThan(getsAfterObserve);
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toEqual({ run: existing });
  });
});

describe('stop mutation', () => {
  it('stops the active runId at execution and stays pending through refetch', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const running = lockingRun('run-stop', 'RUNNING');
    const stopping = lockingRun('run-stop', 'STOPPING');
    queryClient.setQueryData(runKeys.active(ALICE_SEED_PROJECT_ID), { run: running });

    let releaseStop = () => {};
    let releaseActive = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let stopIds: string[] = [];
    let activeReleased = false;
    server.use(
      http.post('/api/v1/projects/:projectId/runs/:runId/stop', async ({ params }) => {
        stopIds.push(String(params.runId));
        await stopGate;
        return HttpResponse.json(stopping);
      }),
      http.get('/api/v1/projects/:projectId/runs/active', async () => {
        if (!activeReleased) {
          await activeGate;
        }
        return HttpResponse.json({ run: stopping });
      }),
    );

    const { result } = renderHook(() => useStopRunMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    const pending = result.current.mutateAsync();
    await waitFor(() => expect(stopIds).toEqual(['run-stop']));
    await waitFor(() => expect(result.current.isPending).toBe(true));

    queryClient.setQueryData(runKeys.active(ALICE_SEED_PROJECT_ID), {
      run: lockingRun('run-other', 'RUNNING'),
    });
    expect(stopIds).toEqual(['run-stop']);

    releaseStop();
    await sleep(40);
    expect(result.current.isPending).toBe(true);
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).not.toEqual(
      expect.objectContaining({ run: expect.objectContaining({ state: 'CANCELLED' }) }),
    );

    activeReleased = true;
    releaseActive();
    await pending;
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID))).toEqual({ run: stopping });
    const cached = JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data));
    expect(cached).not.toMatch(/CANCELLED/);
  });

  it('does not unlock the coordinator on stop error', async () => {
    await authenticateAsAlice();
    const running = lockingRun('run-stop', 'RUNNING');
    queryClient.setQueryData(runKeys.active(ALICE_SEED_PROJECT_ID), { run: running });
    const coordinator = makeCoordinator();
    await coordinator.reconcile('success', running);
    server.use(
      http.post('/api/v1/projects/:projectId/runs/:runId/stop', () => HttpResponse.error()),
    );

    const { result } = renderHook(() => useStopRunMutation(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });
    await expect(result.current.mutateAsync()).rejects.toThrow(/network request failed/i);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(running.id);
    expect(JSON.stringify(queryClient.getQueryData(runKeys.active(ALICE_SEED_PROJECT_ID)))).not.toMatch(
      /CANCELLED/,
    );
  });
});
