import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import {
  parseRunId,
  type RunListResponse,
  type RunSummary,
} from '../../contracts/run';
import { clonePoc4RunPolicy } from '../../mocks/runFixtures';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import {
  ACTIVE_RUN_POLL_MS,
  activeRunRefetchInterval,
  flattenRunHistoryPages,
  requireTerminalRun,
  retryRunQuery,
  RUN_QUERY_MAX_RETRIES,
  runKeys,
  useActiveRunQuery,
  useRunDetailQuery,
  useRunHistoryQuery,
} from './runQueries';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POLICY = clonePoc4RunPolicy();

function lockingRun(id: string, state: 'STARTING' | 'RUNNING' = 'STARTING'): RunSummary {
  return {
    id: parseRunId(id),
    state,
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: POLICY,
    createdAt: '2026-08-24T10:00:00.000Z',
    startedAt: state === 'RUNNING' ? '2026-08-24T10:00:01.000Z' : null,
    finishedAt: null,
    terminationReason: null,
    exitCode: null,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: null,
  };
}

function terminalRun(id: string, createdAt = '2026-08-24T10:00:00.000Z'): RunSummary {
  const createdMs = Date.parse(createdAt);
  return {
    id: parseRunId(id),
    state: 'SUCCEEDED',
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: POLICY,
    createdAt,
    startedAt: new Date(createdMs + 1000).toISOString(),
    finishedAt: new Date(createdMs + 2000).toISOString(),
    terminationReason: 'BUILD_SUCCEEDED',
    exitCode: 0,
    logTruncated: false,
    logEvictedBytes: 0,
    lastLogSeq: 1,
  };
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

describe('runKeys', () => {
  it('scopes active, detail, and history keys by project', () => {
    expect(runKeys.all('prj-1')).toEqual(['project-runs', 'prj-1']);
    expect(runKeys.active('prj-1')).toEqual(['project-runs', 'prj-1', 'active']);
    expect(runKeys.detail('prj-1')).toEqual(['project-runs', 'prj-1', 'detail']);
    expect(runKeys.detail('prj-1', parseRunId('run-1'))).toEqual([
      'project-runs',
      'prj-1',
      'detail',
      'run-1',
    ]);
    expect(runKeys.history('prj-1')).toEqual(['project-runs', 'prj-1', 'history']);
    expect(runKeys.active('prj-1')).not.toEqual(runKeys.active('prj-2'));
    expect(runKeys.active(ALICE_SEED_PROJECT_ID)).not.toEqual(runKeys.active(BOB_SEED_PROJECT_ID));
  });
});

describe('retryRunQuery', () => {
  it('never retries 401 or 403', () => {
    const unauthorized = new ApiRequestError(401, {
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
      traceId: 't',
    });
    const forbidden = new ApiRequestError(403, {
      code: 'FORBIDDEN',
      message: 'Access denied',
      traceId: 't',
    });
    expect(retryRunQuery(0, unauthorized)).toBe(false);
    expect(retryRunQuery(0, forbidden)).toBe(false);
    expect(retryRunQuery(1, unauthorized)).toBe(false);
  });

  it('retries transient network and 5xx up to the bound, and never retries other 4xx', () => {
    const serverError = new ApiRequestError(500, {
      code: 'INTERNAL_ERROR',
      message: 'boom',
      traceId: 't',
    });
    const conflict = new ApiRequestError(409, {
      code: 'RUN_ALREADY_ACTIVE',
      message: 'active',
      traceId: 't',
    });
    const missing = new ApiRequestError(404, {
      code: 'RUN_NOT_FOUND',
      message: 'gone',
      traceId: 't',
    });
    expect(retryRunQuery(0, serverError)).toBe(true);
    expect(retryRunQuery(RUN_QUERY_MAX_RETRIES - 1, serverError)).toBe(true);
    expect(retryRunQuery(RUN_QUERY_MAX_RETRIES, serverError)).toBe(false);
    expect(retryRunQuery(0, new Error('Network request failed'))).toBe(true);
    expect(retryRunQuery(RUN_QUERY_MAX_RETRIES, new Error('Network request failed'))).toBe(false);
    expect(retryRunQuery(0, conflict)).toBe(false);
    expect(retryRunQuery(0, missing)).toBe(false);
  });
});

describe('activeRunRefetchInterval', () => {
  it('polls every 5 seconds while a locking run is active', () => {
    expect(ACTIVE_RUN_POLL_MS).toBe(5_000);
    expect(
      activeRunRefetchInterval({ state: { data: { run: lockingRun('run-1', 'RUNNING') } } }),
    ).toBe(5_000);
    expect(activeRunRefetchInterval({ state: { data: { run: lockingRun('run-1') } } })).toBe(5_000);
    expect(activeRunRefetchInterval({ state: { data: { run: null } } })).toBe(false);
    expect(activeRunRefetchInterval({ state: { data: undefined } })).toBe(false);
  });

  it('keeps polling while a previously locking run is still unconfirmed', () => {
    expect(activeRunRefetchInterval({ state: { data: { run: null } } }, true)).toBe(5_000);
    expect(activeRunRefetchInterval({ state: { data: undefined } }, true)).toBe(false);
  });
});

describe('flattenRunHistoryPages', () => {
  it('copies pages, dedupes by run id, and sorts by createdAt descending', () => {
    const newer = terminalRun('run-new', '2026-08-24T11:00:00.000Z');
    const older = terminalRun('run-old', '2026-08-24T10:00:00.000Z');
    const pages: RunListResponse[] = [
      { items: [newer, older], nextCursor: 'c1' },
      { items: [older, terminalRun('run-older', '2026-08-24T09:00:00.000Z')], nextCursor: null },
    ];
    Object.freeze(pages);
    Object.freeze(pages[0]);
    Object.freeze(pages[0]?.items);
    Object.freeze(pages[1]);
    Object.freeze(pages[1]?.items);
    const original = structuredClone(pages);

    const flat = flattenRunHistoryPages(pages);

    expect(flat.map((item) => item.id)).toEqual(['run-new', 'run-old', 'run-older']);
    expect(pages).toEqual(original);
    expect(flat).not.toBe(pages[0]?.items);
  });
});

describe('useActiveRunQuery', () => {
  it('uses the project-scoped key, bounded retry, and 5s poll while locking', async () => {
    await authenticateAsAlice();
    const { result } = renderHook(() => useActiveRunQuery(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ run: null });

    const cached = queryClient.getQueryCache().find({
      queryKey: runKeys.active(ALICE_SEED_PROJECT_ID),
    });
    expect(cached?.queryKey).toEqual(['project-runs', ALICE_SEED_PROJECT_ID, 'active']);
    expect(cached?.observers[0]?.options.retry).toBe(retryRunQuery);
    expect(cached?.observers[0]?.options.refetchInterval).toBe(activeRunRefetchInterval);
  });

  it('does not retry 403', async () => {
    let gets = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () => {
        gets += 1;
        return HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Access denied', traceId: 'trace-active-403' },
          { status: 403 },
        );
      }),
    );
    await authenticateAsAlice();
    const { result } = renderHook(() => useActiveRunQuery(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await sleep(80);
    expect(gets).toBe(1);
  });

  it('retries 5xx up to the bound and no further', async () => {
    let gets = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () => {
        gets += 1;
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Mock active failure', traceId: 'trace-active-500' },
          { status: 500 },
        );
      }),
    );
    await authenticateAsAlice();
    const { result } = renderHook(() => useActiveRunQuery(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 2000 });
    expect(gets).toBe(RUN_QUERY_MAX_RETRIES + 1);
  });
});

