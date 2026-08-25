import type { RunId, RunState } from '../../contracts/run';
import { ApiRequestError } from '../../api/ApiRequestError';
import { createTerminalSession } from '../../api/terminalApi';
import {
  JobTerminalTransport,
  type JobTerminalClosedReason,
  type JobTerminalTransportOptions,
} from './JobTerminalTransport';
import {
  XtermTerminalAdapter,
  type XtermDimensions,
  type XtermSearchOptions,
  type XtermTerminalAdapterOptions,
} from './XtermTerminalAdapter';

export type JobTerminalPhase =
  | 'unavailable'
  | 'available'
  | 'creating'
  | 'connecting'
  | 'ready'
  | 'paused'
  | 'closing'
  | 'closed'
  | 'exited'
  | 'error';

export type JobTerminalFailure =
  | 'open-failed'
  | 'terminal-not-available'
  | 'terminal-session-already-active'
  | 'connection-error'
  | 'input-overflow'
  | 'protocol-error'
  | 'server-error';

export type JobTerminalSnapshot = {
  phase: JobTerminalPhase;
  runId: RunId | null;
  failure: JobTerminalFailure | null;
};

export type JobTerminalRunAuthority = {
  id: RunId;
  state: RunState;
};

export type JobTerminalRuntimeResource = {
  closeConnection(): void;
  disposeWorkspace(): void;
};

export type RegisterJobTerminalRuntimeResource = (
  resource: JobTerminalRuntimeResource,
) => () => void;

export type JobTerminalAdapterPort = {
  open(element: HTMLElement): void;
  fit(): XtermDimensions | null;
  setReady(ready: boolean): void;
  setActive(active: boolean): void;
  setInputEnabled(enabled: boolean): void;
  write(data: Uint8Array, receipt: () => void): boolean;
  clear(): void;
  findNext(term: string, options?: XtermSearchOptions): boolean;
  findPrevious(term: string, options?: XtermSearchOptions): boolean;
  clearSearch(): void;
  focus(): void;
  dispose(): void;
};

export type JobTerminalTransportPort = {
  connect(): void;
  initialize(cols: number, rows: number): boolean;
  resize(cols: number, rows: number): boolean;
  sendData(data: string): boolean;
  sendBinary(data: string): boolean;
  close(): void;
  dispose(): void;
};

export type CreateJobTerminalSession = typeof createTerminalSession;
export type CreateJobTerminalAdapter = (
  options: XtermTerminalAdapterOptions,
) => JobTerminalAdapterPort;
export type CreateJobTerminalTransport = (
  options: JobTerminalTransportOptions,
) => JobTerminalTransportPort;

export type JobTerminalControllerOptions = {
  projectId: string;
  getAccessToken: () => string | null;
  createSession?: CreateJobTerminalSession;
  createAdapter?: CreateJobTerminalAdapter;
  createTransport?: CreateJobTerminalTransport;
  onUnauthorized?: () => void;
  invalidateAudits?: (projectId: string, runId: RunId) => void | Promise<void>;
  invalidateRunAuthority?: (projectId: string) => void | Promise<void>;
  registerRuntimeResource: RegisterJobTerminalRuntimeResource;
};

const INITIAL_SNAPSHOT: JobTerminalSnapshot = {
  phase: 'unavailable',
  runId: null,
  failure: null,
};

function classifyCreateSessionFailure(error: unknown): JobTerminalFailure {
  if (!(error instanceof ApiRequestError)) return 'open-failed';
  if (error.body?.code === 'TERMINAL_NOT_AVAILABLE') return 'terminal-not-available';
  if (error.body?.code === 'TERMINAL_SESSION_ALREADY_ACTIVE') {
    return 'terminal-session-already-active';
  }
  return 'open-failed';
}

export class JobTerminalController {
  readonly projectId: string;
  private readonly getAccessToken: () => string | null;
  private readonly createSession: CreateJobTerminalSession;
  private readonly createAdapter: CreateJobTerminalAdapter;
  private readonly createTransport: CreateJobTerminalTransport;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly invalidateAudits:
    | ((projectId: string, runId: RunId) => void | Promise<void>)
    | undefined;
  private readonly invalidateRunAuthority:
    | ((projectId: string) => void | Promise<void>)
    | undefined;
  private snapshot: JobTerminalSnapshot = { ...INITIAL_SNAPSHOT };
  private readonly listeners = new Set<() => void>();
  private run: JobTerminalRunAuthority | null = null;
  private adapter: JobTerminalAdapterPort | null = null;
  private transport: JobTerminalTransportPort | null = null;
  private reservationAbort: AbortController | null = null;
  private dimensions: XtermDimensions | null = null;
  private generation = 0;
  private active = true;
  private disposed = false;
  private unregisterRuntimeResource: () => void = () => {};

