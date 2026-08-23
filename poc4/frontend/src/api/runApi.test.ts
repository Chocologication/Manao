import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceRevision } from '../contracts/file';
import {
  parseRunId,
  type ActiveRunResponse,
  type RunListResponse,
  type RunSummary,
} from '../contracts/run';
import {
  createLogTicket,
  getActiveRun,
  getRun,
  listRuns,
  startRun,
  stopRun,
} from './runApi';
import { HttpClient, setHttpClient } from './httpClient';

const PROJECT_ID = 'prj/opaque';
const RUN_ID = parseRunId('run/opaque');
const ACCESS_TOKEN = 'access-token';

const POLICY = {
  command: 'mvn clean test' as const,
  runtime: { javaMajor: 17 as const, mavenMajor: 3 as const },
  timeoutSeconds: 1800,
  resources: {
    requests: {
      cpuMillis: 2000,
      memoryBytes: 2_147_483_648,
      ephemeralStorageBytes: 1_073_741_824,
    },
    limits: {
      cpuMillis: 4000,
      memoryBytes: 4_294_967_296,
      ephemeralStorageBytes: 2_147_483_648,
    },
  },
};

const startingRun: RunSummary = {
  id: RUN_ID,
  state: 'STARTING',
  requestedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
  policy: POLICY,
  createdAt: '2026-08-24T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  terminationReason: null,
  exitCode: null,
  logTruncated: false,
  logEvictedBytes: 0,
  lastLogSeq: null,
};

const runningRun: RunSummary = {
  ...startingRun,
  state: 'RUNNING',
  startedAt: '2026-08-24T10:00:01.000Z',
  lastLogSeq: 4,
};

const TICKET_EXPIRES_AT = '2026-08-24T10:00:30.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installClient(
  fetchImpl: typeof fetch,
  getAccessToken: () => string | null = () => ACCESS_TOKEN,
) {
  const onUnauthorized = vi.fn();
  setHttpClient(
    new HttpClient({
      getAccessToken,
      onUnauthorized,
      fetchImpl,
    }),
  );
  return { onUnauthorized };
}

