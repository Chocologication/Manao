import type { QueryClient } from '@tanstack/react-query';
import { createLogTicket } from '../../api/runApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { authSession, connectionRegistry, queryClient as appQueryClient } from '../../app/appRuntime';
import type { LogParseContext } from '../../contracts/log';
import {
  isRunLockingState,
  isRunTerminalState,
  type LogTicketResponse,
  type RunId,
  type RunListResponse,
  type RunSummary,
} from '../../contracts/run';
import type { ConnectionRegistry } from '../../runtime/ConnectionRegistry';
import { runKeys } from '../runs/runQueries';
import {
  encodeLogSubscribe,
  interpretCloseCode,
  interpretLogServerJson,
  LOG_HEARTBEAT_WATCHDOG_MS,
  LOG_WS_PATH,
  reconnectDelayMs,
} from './logProtocol';
import type { RunLogStore } from './RunLogStore';

export type RunLogWindowLocation = Pick<Location, 'protocol' | 'host'>;

export type RunStateCoordinator = {
  reconcile(status: 'success', run: RunSummary | null): unknown;
};

export type RunLogTransportOptions = {
  projectId: string;
  runId: RunId;
  store: RunLogStore;
  queryClient?: QueryClient;
  coordinator?: RunStateCoordinator;
  connectionRegistry?: ConnectionRegistry;
  createTicket?: (projectId: string, runId: RunId, signal?: AbortSignal) => Promise<LogTicketResponse>;
  getAccessToken?: () => string | null;
  onUnauthorized?: () => void;
  webSocketFactory?: (url: string) => WebSocket;
  location?: RunLogWindowLocation;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  jitter?: boolean;
  random?: () => number;
  heartbeatWatchdogMs?: number;
  addWindowListener?: (type: 'online' | 'offline', listener: () => void) => void;
  removeWindowListener?: (type: 'online' | 'offline', listener: () => void) => void;
  isOnline?: () => boolean;
};

type HistoryCache = {
  pages: RunListResponse[];
  pageParams: unknown[];
};

const WS_CONNECTING = 0;
const WS_OPEN = 1;

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('name' in error && error.name === 'AbortError') {
    return true;
  }
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.code === DOMException.ABORT_ERR;
}

function assertRunLogLocation(location: RunLogWindowLocation): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    throw new Error('Unsupported origin protocol');
  }
  if (typeof location.host !== 'string' || location.host.length === 0 || /[/?#]/.test(location.host)) {
    throw new Error('Unsupported origin host');
  }
}

export function buildRunLogWebSocketUrl(location: RunLogWindowLocation, ticket: string): string {
  assertRunLogLocation(location);
  if (typeof ticket !== 'string' || ticket.length === 0) {
    throw new Error('Invalid log ticket');
  }
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  params.set('ticket', ticket);
  const url = `${wsProtocol}//${location.host}${LOG_WS_PATH}?${params.toString()}`;
  const parsed = new URL(url);
  if (parsed.protocol !== wsProtocol || parsed.host !== location.host || parsed.pathname !== LOG_WS_PATH) {
    throw new Error('Unsupported log websocket path');
  }
  return url;
}

function isHistoryCache(value: unknown): value is HistoryCache {
  if (value === null || typeof value !== 'object' || !('pages' in value) || !('pageParams' in value)) {
    return false;
  }
  return Array.isArray((value as HistoryCache).pages) && Array.isArray((value as HistoryCache).pageParams);
}

function upsertRunHistory(current: HistoryCache, run: RunSummary): HistoryCache {
  let found = false;
  const pages = current.pages.map((page) => {
    const index = page.items.findIndex((item) => item.id === run.id);
    if (index < 0) {
      return page;
    }
    found = true;
    const items = page.items.slice();
    items[index] = run;
    return { ...page, items };
  });
  if (found) {
    return { ...current, pages };
  }
  const first = current.pages[0];
  if (first === undefined) {
    return {
      pages: [{ items: [run], nextCursor: null }],
      pageParams: current.pageParams.length > 0 ? current.pageParams : [null],
    };
  }
  return {
    ...current,
    pages: [{ ...first, items: [run, ...first.items] }, ...current.pages.slice(1)],
  };
}

