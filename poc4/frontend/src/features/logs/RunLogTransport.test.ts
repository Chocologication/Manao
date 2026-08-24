import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../api/ApiRequestError';
import type { LogChunk, LogWindowMeta } from '../../contracts/log';
import { parseRunId, type LogTicket, type RunSummary } from '../../contracts/run';
import { isWorkspaceEditable, RunAuthorityCoordinator } from '../runs/RunAuthorityCoordinator';
import { runKeys } from '../runs/runQueries';
import { ConnectionRegistry } from '../../runtime/ConnectionRegistry';
import { LOG_HEARTBEAT_WATCHDOG_MS, LOG_WS_CLOSE_CODE, LOG_WS_PATH } from './logProtocol';
import { RunLogStore } from './RunLogStore';
import {
  applyValidatedRunStateFrame,
  buildRunLogWebSocketUrl,
  RunLogTransport,
  type RunLogTransportOptions,
} from './RunLogTransport';

const PROJECT_ID = 'prj-1';
const RUN_ID = parseRunId('run-1');
const PERSISTED_AT = '2026-08-24T10:00:02.000Z';
const SERVER_TIME = '2026-08-24T10:00:03.000Z';
const TICKET_EXPIRES = '2026-08-24T10:00:30.000Z';
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

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function chunk(seq: number, text: string): LogChunk {
  return { seq, text, byteLength: utf8Bytes(text), persistedAt: PERSISTED_AT };
}

function windowFromChunks(
  chunks: readonly LogChunk[],
  extra: Partial<LogWindowMeta> = {},
): LogWindowMeta {
  const retainedBytes = chunks.reduce((sum, item) => sum + item.byteLength, 0);
  return {
    firstAvailableSeq: chunks[0]?.seq ?? null,
    lastAvailableSeq: chunks[chunks.length - 1]?.seq ?? null,
    retainedBytes,
    truncated: false,
    evictedBytes: 0,
    ...extra,
  };
}

function lockingRun(id = 'run-1', state: 'STARTING' | 'RUNNING' = 'RUNNING'): RunSummary {
  return {
    id: parseRunId(id),
    state,
    requestedWorkspaceRevision: 'rev-1' as RunSummary['requestedWorkspaceRevision'],
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

function terminalRun(id = 'run-1'): RunSummary {
  return {
    ...lockingRun(id),
    state: 'SUCCEEDED',
    finishedAt: '2026-08-24T10:00:05.000Z',
    terminationReason: 'BUILD_SUCCEEDED',
    exitCode: 0,
    lastLogSeq: 2,
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; code?: number; reason?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.closed.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  error(): void {
    this.emit('error', {});
  }

  remoteClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: unknown) {
      timers.delete(Number(id));
    },
    advance(ms: number) {
      now += ms;
      clock.flush();
    },
    flush() {
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.fn();
            ran = true;
          }
        }
      }
    },
    pendingCount() {
      return timers.size;
    },
  };
  return clock;
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function replayFrame(chunks: LogChunk[]) {
  return { type: 'log.replay', chunks, window: windowFromChunks(chunks) };
}

function appendFrame(
  item: LogChunk,
  retained: readonly LogChunk[] = [item],
  extra: Partial<LogWindowMeta> = {},
) {
  return { type: 'log.append', chunk: item, window: windowFromChunks(retained, extra) };
}

type Harness = {
  transport: RunLogTransport;
  store: RunLogStore;
  sockets: FakeWebSocket[];
  clock: ReturnType<typeof createClock>;
  createTicket: ReturnType<typeof vi.fn>;
  getAccessToken: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
  registry: ConnectionRegistry;
  queryClient: QueryClient;
  reconcile: ReturnType<typeof vi.fn>;
  onlineListeners: Set<() => void>;
  offlineListeners: Set<() => void>;
  setOnline: (value: boolean) => void;
};