  constructor(options: JobTerminalControllerOptions) {
    this.projectId = options.projectId;
    this.getAccessToken = options.getAccessToken;
    this.createSession = options.createSession ?? createTerminalSession;
    this.createAdapter =
      options.createAdapter ?? ((adapterOptions) => new XtermTerminalAdapter(adapterOptions));
    this.createTransport =
      options.createTransport ??
      ((transportOptions) => new JobTerminalTransport(transportOptions));
    this.onUnauthorized = options.onUnauthorized;
    this.invalidateAudits = options.invalidateAudits;
    this.invalidateRunAuthority = options.invalidateRunAuthority;
    this.unregisterRuntimeResource = options.registerRuntimeResource({
      closeConnection: () => {
        this.forceCloseCurrent();
      },
      disposeWorkspace: () => {
        this.dispose();
      },
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): JobTerminalSnapshot => this.snapshot;

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.adapter?.setActive(active);
  }

  clear(): void {
    this.adapter?.clear();
  }

  findNext(term: string, options?: XtermSearchOptions): boolean {
    return this.adapter?.findNext(term, options) ?? false;
  }

  findPrevious(term: string, options?: XtermSearchOptions): boolean {
    return this.adapter?.findPrevious(term, options) ?? false;
  }

  clearSearch(): void {
    this.adapter?.clearSearch();
  }

  focus(): void {
    this.adapter?.focus();
  }

  close(): boolean {
    if (
      this.disposed ||
      !['creating', 'connecting', 'ready', 'paused'].includes(this.snapshot.phase)
    ) {
      return false;
    }
    const hadTransport = this.transport !== null;
    this.beginClose();
    if (!hadTransport) {
      this.generation += 1;
      this.teardownResources();
      this.patch({ phase: 'closed', failure: null });
    }
    return true;
  }

  handlePageHide(persisted = false): void {
    if (persisted) {
      this.forceCloseCurrent();
      return;
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    const unregisterRuntimeResource = this.unregisterRuntimeResource;
    this.unregisterRuntimeResource = () => {};
    try {
      unregisterRuntimeResource();
    } catch {
      // Controller-owned resources still close when registry unregistration throws.
    }
    if (['creating', 'connecting', 'ready', 'paused'].includes(this.snapshot.phase)) {
      this.beginClose();
    }
    this.disposed = true;
    this.generation += 1;
    this.teardownResources();
    this.listeners.clear();
  }

  async open(element: HTMLElement): Promise<boolean> {
    const run = this.run;
    if (
      this.disposed ||
      run === null ||
      run.state !== 'RUNNING' ||
      !['available', 'closed', 'exited', 'error'].includes(this.snapshot.phase)
    ) {
      return false;
    }

    const generation = this.generation + 1;
    this.generation = generation;
    this.teardownResources();
    this.patch({ phase: 'creating', runId: run.id, failure: null });

    let adapter: JobTerminalAdapterPort | null = null;
    let openingStage: 'local' | 'create-session' | 'transport' = 'local';
    try {
      adapter = this.createAdapter({
        onData: (data) => {
          if (this.isCurrent(generation, run.id, adapter)) this.transport?.sendData(data);
        },
        onBinary: (data) => {
          if (this.isCurrent(generation, run.id, adapter)) this.transport?.sendBinary(data);
        },
        onResize: (cols, rows) => {
          if (this.isCurrent(generation, run.id, adapter)) this.transport?.resize(cols, rows);
        },
      });
      this.adapter = adapter;
      adapter.open(element);
      adapter.setActive(this.active);
      const dimensions = adapter.fit();
      if (dimensions === null || !this.isCurrent(generation, run.id, adapter)) {
        throw new Error('Terminal dimensions are unavailable');
      }
      this.dimensions = dimensions;

      const accessToken = this.getAccessToken();
      if (accessToken === null || accessToken === '') {
        throw new Error('Terminal access token is unavailable');
      }
      const abort = new AbortController();
      this.reservationAbort = abort;
      openingStage = 'create-session';
      const reservation = await this.createSession(
        this.projectId,
        run.id,
        { cols: dimensions.cols, rows: dimensions.rows },
        abort.signal,
      );
      openingStage = 'transport';
      if (!this.isCurrent(generation, run.id, adapter)) return false;
      this.reservationAbort = null;
      if (this.getAccessToken() !== accessToken) {
        throw new Error('Terminal access token changed');
      }

      let transport: JobTerminalTransportPort | null = null;
      transport = this.createTransport({
        sessionId: reservation.sessionId,
        ticket: reservation.ticket,
        accessToken,
        getAccessToken: this.getAccessToken,
        onUnauthorized: this.onUnauthorized,
        onInputEnabledChange: (enabled) => {
          if (!this.isCurrentTransport(generation, transport)) return;
          if (this.snapshot.phase === 'closing' && !enabled) return;
          this.setAdapterInputEnabledSafely(adapter, enabled);
          if (this.snapshot.phase === 'ready' && !enabled) {
            this.patch({ phase: 'paused' });
          } else if (this.snapshot.phase === 'paused' && enabled) {
            this.patch({ phase: 'ready' });
          }
        },
        onReady: () => {
          if (
            !this.isCurrentTransport(generation, transport) ||
            adapter === null ||
            this.dimensions !== dimensions
          ) {
            return;
          }
          try {
            if (!transport.initialize(dimensions.cols, dimensions.rows)) {
              this.failCurrentGeneration(generation, adapter, 'protocol-error');
              return;
            }
            adapter.setReady(true);
            this.patch({ phase: 'ready', failure: null });
          } catch {
            this.failCurrentGeneration(generation, adapter, 'protocol-error');
          }
        },
        onOutput: (frame) => {
          if (!this.isCurrentTransport(generation, transport) || adapter === null) return;
          if (!adapter.write(frame.data, () => frame.ack(frame.byteLength))) {
            throw new Error('Terminal output write failed');
          }
        },
        onClosed: (reason) => {
          this.handleTransportClosed(generation, run.id, transport, adapter, reason);
        },
      });
      this.transport = transport;
      this.patch({ phase: 'connecting' });
      transport.connect();
      return this.isCurrentTransport(generation, transport) && this.snapshot.phase === 'connecting';
    } catch (error) {
      if (!this.isGenerationCurrent(generation, run.id)) return false;
      const failure = openingStage === 'create-session'
        ? classifyCreateSessionFailure(error)
        : 'open-failed';
      this.generation += 1;
      this.teardownResources();
      this.patch({ phase: 'error', runId: run.id, failure });
      if (failure === 'terminal-not-available') this.notifyRunAuthorityInvalidation();
      return false;
    }
  }

  setRun(run: JobTerminalRunAuthority | null): void {
    const nextRun = run?.state === 'RUNNING' ? run : null;
    if (this.run?.id === nextRun?.id && this.run?.state === nextRun?.state) return;
    if (['creating', 'connecting', 'ready', 'paused'].includes(this.snapshot.phase)) {
      this.beginClose();
    }
    this.generation += 1;
    this.teardownResources();
    this.run = nextRun;
    this.patch(
      nextRun === null
        ? INITIAL_SNAPSHOT
        : { phase: 'available', runId: nextRun.id, failure: null },
    );
  }

  private handleTransportClosed(
    generation: number,
    runId: RunId | null,
    transport: JobTerminalTransportPort | null,
    adapter: JobTerminalAdapterPort | null,
    reason: JobTerminalClosedReason,
  ): void {
    if (
      !this.isCurrentTransport(generation, transport) ||
      adapter === null ||
      this.adapter !== adapter
    ) {
      return;
    }
    this.generation += 1;
    this.transport = null;
    this.adapter = null;
    this.dimensions = null;
    this.setAdapterReadySafely(adapter, false);
    try {
      transport.dispose();
    } catch {
      // The state transition remains terminal when transport disposal throws.
    }
    try {
      adapter.dispose();
    } catch {
      // Audit invalidation still runs when xterm or an addon rejects disposal.
    }
    if (reason.kind === 'server-exit') {
      this.patch({ phase: 'exited', failure: null });
      this.notifyAuditInvalidation(runId);
      return;
    }
    if (reason.kind === 'client-close') {
      this.patch({ phase: 'closed', failure: null });
      this.notifyAuditInvalidation(runId);
      return;
    }
    const failure: JobTerminalFailure = reason.kind === 'input-overflow'
      ? 'input-overflow'
      : reason.kind === 'protocol-error'
        ? 'protocol-error'
        : reason.kind === 'server-error'
          ? 'server-error'
          : 'connection-error';
    this.patch({ phase: 'error', failure });
    this.notifyAuditInvalidation(runId);
  }

  private notifyAuditInvalidation(runId: RunId | null): void {
    if (runId === null || this.invalidateAudits === undefined) return;
    try {
      void Promise.resolve(this.invalidateAudits(this.projectId, runId)).catch(() => {});
    } catch {
      // Query invalidation observers cannot change the terminal outcome.
    }
  }

  private notifyRunAuthorityInvalidation(): void {
    if (this.invalidateRunAuthority === undefined) return;
    try {
      void Promise.resolve(this.invalidateRunAuthority(this.projectId)).catch(() => {});
    } catch {
      // Authority refetch observers cannot replace the classified create failure.
    }
  }

  private forceCloseCurrent(): boolean {
    if (
      this.disposed ||
      !['creating', 'connecting', 'ready', 'paused', 'closing'].includes(this.snapshot.phase)
    ) {
      return false;
    }
    const runId = this.snapshot.runId;
    if (this.snapshot.phase !== 'closing') this.beginClose();
    if (this.snapshot.phase !== 'closing') return true;
    this.generation += 1;
    this.teardownResources();
    this.patch({ phase: 'closed', failure: null });
    this.notifyAuditInvalidation(runId);
    return true;
  }

  private beginClose(): void {
    if (this.snapshot.phase !== 'paused') {
      this.setAdapterInputEnabledSafely(this.adapter, false);
    }
    this.patch({ phase: 'closing' });
    try {
      this.transport?.close();
    } catch {
      const transport = this.transport;
      const adapter = this.adapter;
      this.handleTransportClosed(this.generation, this.snapshot.runId, transport, adapter, {
        kind: 'connection-error',
      });
    }
  }

  private setAdapterInputEnabledSafely(
    adapter: JobTerminalAdapterPort | null,
    enabled: boolean,
  ): void {
    try {
      adapter?.setInputEnabled(enabled);
    } catch {
      // Adapter failures cannot interrupt terminal ownership transitions.
    }
  }

  private setAdapterReadySafely(adapter: JobTerminalAdapterPort, ready: boolean): void {
    try {
      adapter.setReady(ready);
    } catch {
      // Terminal outcomes and audit invalidation remain authoritative.
    }
  }

  private teardownResources(): void {
    this.reservationAbort?.abort();
    this.reservationAbort = null;
    const transport = this.transport;
    this.transport = null;
    try {
      transport?.dispose();
    } catch {
      // Adapter cleanup still owns the visible terminal resources.
    }
    const adapter = this.adapter;
    this.adapter = null;
    this.dimensions = null;
    try {
      adapter?.dispose();
    } catch {
      // Internal ownership is cleared even if an injected adapter throws.
    }
  }

  private isCurrent(
    generation: number,
    runId: RunId,
    adapter: JobTerminalAdapterPort | null,
  ): boolean {
    return (
      generation === this.generation &&
      this.run?.id === runId &&
      adapter !== null &&
      adapter === this.adapter
    );
  }

  private isGenerationCurrent(generation: number, runId: RunId): boolean {
    return generation === this.generation && this.run?.id === runId;
  }

  private isCurrentTransport(
    generation: number,
    transport: JobTerminalTransportPort | null,
  ): transport is JobTerminalTransportPort {
    return generation === this.generation && transport !== null && transport === this.transport;
  }

  private failCurrentGeneration(
    generation: number,
    adapter: JobTerminalAdapterPort,
    failure: JobTerminalFailure,
  ): void {
    if (generation !== this.generation || adapter !== this.adapter) return;
    this.generation += 1;
    this.teardownResources();
    this.patch({ phase: 'error', failure });
  }

  private patch(partial: Partial<JobTerminalSnapshot>): void {
    const next = { ...this.snapshot, ...partial };
    if (
      this.snapshot.phase === next.phase &&
      this.snapshot.runId === next.runId &&
      this.snapshot.failure === next.failure
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One view observer cannot block the remaining state subscribers.
      }
    }
  }
}