function callUrl(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): URL {
  return new URL(String(fetchImpl.mock.calls[index]?.[0]), 'http://app.local');
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

afterEach(() => {
  setHttpClient(null);
});

describe('run API URL construction', () => {
  it('GETs the active run with encoded project id and Bearer auth', async () => {
    const payload: ActiveRunResponse = { run: runningRun };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(payload));
    installClient(fetchImpl);

    await expect(getActiveRun(PROJECT_ID)).resolves.toEqual(payload);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs/active');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain(ACCESS_TOKEN);
  });

  it('GETs a run with encoded opaque project and run ids', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(runningRun));
    installClient(fetchImpl);

    await expect(getRun(PROJECT_ID, RUN_ID)).resolves.toEqual(runningRun);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs/run%2Fopaque');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
  });

  it('GETs history with limit=20 and URLSearchParams cursor', async () => {
    const list: RunListResponse = { items: [runningRun], nextCursor: 'next/cursor+' };
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(jsonResponse(list)).mockResolvedValueOnce(jsonResponse(list));
    installClient(fetchImpl);
    const cursor = 'opaque/cursor+value=';

    await expect(listRuns(PROJECT_ID)).resolves.toEqual(list);
    await expect(listRuns(PROJECT_ID, cursor)).resolves.toEqual(list);

    const firstUrl = callUrl(fetchImpl, 0);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(firstUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs');
    expect(firstUrl.searchParams.get('limit')).toBe('20');
    expect(firstUrl.searchParams.get('cursor')).toBeNull();

    const cursorUrl = callUrl(fetchImpl, 1);
    expect(cursorUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs');
    expect(cursorUrl.searchParams.get('limit')).toBe('20');
    expect(cursorUrl.searchParams.get('cursor')).toBe(cursor);
    expect(String(fetchImpl.mock.calls[1]?.[0])).not.toContain(ACCESS_TOKEN);
  });

  it('POSTs start with exactly expectedWorkspaceRevision and no JWT/command/image/resources', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(startingRun, 202));
    installClient(fetchImpl);
    const expectedWorkspaceRevision = parseWorkspaceRevision('rev-1');

    await expect(
      startRun(PROJECT_ID, { expectedWorkspaceRevision }),
    ).resolves.toEqual(startingRun);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain(ACCESS_TOKEN);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(ACCESS_TOKEN);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedWorkspaceRevision: 'rev-1' }),
    );
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toMatch(/command|image|resources|env/);
  });

  it('POSTs stop without a body', async () => {
    const stopping = { ...runningRun, state: 'STOPPING' as const };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(stopping));
    installClient(fetchImpl);

    await expect(stopRun(PROJECT_ID, RUN_ID)).resolves.toEqual(stopping);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs/run%2Fopaque/stop');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain(ACCESS_TOKEN);
  });

  it('POSTs log ticket without JWT/command/image/resources in URL or body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ticket: 'ticket-opaque', expiresAt: TICKET_EXPIRES_AT }),
    );
    installClient(fetchImpl);

    await expect(createLogTicket(PROJECT_ID, RUN_ID)).resolves.toEqual({
      ticket: 'ticket-opaque',
      expiresAt: TICKET_EXPIRES_AT,
    });

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestUrl.pathname).toBe(
      '/api/v1/projects/prj%2Fopaque/runs/run%2Fopaque/log-ticket',
    );
    expect(requestUrl.searchParams.get('ticket')).toBeNull();
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain(ACCESS_TOKEN);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toMatch(/command|image|resources/);
  });

  it('passes AbortSignal unchanged through every run method', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ run: runningRun }))
      .mockResolvedValueOnce(jsonResponse(runningRun))
      .mockResolvedValueOnce(jsonResponse({ items: [runningRun], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(startingRun, 202))
      .mockResolvedValueOnce(jsonResponse({ ...runningRun, state: 'STOPPING' }))
      .mockResolvedValueOnce(
        jsonResponse({ ticket: 'ticket-opaque', expiresAt: TICKET_EXPIRES_AT }),
      );
    installClient(fetchImpl);

    await getActiveRun(PROJECT_ID, controller.signal);
    await getRun(PROJECT_ID, RUN_ID, controller.signal);
    await listRuns(PROJECT_ID, null, controller.signal);
    await startRun(PROJECT_ID, { expectedWorkspaceRevision: parseWorkspaceRevision('rev-1') }, controller.signal);
    await stopRun(PROJECT_ID, RUN_ID, controller.signal);
    await createLogTicket(PROJECT_ID, RUN_ID, controller.signal);

    expect(fetchImpl).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it('requires branded run ids rather than raw strings', () => {
    if (false) {
      // @ts-expect-error raw strings are not branded run ids
      void getRun(PROJECT_ID, 'run-1');
      // @ts-expect-error raw strings are not branded run ids
      void stopRun(PROJECT_ID, 'run-1');
      // @ts-expect-error raw strings are not branded run ids
      void createLogTicket(PROJECT_ID, 'run-1');
    }
  });
});

describe('run API response contracts', () => {
  it('does not return a partial history when one item is invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        items: [runningRun, { ...runningRun, id: 'run-2', startedAt: null }],
        nextCursor: null,
      }),
    );
    installClient(fetchImpl);

    await expect(listRuns(PROJECT_ID)).rejects.toThrow('Invalid run response');
  });

  it('rejects a start payload that includes browser-supplied policy fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ...startingRun, command: 'mvn clean test' }, 202),
    );
    installClient(fetchImpl);

    await expect(
      startRun(PROJECT_ID, { expectedWorkspaceRevision: parseWorkspaceRevision('rev-1') }),
    ).rejects.toThrow('Invalid run response');
  });

  it('rejects an active response that returns a terminal run', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        run: {
          ...runningRun,
          state: 'SUCCEEDED',
          finishedAt: '2026-08-24T10:05:00.000Z',
          terminationReason: 'BUILD_SUCCEEDED',
          exitCode: 0,
        },
      }),
    );
    installClient(fetchImpl);

    await expect(getActiveRun(PROJECT_ID)).rejects.toThrow('Invalid run response');
  });
});
