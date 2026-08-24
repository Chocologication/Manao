import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '../contracts/api';
import type { LoginResponse } from '../contracts/auth';
import {
  parseLogServerFrameJson,
  type LogParseContext,
  type LogServerFrame,
} from '../contracts/log';
import {
  parseActiveRunResponse,
  parseLogTicketResponse,
  parseRunListResponse,
  parseRunSummaryForId,
  parseStartRunResponse,
  type RunSummary,
} from '../contracts/run';
import { parseFileContentResponse } from '../contracts/file';
import { parseProjectRelativePath } from '../features/files/pathPolicy';
import { LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS } from './largeLogPayload';
import {
  GAP_SKIPPED_TEXT,
  PERSISTED_OFFLINE_MARKER,
  RECONNECT_LIVE_MARKER,
  SEED_LOG_MARKER,
} from './runFixtures';
import {
  MOCK_LOG_TICKET_PREFIX,
  MOCK_LOG_TICKET_TTL_MS,
  getMockLogTicketRecords,
  setLogTicketUnavailable,
} from './runSocket';
import {
  advanceMockRunClock,
  appendLogChunk,
  getLogWindow,
  getMockRunNowMs,
  installVirtualRunClock,
  MOCK_RUN_HEARTBEAT_INTERVAL_MS,
  MOCK_RUN_START_DELAY_MS,
  setMockRunPersistNotifyObserver,
  setRunScenario,
} from './runState';
import { ALICE_SEED_PROJECT_ID, BOB_SEED_PROJECT_ID, resetMockState } from './state';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const EPOCH_MS = Date.parse('2026-08-24T10:00:00.000Z');
const SEED_REVISION = 'mock-rev-0001';

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
});

beforeEach(() => {
  resetMockState();
  installVirtualRunClock(EPOCH_MS);
});

function bearerHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function postLogin(username: string, password: string): Promise<Response> {
  return fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function loginOk(username: string, password: string): Promise<LoginResponse> {
  const response = await postLogin(username, password);
  expect(response.status).toBe(200);
  return (await response.json()) as LoginResponse;
}

function runUrl(projectId: string, suffix = '', search?: URLSearchParams): string {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/runs${suffix}`;
  if (search === undefined) {
    return base;
  }
  return `${base}?${search.toString()}`;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function leakPattern(): RegExp {
  return /bob|not found|does not exist|prj-bob|lab-notes|usr-bob|pvc|pod|job|\\\\DeepLearning|C:\\\\|D:\\\\|\/Users\/|\/home\/|\/etc\/|\/var\/|physical/i;
}

async function expectGenericForbidden(response: Response): Promise<ApiErrorBody> {
  expect(response.status).toBe(403);
  const body = await readJson<ApiErrorBody>(response);
  expect(body.code).toBe('FORBIDDEN');
  expect(body.message).toBe('Access denied');
  expect(body.traceId).toEqual(expect.any(String));
  expect(body.message).not.toMatch(leakPattern());
  expect(JSON.stringify(body)).not.toMatch(leakPattern());
  return body;
}

async function expectApiError(
  response: Response,
  status: number,
  code: ApiErrorBody['code'],
): Promise<ApiErrorBody> {
  expect(response.status).toBe(status);
  const body = await readJson<ApiErrorBody>(response);
  expect(body.code).toBe(code);
  expect(body.message).toEqual(expect.any(String));
  expect(body.traceId).toEqual(expect.any(String));
  expect(JSON.stringify(body)).not.toMatch(
    /\\\\DeepLearning|C:\\\\Windows|\/Users\/|\/etc\/passwd|physical|Bearer /i,
  );
  return body;
}

async function startRunHttp(
  token: string,
  projectId: string,
  body: unknown = { expectedWorkspaceRevision: SEED_REVISION },
): Promise<Response> {
  return fetch(runUrl(projectId), {
    method: 'POST',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function startAlice(): Promise<{ token: string; run: RunSummary }> {
  const alice = await loginOk(ALICE.username, ALICE.password);
  const response = await startRunHttp(alice.accessToken, ALICE_SEED_PROJECT_ID);
  expect(response.status).toBe(202);
  const run = parseStartRunResponse(await response.json());
  return { token: alice.accessToken, run };
}

async function issueTicket(
  token: string,
  projectId: string,
  runId: string,
): Promise<{ ticket: string; expiresAt: string }> {
  const response = await fetch(runUrl(projectId, `/${encodeURIComponent(runId)}/log-ticket`), {
    method: 'POST',
    headers: bearerHeaders(token),
  });
  expect(response.status).toBe(200);
  const body = parseLogTicketResponse(await response.json());
  expect(body.ticket.startsWith(MOCK_LOG_TICKET_PREFIX)).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/Bearer |tok-\d/);
  return body;
}

function runLogWsUrl(ticket: string): string {
  const search = new URLSearchParams();
  search.set('ticket', ticket);
  return `ws://localhost/api/v1/ws/run-logs?${search.toString()}`;
}

function openSocket(ticket: string): WebSocket {
  const socket = new WebSocket(runLogWsUrl(ticket));
  sockets.push(socket);
  return socket;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
    socket.addEventListener('close', (event) => {
      reject(new Error(`closed before open:${event.code}`));
    }, { once: true });
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number }> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: 1006 });
  }
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve({ code: event.code });
    }, { once: true });
  });
}