export function applyValidatedRunStateFrame(
  queryClient: QueryClient,
  projectId: string,
  run: RunSummary,
  coordinator?: RunStateCoordinator,
): void {
  queryClient.setQueryData(runKeys.detail(projectId, run.id), run);
  if (isRunLockingState(run.state)) {
    queryClient.setQueryData(runKeys.active(projectId), { run });
    void coordinator?.reconcile('success', run);
    return;
  }
  if (!isRunTerminalState(run.state)) {
    return;
  }
  const historyKey = runKeys.history(projectId);
  const existing = queryClient.getQueryData(historyKey);
  if (isHistoryCache(existing)) {
    queryClient.setQueryData(historyKey, upsertRunHistory(existing, run));
  } else {
    void queryClient.invalidateQueries({ queryKey: historyKey });
  }
  void queryClient.invalidateQueries({ queryKey: runKeys.active(projectId) });
  void coordinator?.reconcile('success', run);
}

function ticketErrorCode(error: unknown): string {
  if (error instanceof ApiRequestError && error.body?.code) {
    return error.body.code;
  }
  return 'STREAM_UNAVAILABLE';
}

function isNonRetryableTicketError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }
  return error.status === 401 || error.status === 403 || error.status === 404;
}

export class RunLogTransport {
  readonly projectId: string;
  readonly runId: RunId;
  private readonly store: RunLogStore;
  private readonly queryClient: QueryClient;
  private readonly coordinator: RunStateCoordinator | undefined;
  private readonly createTicket: (
    projectId: string,
    runId: RunId,
    signal?: AbortSignal,
  ) => Promise<LogTicketResponse>;
  private readonly getAccessToken: () => string | null;
  private readonly onUnauthorized: () => void;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly location: RunLogWindowLocation;
  private readonly scheduleTimeout: (handler: () => void, ms: number) => unknown;
  private readonly cancelTimeout: (id: unknown) => void;
  private readonly jitter: boolean;
  private readonly random: (() => number) | undefined;
  private readonly heartbeatWatchdogMs: number;
  private readonly addWindowListener: (type: 'online' | 'offline', listener: () => void) => void;
  private readonly removeWindowListener: (type: 'online' | 'offline', listener: () => void) => void;
  private readonly isOnline: () => boolean;
  private readonly parseContext: LogParseContext;
  private unregister: (() => void) | null;
  private disposed = false;
  private running = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private streamComplete = false;
  private offline = false;
  private boundToken: string | null = null;
  private socket: WebSocket | null = null;
  private ticketAbort: AbortController | null = null;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;

  constructor(options: RunLogTransportOptions) {
    this.projectId = options.projectId;
    this.runId = options.runId;
    this.store = options.store;
    this.queryClient = options.queryClient ?? appQueryClient;
    this.coordinator = options.coordinator;
    this.createTicket = options.createTicket ?? createLogTicket;
    this.getAccessToken = options.getAccessToken ?? (() => authSession.getAccessToken());
    this.onUnauthorized = options.onUnauthorized ?? (() => {});
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.location = options.location ?? { protocol: window.location.protocol, host: window.location.host };
    this.scheduleTimeout = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancelTimeout = options.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.jitter = options.jitter !== false;
    this.random = options.random;
    this.heartbeatWatchdogMs = options.heartbeatWatchdogMs ?? LOG_HEARTBEAT_WATCHDOG_MS;
    this.addWindowListener =
      options.addWindowListener ??
      ((type, listener) => {
        window.addEventListener(type, listener);
      });
    this.removeWindowListener =
      options.removeWindowListener ??
      ((type, listener) => {
        window.removeEventListener(type, listener);
      });
    this.isOnline = options.isOnline ?? (() => navigator.onLine !== false);
    this.parseContext = { projectId: options.projectId, runId: options.runId };
    const registry = options.connectionRegistry ?? connectionRegistry;
    this.unregister = registry.register(() => {
      this.dispose();
    });
    this.addWindowListener('online', this.handleOnline);
    this.addWindowListener('offline', this.handleOffline);
  }