function createHarness(overrides: Partial<RunLogTransportOptions> = {}): Harness {
  const clock = createClock();
  const sockets: FakeWebSocket[] = [];
  const projectId = overrides.projectId ?? PROJECT_ID;
  const runId = overrides.runId ?? RUN_ID;
  const store =
    overrides.store ??
    new RunLogStore({
      projectId,
      runId,
      schedule: (notify) => {
        notify();
        return () => {};
      },
    });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const registry = new ConnectionRegistry();
  const createTicket = vi.fn(async () => ({
    ticket: `ticket-${createTicket.mock.calls.length}` as LogTicket,
    expiresAt: TICKET_EXPIRES,
  }));
  let token: string | null = 'alice-token';
  const getAccessToken = vi.fn(() => token);
  const onUnauthorized = vi.fn();
  const reconcile = vi.fn();
  const onlineListeners = new Set<() => void>();
  const offlineListeners = new Set<() => void>();
  let online = true;
  const transport = new RunLogTransport({
    coordinator: { reconcile },
    connectionRegistry: registry,
    createTicket,
    getAccessToken,
    onUnauthorized,
    webSocketFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    location: { protocol: 'http:', host: 'localhost:4173' },
    jitter: false,
    heartbeatWatchdogMs: LOG_HEARTBEAT_WATCHDOG_MS,
    addWindowListener: (type, listener) => {
      (type === 'online' ? onlineListeners : offlineListeners).add(listener);
    },
    removeWindowListener: (type, listener) => {
      (type === 'online' ? onlineListeners : offlineListeners).delete(listener);
    },
    isOnline: () => online,
    ...overrides,
    projectId,
    runId,
    store,
    queryClient,
    setTimeout: overrides.setTimeout ?? clock.setTimeout,
    clearTimeout: overrides.clearTimeout ?? clock.clearTimeout,
  });
  return {
    transport,
    store,
    sockets,
    clock,
    createTicket,
    getAccessToken,
    onUnauthorized,
    registry,
    queryClient,
    reconcile,
    onlineListeners,
    offlineListeners,
    setOnline(value) {
      online = value;
    },
  };
}

const harnesses: Harness[] = [];

function harness(overrides?: Partial<RunLogTransportOptions>): Harness {
  const created = createHarness(overrides);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const item of harnesses.splice(0)) {
    item.transport.dispose();
    item.store.dispose();
    item.queryClient.clear();
  }
});

async function openLive(item: Harness, chunks: LogChunk[] = [chunk(1, 'a')]): Promise<FakeWebSocket> {
  item.transport.connect();
  await microtasks();
  const socket = item.sockets[item.sockets.length - 1];
  expect(socket).toBeDefined();
  socket!.open();
  socket!.message(JSON.stringify(replayFrame(chunks)));
  return socket!;
}

describe('buildRunLogWebSocketUrl', () => {
  it('accepts only the current http(s) origin and encodes the ticket once', () => {
    const ticket = 'a+b/c?=d&e';
    const httpUrl = buildRunLogWebSocketUrl({ protocol: 'http:', host: 'localhost:4173' }, ticket);
    expect(httpUrl).toBe(`ws://localhost:4173${LOG_WS_PATH}?ticket=${encodeURIComponent(ticket)}`);
    expect(new URL(httpUrl).searchParams.get('ticket')).toBe(ticket);
    expect(httpUrl.match(/ticket=/g)).toHaveLength(1);

    const httpsUrl = buildRunLogWebSocketUrl({ protocol: 'https:', host: 'app.example' }, ticket);
    expect(httpsUrl.startsWith('wss://app.example/')).toBe(true);
    expect(httpsUrl).toContain(LOG_WS_PATH);
    expect(httpsUrl).not.toContain('Bearer');
    expect(httpsUrl).not.toContain('alice-token');
  });

  it('rejects non-http origins and does not embed a JWT', () => {
    expect(() => buildRunLogWebSocketUrl({ protocol: 'ws:', host: 'localhost' }, 'ticket')).toThrow(
      /origin protocol/i,
    );
    expect(() => buildRunLogWebSocketUrl({ protocol: 'file:', host: 'localhost' }, 'ticket')).toThrow(
      /origin protocol/i,
    );
    expect(() => buildRunLogWebSocketUrl({ protocol: 'http:', host: 'localhost/evil' }, 'ticket')).toThrow(
      /host/i,
    );
  });
});