describe('requireTerminalRun', () => {
  it('returns a parsed terminal summary and rejects a locking detail', async () => {
    const succeeded = terminalRun('run-term');
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId', ({ params }) => {
        if (params.runId === 'run-term') {
          return HttpResponse.json(succeeded);
        }
        return HttpResponse.json(lockingRun('run-lock', 'RUNNING'));
      }),
    );
    await authenticateAsAlice();

    await expect(requireTerminalRun(ALICE_SEED_PROJECT_ID, parseRunId('run-term'))).resolves.toEqual(
      succeeded,
    );
    await expect(requireTerminalRun(ALICE_SEED_PROJECT_ID, parseRunId('run-lock'))).rejects.toThrow(
      /terminal/i,
    );
  });
});

describe('useRunHistoryQuery', () => {
  it('loads cursor pages and flattens without mutating page arrays', async () => {
    const first = terminalRun('run-new', '2026-08-24T11:00:00.000Z');
    const second = terminalRun('run-old', '2026-08-24T10:00:00.000Z');
    let listCalls = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs', ({ request }) => {
        listCalls += 1;
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({ items: [first], nextCursor: 'opaque-cursor-2' });
        }
        expect(cursor).toBe('opaque-cursor-2');
        return HttpResponse.json({ items: [first, second], nextCursor: null });
      }),
    );
    await authenticateAsAlice();
    const { result } = renderHook(() => useRunHistoryQuery(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(listCalls).toBe(2);

    const pages = result.current.data?.pages ?? [];
    const frozen = structuredClone(pages);
    Object.freeze(pages);
    const flat = flattenRunHistoryPages(pages);
    expect(flat.map((item) => item.id)).toEqual(['run-new', 'run-old']);
    expect(pages).toEqual(frozen);
  });
});

describe('useRunDetailQuery', () => {
  it('is project and run scoped and stays disabled without a run id', async () => {
    await authenticateAsAlice();
    const idle = renderHook(() => useRunDetailQuery(ALICE_SEED_PROJECT_ID, null), {
      wrapper: AppProviders,
    });
    expect(idle.result.current.fetchStatus).toBe('idle');

    const run = lockingRun('run-detail');
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId', () => HttpResponse.json(run)),
    );
    const { result } = renderHook(
      () => useRunDetailQuery(ALICE_SEED_PROJECT_ID, parseRunId('run-detail')),
      { wrapper: AppProviders },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(run);
    expect(
      queryClient.getQueryCache().find({
        queryKey: runKeys.detail(ALICE_SEED_PROJECT_ID, parseRunId('run-detail')),
      })?.queryKey,
    ).toEqual(['project-runs', ALICE_SEED_PROJECT_ID, 'detail', 'run-detail']);
  });
});