  connect(): void {
    if (this.disposed || this.running || this.streamComplete) {
      return;
    }
    this.running = true;
    this.reconnectAttempt = 0;
    this.generation += 1;
    void this.runAttempt(this.generation);
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    if (!this.running && this.socket === null && this.ticketAbort === null && this.reconnectTimer === null) {
      return;
    }
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.abortTicket();
    this.clearSocket();
    const connection = this.store.getSnapshot().connection;
    if (connection !== 'complete' && connection !== 'failed') {
      this.store.setConnection('idle');
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.abortTicket();
    this.clearSocket();
    this.unregister?.();
    this.unregister = null;
    this.removeWindowListener('online', this.handleOnline);
    this.removeWindowListener('offline', this.handleOffline);
  }

  private handleOnline = (): void => {
    this.offline = false;
    if (this.disposed || !this.running || this.streamComplete) {
      return;
    }
    if (this.socket !== null || this.ticketAbort !== null) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  };

  private handleOffline = (): void => {
    this.offline = true;
    if (this.disposed || !this.running || this.streamComplete) {
      return;
    }
    this.generation += 1;
    this.clearTimers();
    this.abortTicket();
    this.clearSocket();
    this.store.setConnection('reconnecting');
  };

  private async runAttempt(generation: number): Promise<void> {
    if (this.disposed || !this.running || generation !== this.generation) {
      return;
    }
    if (!this.isOnline() || this.offline) {
      this.offline = true;
      this.store.setConnection('reconnecting');
      return;
    }
    try {
      assertRunLogLocation(this.location);
    } catch {
      this.fail('PROTOCOL_ERROR');
      return;
    }
    this.store.setError(null);
    this.store.setConnection('ticketing');
    this.boundToken = this.getAccessToken();
    this.abortTicket();
    const abort = new AbortController();
    this.ticketAbort = abort;
    let ticket: string;
    try {
      const issued = await this.createTicket(this.projectId, this.runId, abort.signal);
      ticket = issued.ticket;
    } catch (error) {
      if (this.disposed || generation !== this.generation || abort.signal.aborted || isAbortError(error)) {
        return;
      }
      if (error instanceof ApiRequestError && error.status === 401) {
        this.fail('UNAUTHENTICATED');
        return;
      }
      if (isNonRetryableTicketError(error)) {
        this.fail(ticketErrorCode(error));
        return;
      }
      this.reconnect();
      return;
    }
    if (this.disposed || !this.running || generation !== this.generation) {
      return;
    }
    this.ticketAbort = null;
    let url: string;
    try {
      url = buildRunLogWebSocketUrl(this.location, ticket);
    } catch {
      this.fail('PROTOCOL_ERROR');
      return;
    }
    this.store.setConnection('connecting');
    const socket = this.webSocketFactory(url);
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen(generation, socket));
    socket.addEventListener('message', (event: Event) => this.handleMessage(generation, event as MessageEvent));
    socket.addEventListener('error', () => this.handleSocketError(generation));
    socket.addEventListener('close', (event: Event) => this.handleClose(generation, event as CloseEvent));
  }

  private handleOpen(generation: number, socket: WebSocket): void {
    if (this.disposed || generation !== this.generation || this.socket !== socket) {
      return;
    }
    this.reconnectAttempt = 0;
    this.store.setConnection('replaying');
    socket.send(encodeLogSubscribe(this.store.getSnapshot().lastAppliedSeq));
    this.armWatchdog(generation);
  }