describe('RunLogTransport ticket and connection lifecycle', () => {
  it('registers with ConnectionRegistry and is idempotent for connect/close/dispose', async () => {
    const item = harness();
    item.transport.connect();
    item.transport.connect();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    expect(item.store.getSnapshot().connection).toBe('connecting');
    expect(item.sockets).toHaveLength(1);
    expect(item.sockets[0]?.url).toBe('ws://localhost:4173/api/v1/ws/run-logs?ticket=ticket-1');
    expect(item.sockets[0]?.url).not.toContain('alice-token');

    item.sockets[0]?.open();
    expect(item.sockets[0]?.sent).toEqual([JSON.stringify({ type: 'log.subscribe', lastSeq: null })]);
    expect(item.store.getSnapshot().connection).toBe('replaying');

    item.transport.close();
    item.transport.close();
    expect(item.sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(item.store.getSnapshot().connection).toBe('idle');

    item.transport.dispose();
    item.transport.dispose();
    item.registry.closeAll();
  });

  it('closeAll still closes remaining connections when the transport closer runs', async () => {
    const item = harness();
    const remaining = vi.fn();
    item.registry.register(remaining);
    item.transport.connect();
    await microtasks();
    item.registry.closeAll();
    expect(item.sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(remaining).toHaveBeenCalledTimes(1);
    expect(() => item.transport.dispose()).not.toThrow();
  });

  it('requests a fresh ticket per reconnect and subscribes with last applied seq', async () => {
    const item = harness();
    const retained = [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')];
    const first = await openLive(item, [retained[0]!, retained[1]!]);
    first.message(JSON.stringify(appendFrame(retained[2]!, retained)));
    expect(item.store.getSnapshot().lastAppliedSeq).toBe(3);
    first.remoteClose(1011, 'server exploded');
    expect(item.store.getSnapshot().connection).toBe('reconnecting');
    expect(item.store.getSnapshot().chunks).toHaveLength(3);
    item.clock.flush();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(2);
    item.sockets[1]?.open();
    expect(item.sockets[1]?.sent).toEqual([JSON.stringify({ type: 'log.subscribe', lastSeq: 3 })]);
  });
});

describe('RunLogTransport reconnect policy', () => {
  it('backs off 0, 500, 1s, 2s, 5s then remains 5s while handshake keeps failing', async () => {
    const item = harness();
    item.transport.connect();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    item.sockets[0]?.remoteClose(4408, 'expired secret');
    const delays = [0, 500, 1_000, 2_000, 5_000, 5_000];
    for (const [index, delay] of delays.entries()) {
      if (delay > 0) {
        item.clock.advance(delay - 1);
        await microtasks();
        expect(item.createTicket).toHaveBeenCalledTimes(index + 1);
        item.clock.advance(1);
      } else {
        item.clock.flush();
      }
      await microtasks();
      expect(item.createTicket).toHaveBeenCalledTimes(index + 2);
      item.sockets[index + 1]?.remoteClose(4408, 'expired again');
    }
  });

  it('reconnects from last applied seq after a gap and ignores duplicates', async () => {
    const item = harness();
    const socket = await openLive(item, [chunk(1, 'a')]);
    socket.message(JSON.stringify(appendFrame(chunk(1, 'dup'))));
    expect(item.store.getSnapshot().chunks).toHaveLength(1);
    socket.message(JSON.stringify(appendFrame(chunk(3, 'gap'))));
    expect(item.store.getSnapshot().lastAppliedSeq).toBe(1);
    expect(item.store.getSnapshot().connection).toBe('reconnecting');
    item.clock.flush();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(2);
    item.sockets[1]?.open();
    expect(item.sockets[1]?.sent).toEqual([JSON.stringify({ type: 'log.subscribe', lastSeq: 1 })]);
  });

  it('reconnects on heartbeat watchdog timeout and ignores stale generation frames', async () => {
    const item = harness();
    const first = await openLive(item);
    first.message(JSON.stringify({ type: 'stream.heartbeat', serverTime: SERVER_TIME }));
    item.clock.advance(LOG_HEARTBEAT_WATCHDOG_MS - 1);
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    item.clock.advance(1);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(2);
    expect(item.store.getSnapshot().chunks.map((itemChunk) => itemChunk.seq)).toEqual([1]);
    const stale = chunk(2, 'stale');
    first.message(JSON.stringify(appendFrame(stale)));
    expect(item.store.getSnapshot().chunks.map((itemChunk) => itemChunk.seq)).toEqual([1]);
    item.sockets[1]?.open();
    item.sockets[1]?.message(JSON.stringify(replayFrame([chunk(2, 'fresh')])));
    expect(item.store.getSnapshot().lastAppliedSeq).toBe(2);
  });

  it('waits for online after offline without deleting logs', async () => {
    const item = harness();
    await openLive(item, [chunk(1, 'keep')]);
    item.setOnline(false);
    for (const listener of item.offlineListeners) {
      listener();
    }
    expect(item.store.getSnapshot().connection).toBe('reconnecting');
    expect(item.store.getSnapshot().chunks).toHaveLength(1);
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    item.setOnline(true);
    for (const listener of item.onlineListeners) {
      listener();
    }
    item.clock.flush();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(2);
  });

  it('reconnects on 503 LOG_TICKET_NOT_AVAILABLE without unlocking', async () => {
    const item = harness();
    item.createTicket.mockRejectedValueOnce(
      new ApiRequestError(503, {
        code: 'LOG_TICKET_NOT_AVAILABLE',
        message: 'Log ticket not available',
        traceId: 't',
      }),
    );
    item.transport.connect();
    await microtasks();
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'reconnecting', error: null });
    item.clock.flush();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(2);
  });

  it('stops on 403 and non-retryable stream errors with an explicit error', async () => {
    const forbidden = harness();
    forbidden.createTicket.mockRejectedValueOnce(
      new ApiRequestError(403, { code: 'FORBIDDEN', message: 'Access denied', traceId: 't' }),
    );
    forbidden.transport.connect();
    await microtasks();
    expect(forbidden.store.getSnapshot()).toMatchObject({ connection: 'failed', error: 'FORBIDDEN' });
    forbidden.clock.advance(5_000);
    await microtasks();
    expect(forbidden.createTicket).toHaveBeenCalledTimes(1);

    const item = harness();
    const socket = await openLive(item);
    socket.message(JSON.stringify({ type: 'stream.error', code: 'PROTOCOL_ERROR', retryable: false }));
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'failed', error: 'PROTOCOL_ERROR' });
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('lets HttpClient handle ticket 401 and binds WS unauthenticated cleanup to the captured token', async () => {
    const current = harness();
    current.createTicket.mockRejectedValueOnce(
      new ApiRequestError(401, { code: 'UNAUTHENTICATED', message: 'expired', traceId: 't' }),
    );
    current.transport.connect();
    await microtasks();
    expect(current.onUnauthorized).not.toHaveBeenCalled();

    const stale = harness();
    const socket = await openLive(stale);
    stale.getAccessToken.mockReturnValue('bob-token');
    socket.remoteClose(4401, 'Bearer alice-token leaked reason');
    expect(stale.onUnauthorized).not.toHaveBeenCalled();
    expect(JSON.stringify(stale.store.getSnapshot())).not.toContain('alice-token');
    expect(JSON.stringify(stale.store.getSnapshot())).not.toContain('Bearer');

    const live = harness();
    const liveSocket = await openLive(live);
    liveSocket.message(
      JSON.stringify({ type: 'stream.error', code: 'UNAUTHENTICATED', retryable: false }),
    );
    expect(live.onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('RunLogTransport run.state cache updates', () => {
  it('sets active for matching locking frames and never stores terminal as active', async () => {
    const item = harness();
    const socket = await openLive(item);
    const running = lockingRun();
    socket.message(JSON.stringify({ type: 'run.state', run: running }));
    expect(item.queryClient.getQueryData(runKeys.active(PROJECT_ID))).toEqual({ run: running });
    expect(item.queryClient.getQueryData(runKeys.detail(PROJECT_ID, RUN_ID))).toEqual(running);
    expect(item.reconcile).toHaveBeenCalledWith('success', running);

    item.queryClient.setQueryData(runKeys.history(PROJECT_ID), {
      pages: [{ items: [running], nextCursor: null }],
      pageParams: [null],
    });
    const succeeded = terminalRun();
    socket.message(JSON.stringify({ type: 'run.state', run: succeeded }));
    expect(item.queryClient.getQueryData(runKeys.detail(PROJECT_ID, RUN_ID))).toEqual(succeeded);
    expect(item.queryClient.getQueryData(runKeys.history(PROJECT_ID))).toEqual({
      pages: [{ items: [succeeded], nextCursor: null }],
      pageParams: [null],
    });
    expect(JSON.stringify(item.queryClient.getQueryData(runKeys.active(PROJECT_ID)))).not.toMatch(
      /SUCCEEDED|CANCELLED|FAILED|TIMED_OUT/,
    );
    expect(item.reconcile).toHaveBeenCalledWith('success', succeeded);
  });

  it('triggers coordinator on terminal frames without unlocking the editor', async () => {
    const coordinator = new RunAuthorityCoordinator({
      projectId: PROJECT_ID,
      fetchRun: async () => terminalRun(),
    });
    const running = lockingRun();
    await coordinator.reconcile('success', running);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    applyValidatedRunStateFrame(new QueryClient(), PROJECT_ID, terminalRun(), coordinator);
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
    expect(coordinator.getSnapshot().observedLockingRunId).toBe(running.id);
    expect(coordinator.getSnapshot().phase).not.toBe('RELOADING_WORKSPACE');
  });

  it('does not mutate active Run on socket error, close, or complete', async () => {
    const item = harness();
    const running = lockingRun();
    item.queryClient.setQueryData(runKeys.active(PROJECT_ID), { run: running });
    const socket = await openLive(item);
    socket.error();
    expect(item.queryClient.getQueryData(runKeys.active(PROJECT_ID))).toEqual({ run: running });
    socket.message(JSON.stringify({ type: 'log.complete', lastSeq: 1 }));
    expect(item.store.getSnapshot().connection).toBe('complete');
    expect(item.queryClient.getQueryData(runKeys.active(PROJECT_ID))).toEqual({ run: running });
    expect(isWorkspaceEditable({
      phase: 'EDITABLE',
      startPending: false,
      observedLockingRunId: running.id,
    })).toBe(false);
    socket.remoteClose(1000, 'complete');
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    expect(item.queryClient.getQueryData(runKeys.active(PROJECT_ID))).toEqual({ run: running });
  });
});

describe('RunLogTransport reconnect transition matrix', () => {
  it('close before open aborts ticketing, keeps lastSeq null, and does not open a socket', async () => {
    const item = harness();
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    item.createTicket.mockImplementation(async () => {
      await hold;
      return { ticket: 'ticket-held' as LogTicket, expiresAt: TICKET_EXPIRES };
    });
    item.transport.connect();
    await microtasks();
    expect(item.store.getSnapshot().connection).toBe('ticketing');
    expect(item.sockets).toHaveLength(0);
    item.transport.close();
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'idle', lastAppliedSeq: null });
    expect(item.clock.pendingCount()).toBe(0);
    release();
    await microtasks();
    expect(item.sockets).toHaveLength(0);
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('close after socket create but before open cancels timers and does not reconnect', async () => {
    const item = harness();
    item.transport.connect();
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
    expect(item.store.getSnapshot().connection).toBe('connecting');
    item.transport.close();
    expect(item.sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'idle', lastAppliedSeq: null });
    expect(item.clock.pendingCount()).toBe(0);
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('close after replay keeps lastSeq, cancels the watchdog, and does not fetch another ticket', async () => {
    const item = harness();
    const socket = await openLive(item, [chunk(1, 'keep')]);
    expect(item.store.getSnapshot().lastAppliedSeq).toBe(1);
    expect(item.clock.pendingCount()).toBe(1);
    item.transport.close();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'idle', lastAppliedSeq: 1 });
    expect(item.clock.pendingCount()).toBe(0);
    item.clock.advance(LOG_HEARTBEAT_WATCHDOG_MS);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('ticket expiry 4408 and retryable TICKET_EXPIRED reconnect with a fresh ticket and the same lastSeq', async () => {
    const expired = harness();
    const expiredSocket = await openLive(expired, [chunk(1, 'keep')]);
    expiredSocket.remoteClose(LOG_WS_CLOSE_CODE.TICKET_EXPIRED, 'ignore free-form expiry text');
    expect(expired.store.getSnapshot()).toMatchObject({
      connection: 'reconnecting',
      lastAppliedSeq: 1,
    });
    expect(expired.clock.pendingCount()).toBe(1);
    expired.clock.flush();
    await microtasks();
    expect(expired.createTicket).toHaveBeenCalledTimes(2);
    expired.sockets[1]?.open();
    expect(expired.sockets[1]?.sent).toEqual([JSON.stringify({ type: 'log.subscribe', lastSeq: 1 })]);

    const framed = harness();
    const liveSocket = await openLive(framed, [chunk(1, 'keep')]);
    liveSocket.message(JSON.stringify({ type: 'stream.error', code: 'TICKET_EXPIRED', retryable: true }));
    expect(framed.store.getSnapshot()).toMatchObject({
      connection: 'reconnecting',
      lastAppliedSeq: 1,
    });
    framed.clock.flush();
    await microtasks();
    expect(framed.createTicket).toHaveBeenCalledTimes(2);
    framed.sockets[1]?.open();
    expect(framed.sockets[1]?.sent).toEqual([JSON.stringify({ type: 'log.subscribe', lastSeq: 1 })]);
  });

  it('handshake 4403 stops retry with FORBIDDEN and cancels timers', async () => {
    const item = harness();
    item.transport.connect();
    await microtasks();
    item.sockets[0]?.remoteClose(LOG_WS_CLOSE_CODE.FORBIDDEN, 'do not parse this reason');
    expect(item.store.getSnapshot()).toMatchObject({ connection: 'failed', error: 'FORBIDDEN' });
    expect(item.clock.pendingCount()).toBe(0);
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('current-token 4401 calls onUnauthorized, fails the stream, and does not reconnect', async () => {
    const item = harness();
    const socket = await openLive(item, [chunk(1, 'keep')]);
    socket.remoteClose(LOG_WS_CLOSE_CODE.UNAUTHENTICATED, 'Bearer alice-token');
    expect(item.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(item.store.getSnapshot()).toMatchObject({
      connection: 'failed',
      error: 'UNAUTHENTICATED',
      lastAppliedSeq: 1,
    });
    expect(JSON.stringify(item.store.getSnapshot())).not.toContain('alice-token');
    expect(item.clock.pendingCount()).toBe(0);
    item.clock.advance(5_000);
    await microtasks();
    expect(item.createTicket).toHaveBeenCalledTimes(1);
  });

  it('selected history change disposes the previous socket, advances generation, and cancels timers', async () => {
    const first = harness();
    const firstSocket = await openLive(first, [chunk(1, 'alpha')]);
    firstSocket.remoteClose(1011, 'server exploded');
    expect(first.store.getSnapshot()).toMatchObject({
      connection: 'reconnecting',
      lastAppliedSeq: 1,
    });
    expect(first.clock.pendingCount()).toBe(1);

    first.transport.dispose();
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(first.clock.pendingCount()).toBe(0);
    first.clock.advance(5_000);
    await microtasks();
    expect(first.createTicket).toHaveBeenCalledTimes(1);
    firstSocket.message(JSON.stringify(appendFrame(chunk(2, 'stale-after-dispose'))));
    expect(first.store.getSnapshot().lastAppliedSeq).toBe(1);
    expect(first.store.getSnapshot().chunks.map((item) => item.text)).toEqual(['alpha']);

    const second = harness({ runId: parseRunId('run-2') });
    await openLive(second, [chunk(1, 'beta')]);
    expect(second.createTicket).toHaveBeenCalledTimes(1);
    expect(second.store.getSnapshot().lastAppliedSeq).toBe(1);
    expect(second.store.getSnapshot().chunks.map((item) => item.text)).toEqual(['beta']);
    expect(first.store.getSnapshot().chunks.map((item) => item.text)).toEqual(['alpha']);
    expect(second.clock.pendingCount()).toBe(1);
  });
});