function subscribe(socket: WebSocket, lastSeq: number | null): void {
  socket.send(JSON.stringify({ type: 'log.subscribe', lastSeq }));
}

class FrameReader {
  private readonly buffered: LogServerFrame[] = [];
  private readonly waiters: Array<(frame: LogServerFrame) => void> = [];

  constructor(socket: WebSocket, context: LogParseContext) {
    socket.addEventListener('message', (event) => {
      const frame = parseLogServerFrameJson(String(event.data), context);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(frame);
        return;
      }
      this.buffered.push(frame);
    });
  }

  next(): Promise<LogServerFrame> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async collect(count: number): Promise<LogServerFrame[]> {
    const frames: LogServerFrame[] = [];
    while (frames.length < count) {
      frames.push(await this.next());
    }
    return frames;
  }
}

function contextOf(run: RunSummary): LogParseContext {
  return { projectId: ALICE_SEED_PROJECT_ID, runId: run.id };
}

describe('MSW run HTTP handlers', () => {
  const dummyRun = 'run-000001';

  function endpoints(token: string | null, projectId: string): Array<[string, Promise<Response>]> {
    const headers: HeadersInit =
      token === null
        ? { Accept: 'application/json' }
        : bearerHeaders(token);
    const jsonHeaders: HeadersInit =
      token === null
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { ...bearerHeaders(token), 'Content-Type': 'application/json' };
    return [
      ['active', fetch(runUrl(projectId, '/active'), { headers })],
      ['list', fetch(runUrl(projectId, '', new URLSearchParams({ limit: '20' })), { headers })],
      ['detail', fetch(runUrl(projectId, `/${dummyRun}`), { headers })],
      [
        'start',
        fetch(runUrl(projectId), {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ expectedWorkspaceRevision: SEED_REVISION }),
        }),
      ],
      [
        'stop',
        fetch(runUrl(projectId, `/${dummyRun}/stop`), { method: 'POST', headers }),
      ],
      [
        'ticket',
        fetch(runUrl(projectId, `/${dummyRun}/log-ticket`), { method: 'POST', headers }),
      ],
    ];
  }

  it('returns 401 for every run endpoint without a current Bearer user', async () => {
    for (const [label, pending] of endpoints(null, ALICE_SEED_PROJECT_ID)) {
      const response = await pending;
      expect(response.status, label).toBe(401);
      const body = await readJson<ApiErrorBody>(response);
      expect(body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('returns the same generic 403 for unknown, non-owned and non-READY projects', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const creating = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: {
        ...bearerHeaders(alice.accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Creating' }),
    });
    expect(creating.status).toBe(202);
    const creatingId = ((await creating.json()) as { id: string }).id;

    const foreignBodies: ApiErrorBody[] = [];
    for (const [label, pending] of endpoints(alice.accessToken, BOB_SEED_PROJECT_ID)) {
      foreignBodies.push(await expectGenericForbidden(await pending));
      expect(label).toEqual(expect.any(String));
    }
    const unknownBodies: ApiErrorBody[] = [];
    for (const [, pending] of endpoints(alice.accessToken, 'prj-does-not-exist')) {
      unknownBodies.push(await expectGenericForbidden(await pending));
    }
    for (const [, pending] of endpoints(alice.accessToken, creatingId)) {
      await expectGenericForbidden(await pending);
    }
    expect(foreignBodies[0]?.message).toBe(unknownBodies[0]?.message);
  });

  it('starts with 202 parsed STARTING and rejects extra start fields', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const created = await startRunHttp(alice.accessToken, ALICE_SEED_PROJECT_ID);
    expect(created.status).toBe(202);
    const run = parseStartRunResponse(await created.json());
    expect(run.state).toBe('STARTING');
    expect(run.id).not.toMatch(/job-|pod-|pvc-/i);
    expect(run.policy.command).toBe('mvn clean test');

    await expectApiError(
      await startRunHttp(alice.accessToken, ALICE_SEED_PROJECT_ID, {
        expectedWorkspaceRevision: SEED_REVISION,
        command: 'mvn clean test',
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('checks workspace revision and active start conflicts', async () => {
    const { token } = await startAlice();
    await expectApiError(
      await startRunHttp(token, ALICE_SEED_PROJECT_ID, {
        expectedWorkspaceRevision: SEED_REVISION,
      }),
      409,
      'RUN_ALREADY_ACTIVE',
    );
    resetMockState();
    installVirtualRunClock(EPOCH_MS);
    const fresh = await loginOk(ALICE.username, ALICE.password);
    await expectApiError(
      await startRunHttp(fresh.accessToken, ALICE_SEED_PROJECT_ID, {
        expectedWorkspaceRevision: 'mock-rev-9999',
      }),
      409,
      'WORKSPACE_REVISION_CONFLICT',
    );
  });

  it('returns active, detail, history and idempotent stop', async () => {
    const { token, run } = await startAlice();
    const active = parseActiveRunResponse(
      await (await fetch(runUrl(ALICE_SEED_PROJECT_ID, '/active'), { headers: bearerHeaders(token) })).json(),
    );
    expect(active.run?.id).toBe(run.id);
    expect(active.run?.state).toBe('STARTING');

    const detail = parseRunSummaryForId(
      await (
        await fetch(runUrl(ALICE_SEED_PROJECT_ID, `/${encodeURIComponent(run.id)}`), {
          headers: bearerHeaders(token),
        })
      ).json(),
      run.id,
    );
    expect(detail.id).toBe(run.id);

    const listed = parseRunListResponse(
      await (
        await fetch(runUrl(ALICE_SEED_PROJECT_ID, '', new URLSearchParams({ limit: '20' })), {
          headers: bearerHeaders(token),
        })
      ).json(),
    );
    expect(listed.items.map((item) => item.id)).toEqual([run.id]);
    expect(listed.nextCursor).toBeNull();

    const firstStop = await fetch(runUrl(ALICE_SEED_PROJECT_ID, `/${encodeURIComponent(run.id)}/stop`), {
      method: 'POST',
      headers: bearerHeaders(token),
    });
    expect(firstStop.status).toBe(200);
    expect(parseRunSummaryForId(await firstStop.json(), run.id).state).toBe('STOPPING');
    const secondStop = await fetch(runUrl(ALICE_SEED_PROJECT_ID, `/${encodeURIComponent(run.id)}/stop`), {
      method: 'POST',
      headers: bearerHeaders(token),
    });
    expect(secondStop.status).toBe(200);
    expect(parseRunSummaryForId(await secondStop.json(), run.id).state).toBe('STOPPING');

    await expectApiError(
      await fetch(runUrl(ALICE_SEED_PROJECT_ID, '/run-missing'), { headers: bearerHeaders(token) }),
      404,
      'RUN_NOT_FOUND',
    );
  });

  it('locks file writes with PROJECT_LOCKED while a Run is active and leaves reads unlocked', async () => {
    const { token } = await startAlice();
    const save = await fetch(
      `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/files/content?path=README.md`,
      {
        method: 'PUT',
        headers: {
          ...bearerHeaders(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'locked-by-run', expectedWorkspaceRevision: SEED_REVISION }),
      },
    );
    await expectApiError(save, 409, 'PROJECT_LOCKED');

    const create = await fetch(`/api/v1/projects/${ALICE_SEED_PROJECT_ID}/entries`, {
      method: 'POST',
      headers: {
        ...bearerHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'file',
        path: 'locked.txt',
        expectedWorkspaceRevision: SEED_REVISION,
      }),
    });
    await expectApiError(create, 409, 'PROJECT_LOCKED');

    const content = await fetch(
      `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/files/content?path=README.md`,
      { headers: bearerHeaders(token) },
    );
    expect(content.status).toBe(200);
    const parsed = parseFileContentResponse(
      await content.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(parsed.content).toContain('Alice Notebook');
    expect(parsed.workspaceRevision).toBe(SEED_REVISION);

    const download = await fetch(
      `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/files/download?path=README.md`,
      { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${token}` } },
    );
    expect(download.status).toBe(200);
  });
});

describe('one-time log tickets', () => {
  it('binds user, project, run, expiry and used flag without storing a JWT', async () => {
    const { token, run } = await startAlice();
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    expect(issued.ticket.startsWith(MOCK_LOG_TICKET_PREFIX)).toBe(true);
    expect(issued.expiresAt).toBe(new Date(EPOCH_MS + MOCK_LOG_TICKET_TTL_MS).toISOString());
    const records = getMockLogTicketRecords();
    expect(records).toEqual([
      {
        ticket: issued.ticket,
        userId: 'usr-alice',
        projectId: ALICE_SEED_PROJECT_ID,
        runId: run.id,
        expiresAtMs: EPOCH_MS + MOCK_LOG_TICKET_TTL_MS,
        used: false,
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/Bearer |tok-\d|demo-pass/);
  });

  it('returns HTTP 503 LOG_TICKET_NOT_AVAILABLE when the mock flag is set', async () => {
    const { token, run } = await startAlice();
    setLogTicketUnavailable(true);
    await expectApiError(
      await fetch(runUrl(ALICE_SEED_PROJECT_ID, `/${encodeURIComponent(run.id)}/log-ticket`), {
        method: 'POST',
        headers: bearerHeaders(token),
      }),
      503,
      'LOG_TICKET_NOT_AVAILABLE',
    );
  });

  it('rejects a ticket for the wrong owner or missing run', async () => {
    const { run } = await startAlice();
    const bob = await loginOk(BOB.username, BOB.password);
    await expectGenericForbidden(
      await fetch(runUrl(ALICE_SEED_PROJECT_ID, `/${encodeURIComponent(run.id)}/log-ticket`), {
        method: 'POST',
        headers: bearerHeaders(bob.accessToken),
      }),
    );
    const alice = await loginOk(ALICE.username, ALICE.password);
    await expectApiError(
      await fetch(runUrl(ALICE_SEED_PROJECT_ID, '/run-other/log-ticket'), {
        method: 'POST',
        headers: bearerHeaders(alice.accessToken),
      }),
      404,
      'RUN_NOT_FOUND',
    );
  });

  it('closes expired, reused and missing tickets with handshake codes', async () => {
    const { token, run } = await startAlice();
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    advanceMockRunClock(MOCK_LOG_TICKET_TTL_MS);
    const expired = openSocket(issued.ticket);
    expect((await waitForClose(expired)).code).toBe(4408);

    const fresh = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const first = openSocket(fresh.ticket);
    await waitForOpen(first);
    const reused = openSocket(fresh.ticket);
    expect((await waitForClose(reused)).code).toBe(4409);

    const missing = openSocket('mock-run-log-ticket-missing');
    expect((await waitForClose(missing)).code).toBe(4401);
    const empty = new WebSocket('ws://localhost/api/v1/ws/run-logs');
    sockets.push(empty);
    expect((await waitForClose(empty)).code).toBe(4401);
  });

  it('clears tickets on resetMockState', async () => {
    const { token, run } = await startAlice();
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    resetMockState();
    installVirtualRunClock(EPOCH_MS);
    expect(getMockLogTicketRecords()).toEqual([]);
    const leftover = openSocket(issued.ticket);
    expect((await waitForClose(leftover)).code).toBe(4401);
  });
});

describe('MSW run log WebSocket', () => {
  it('replays the persisted gap then forwards live append, state and heartbeat', async () => {
    setRunScenario('gap');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    expect(socket.url).toContain('/api/v1/ws/run-logs');
    expect(socket.url).toContain('ticket=');
    expect(socket.url).not.toMatch(/Bearer |tok-\d/);
    await waitForOpen(socket);
    const ctx = contextOf(run);
    const reader = new FrameReader(socket, ctx);
    subscribe(socket, null);
    const replay = await reader.next();
    const state = await reader.next();
    expect(replay.type).toBe('log.replay');
    if (replay.type === 'log.replay') {
      expect(replay.chunks[0]?.text).toContain(SEED_LOG_MARKER);
    }
    expect(state).toMatchObject({ type: 'run.state', run: { id: run.id, state: 'RUNNING' } });
    advanceMockRunClock(MOCK_RUN_HEARTBEAT_INTERVAL_MS);
    const heartbeat = await reader.next();
    expect(heartbeat.type).toBe('stream.heartbeat');
    if (heartbeat.type === 'stream.heartbeat') {
      expect(heartbeat.serverTime).toBe(new Date(getMockRunNowMs()).toISOString());
    }
  });

  it('closes invalid protocol without sending partial log chunks', async () => {
    const { token, run } = await startAlice();
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const frames: string[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(String(event.data));
    });
    socket.send(JSON.stringify({ type: 'terminal.resize', cols: 80, rows: 24 }));
    const closed = await waitForClose(socket);
    expect(closed.code).not.toBe(1011);
    expect(frames.some((item) => item.includes('"type":"log.replay"'))).toBe(false);
    expect(frames.some((item) => item.includes('"type":"log.append"'))).toBe(false);
    const parsed = frames.map((item) => JSON.parse(item) as { type?: string; retryable?: boolean });
    expect(parsed.some((item) => item.type === 'stream.error' && item.retryable === false)).toBe(true);
  });

  it('emits log.append only after the persisted window already contains the chunk', async () => {
    setRunScenario('large-log');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const ctx = contextOf(run);
    const reader = new FrameReader(socket, ctx);
    subscribe(socket, 1);
    await reader.collect(2);
    const phases: string[] = [];
    setMockRunPersistNotifyObserver((phase, event) => {
      if (event.type === 'log.append') {
        phases.push(phase);
      }
    });
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'live-line\n');
    const frame = await reader.next();
    expect(frame.type).toBe('log.append');
    if (frame.type === 'log.append') {
      const window = getLogWindow(ALICE_SEED_PROJECT_ID, run.id);
      expect(window?.chunks.some((chunk) => chunk.seq === frame.chunk.seq)).toBe(true);
    }
    // mock persist-before-send ordering only
    expect(phases[0]).toBe('persist');
    expect(phases.indexOf('persist')).toBeLessThan(phases.indexOf('notify'));
    expect(phases.indexOf('persist')).toBeLessThan(phases.length);
  });

  it('replays a persisted chunk after a forced disconnect', async () => {
    setRunScenario('large-log');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const firstTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const first = openSocket(firstTicket.ticket);
    await waitForOpen(first);
    const ctx = contextOf(run);
    const firstReader = new FrameReader(first, ctx);
    subscribe(first, 1);
    await firstReader.collect(2);
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'catch-me\n');
    first.close();
    await waitForClose(first);
    expect(getLogWindow(ALICE_SEED_PROJECT_ID, run.id)?.chunks.some((chunk) => chunk.text === 'catch-me\n')).toBe(
      true,
    );
    const secondTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const second = openSocket(secondTicket.ticket);
    await waitForOpen(second);
    const secondReader = new FrameReader(second, ctx);
    subscribe(second, 1);
    const replay = await secondReader.next();
    expect(replay.type).toBe('log.replay');
    if (replay.type === 'log.replay') {
      expect(replay.chunks.some((chunk) => chunk.text === 'catch-me\n')).toBe(true);
    }
  });

  it('skips a live seq for gap while keeping it in the persisted window', async () => {
    setRunScenario('gap');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const ctx = contextOf(run);
    const reader = new FrameReader(socket, ctx);
    subscribe(socket, 1);
    await reader.collect(2);
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, GAP_SKIPPED_TEXT);
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'visible\n');
    const live = await reader.next();
    expect(live.type).toBe('log.append');
    if (live.type === 'log.append') {
      expect(live.chunk.text).toBe('visible\n');
      expect(live.chunk.seq).toBe(3);
    }
    const window = getLogWindow(ALICE_SEED_PROJECT_ID, run.id);
    expect(window?.chunks.map((chunk) => chunk.text)).toEqual([
      expect.stringContaining(SEED_LOG_MARKER),
      GAP_SKIPPED_TEXT,
      'visible\n',
    ]);
  });

  it('can emit a duplicate live append that already exists in the persisted window', async () => {
    setRunScenario('gap');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const ctx = contextOf(run);
    const reader = new FrameReader(socket, ctx);
    subscribe(socket, 1);
    await reader.collect(2);
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'once\n');
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'twice\n');
    const first = await reader.next();
    const second = await reader.next();
    expect(first.type).toBe('log.append');
    expect(second.type).toBe('log.append');
    if (first.type === 'log.append' && second.type === 'log.append') {
      expect(first.chunk).toEqual(second.chunk);
      expect(first.chunk.text).toBe('once\n');
      expect(
        getLogWindow(ALICE_SEED_PROJECT_ID, run.id)?.chunks.filter((chunk) => chunk.seq === first.chunk.seq),
      ).toHaveLength(1);
    }
  });

  it('disconnects large-log midstream while appends continue, then replays the gap', async () => {
    setRunScenario('large-log');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const firstTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const first = openSocket(firstTicket.ticket);
    await waitForOpen(first);
    const ctx = contextOf(run);
    const firstReader = new FrameReader(first, ctx);
    subscribe(first, 1);
    await firstReader.collect(2);
    const closed = waitForClose(first);
    for (let index = 0; index < LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS; index += 1) {
      appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, `live-${index}\n`);
    }
    expect((await closed).code).toBe(1011);
    appendLogChunk(ALICE_SEED_PROJECT_ID, run.id, 'while-disconnected\n');
    expect(
      getLogWindow(ALICE_SEED_PROJECT_ID, run.id)?.chunks.some((chunk) => chunk.text === 'while-disconnected\n'),
    ).toBe(true);
    const secondTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    expect(secondTicket.ticket).not.toBe(firstTicket.ticket);
    const second = openSocket(secondTicket.ticket);
    await waitForOpen(second);
    const secondReader = new FrameReader(second, ctx);
    subscribe(second, LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS);
    const replay = await secondReader.next();
    expect(replay.type).toBe('log.replay');
    if (replay.type === 'log.replay') {
      expect(replay.chunks.some((chunk) => chunk.text === 'while-disconnected\n')).toBe(true);
    }
  });

  it('closes disconnect with retryable 1011 after replay', async () => {
    setRunScenario('disconnect');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const frames: LogServerFrame[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(parseLogServerFrameJson(String(event.data), contextOf(run)));
    });
    subscribe(socket, null);
    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1011);
    expect(frames[0]?.type).toBe('log.replay');
    expect(frames.some((frame) => frame.type === 'stream.error' && frame.retryable)).toBe(true);
    expect(frames.some((frame) => frame.type === 'log.append')).toBe(false);
    expect(
      getLogWindow(ALICE_SEED_PROJECT_ID, run.id)?.chunks.some((chunk) =>
        chunk.text.includes(PERSISTED_OFFLINE_MARKER),
      ),
    ).toBe(true);
  });

  it('replays chunks persisted while disconnected, then lives', async () => {
    setRunScenario('disconnect');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const firstTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const first = openSocket(firstTicket.ticket);
    await waitForOpen(first);
    const ctx = contextOf(run);
    subscribe(first, null);
    await waitForClose(first);
    const secondTicket = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    expect(secondTicket.ticket).not.toBe(firstTicket.ticket);
    const second = openSocket(secondTicket.ticket);
    await waitForOpen(second);
    const secondReader = new FrameReader(second, ctx);
    subscribe(second, 1);
    const replay = await secondReader.next();
    const state = await secondReader.next();
    const live = await secondReader.next();
    expect(replay.type).toBe('log.replay');
    expect(state.type).toBe('run.state');
    expect(live.type).toBe('log.append');
    if (replay.type === 'log.replay' && live.type === 'log.append') {
      expect(replay.chunks.some((chunk) => chunk.text.includes(PERSISTED_OFFLINE_MARKER))).toBe(true);
      expect(replay.chunks.some((chunk) => chunk.text.includes(RECONNECT_LIVE_MARKER))).toBe(false);
      expect(live.chunk.text).toContain(RECONNECT_LIVE_MARKER);
      const replayMax = Math.max(...replay.chunks.map((chunk) => chunk.seq));
      expect(live.chunk.seq).toBe(replayMax + 1);
    }
  });

  it('does not emit heartbeats until the mock clock advances', async () => {
    setRunScenario('large-log');
    const { token, run } = await startAlice();
    advanceMockRunClock(MOCK_RUN_START_DELAY_MS);
    const issued = await issueTicket(token, ALICE_SEED_PROJECT_ID, run.id);
    const socket = openSocket(issued.ticket);
    await waitForOpen(socket);
    const ctx = contextOf(run);
    const reader = new FrameReader(socket, ctx);
    subscribe(socket, null);
    const opening = await reader.collect(2);
    expect(opening.map((frame) => frame.type)).toEqual(['log.replay', 'run.state']);
    advanceMockRunClock(MOCK_RUN_HEARTBEAT_INTERVAL_MS - 1);
    const late: LogServerFrame[] = [];
    socket.addEventListener('message', (event) => {
      late.push(parseLogServerFrameJson(String(event.data), ctx));
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(late.some((frame) => frame.type === 'stream.heartbeat')).toBe(false);
  });
});