  private handleMessage(generation: number, event: MessageEvent): void {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.armWatchdog(generation);
    if (typeof event.data !== 'string') {
      this.reconnect();
      return;
    }
    const decision = interpretLogServerJson(event.data, this.parseContext, {
      lastAppliedSeq: this.store.getSnapshot().lastAppliedSeq,
      generation: this.generation,
      frameGeneration: generation,
    });
    if (decision.kind === 'stale' || decision.kind === 'duplicate') {
      return;
    }
    if (decision.kind === 'heartbeat') {
      return;
    }
    if (decision.kind === 'invalid' || decision.kind === 'gap') {
      this.reconnect();
      return;
    }
    if (decision.kind === 'complete') {
      this.finishComplete();
      return;
    }
    if (decision.kind === 'error') {
      if (decision.code === 'UNAUTHENTICATED') {
        this.maybeUnauthorized();
      }
      if (decision.retryable) {
        this.reconnect();
        return;
      }
      this.fail(decision.code);
      return;
    }
    if (decision.kind === 'run-state') {
      if (decision.run.id !== this.runId) {
        return;
      }
      applyValidatedRunStateFrame(this.queryClient, this.projectId, decision.run, this.coordinator);
      return;
    }
    this.store.applyReplay(decision.chunks, decision.window);
    if (this.store.getSnapshot().connection === 'replaying' || this.store.getSnapshot().connection === 'connecting') {
      this.store.setConnection('live');
    }
  }

  private handleSocketError(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    // Close/reconnect is decided by the close event so active Run cache stays untouched.
  }

  private handleClose(generation: number, event: CloseEvent): void {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.clearWatchdog();
    this.socket = null;
    if (this.streamComplete || !this.running) {
      return;
    }
    const action = interpretCloseCode(event.code, event.reason, { streamComplete: this.streamComplete });
    if (action === 'unauthenticated') {
      this.maybeUnauthorized();
      this.fail('UNAUTHENTICATED');
      return;
    }
    if (action === 'forbidden' || action === 'stop') {
      this.fail(action === 'forbidden' ? 'FORBIDDEN' : 'STREAM_UNAVAILABLE');
      return;
    }
    this.reconnect();
  }

  private finishComplete(): void {
    this.streamComplete = true;
    this.running = false;
    this.clearWatchdog();
    this.store.markComplete();
    this.clearSocket();
  }

  private maybeUnauthorized(): void {
    const bound = this.boundToken;
    if (bound !== null && bound === this.getAccessToken()) {
      this.onUnauthorized();
    }
  }

  private reconnect(): void {
    if (this.disposed || !this.running || this.streamComplete) {
      return;
    }
    this.generation += 1;
    this.clearWatchdog();
    this.abortTicket();
    this.clearSocket();
    this.store.setConnection('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.running || this.offline) {
      return;
    }
    const delay = reconnectDelayMs(this.reconnectAttempt, { jitter: this.jitter, random: this.random });
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.running || this.offline) {
        return;
      }
      void this.runAttempt(this.generation);
    }, delay);
  }

  private fail(code: string): void {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.abortTicket();
    this.clearSocket();
    this.store.setError(code);
    this.store.setConnection('failed');
  }

  private armWatchdog(generation: number): void {
    this.clearWatchdog();
    this.watchdogTimer = this.scheduleTimeout(() => {
      this.watchdogTimer = null;
      if (this.disposed || generation !== this.generation || !this.running) {
        return;
      }
      this.reconnect();
    }, this.heartbeatWatchdogMs);
  }

  private abortTicket(): void {
    this.ticketAbort?.abort();
    this.ticketAbort = null;
  }

  private clearSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) {
      return;
    }
    if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
      socket.close();
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.cancelTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.cancelTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearWatchdog();
    this.clearReconnectTimer();
  }
}
