import { describe, expect, it, vi } from 'vitest';
import { parseRunId, type RunId, type RunState } from '../../contracts/run';
import {
  parseTerminalSessionId,
  parseTerminalTicket,
  type CreateTerminalSessionResponse,
} from '../../contracts/terminal';
import type { JobTerminalTransportOptions } from './JobTerminalTransport';
import type { XtermTerminalAdapterOptions } from './XtermTerminalAdapter';
import {
  JobTerminalController,
  type RegisterJobTerminalRuntimeResource,
} from './JobTerminalController';

function activeRun(id: string, state: RunState = 'RUNNING') {
  return { id: parseRunId(id), state };
}

describe('JobTerminalController authority transitions', () => {
  it('is available only for the current active RUNNING run', () => {
    const controller = new JobTerminalController({
      projectId: 'prj-1',
      getAccessToken: () => 'token',
      registerRuntimeResource: () => () => {},
    });

    expect(controller.getSnapshot()).toEqual({
      phase: 'unavailable',
      runId: null,
      failure: null,
    });

    controller.setRun(activeRun('run-starting', 'STARTING'));
    expect(controller.getSnapshot().phase).toBe('unavailable');

    controller.setRun(activeRun('run-1'));
    expect(controller.getSnapshot()).toEqual({
      phase: 'available',
      runId: parseRunId('run-1'),
      failure: null,
    });

    controller.setRun(activeRun('run-1', 'STOPPING'));
    expect(controller.getSnapshot()).toEqual({
      phase: 'unavailable',
      runId: null,
      failure: null,
    });

    controller.setRun(activeRun('run-2'));
    expect(controller.getSnapshot().runId).toBe('run-2');
    controller.setRun(null);
    expect(controller.getSnapshot().phase).toBe('unavailable');
  });

  it('notifies subscribers only for observable changes and stops after unsubscribe', () => {
    const controller = new JobTerminalController({
      projectId: 'prj-1',
      getAccessToken: () => 'token',
      registerRuntimeResource: () => () => {},
    });
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    controller.setRun(null);
    controller.setRun(activeRun('run-1'));
    controller.setRun(activeRun('run-1'));
    expect(notifications).toBe(1);

    unsubscribe();
    controller.setRun(null);
    expect(notifications).toBe(1);
  });
});

function createOpenHarness(
  options: {
    holdReservation?: boolean;
    reservations?: CreateTerminalSessionResponse[];
    closeNotifies?: boolean;
    fitDimensions?: { cols: number; rows: number } | null;
    reservationError?: Error;
    accessToken?: string | null;
    adapterFactoryThrows?: boolean;
    connectFailure?: boolean;
    connectThrows?: boolean;
    initializeResult?: boolean;
    initializeThrows?: boolean;
    registerRuntimeResource?: RegisterJobTerminalRuntimeResource;
    invalidateAudits?: (projectId: string, runId: RunId) => void;
    setInputEnabledThrows?: boolean;
    setReadyFalseThrows?: boolean;
    setReadyThrows?: boolean;
  } = {},
) {
  const trace: string[] = [];
  let adapterOptions: XtermTerminalAdapterOptions | null = null;
  let transportOptions: JobTerminalTransportOptions | null = null;
  const transportOptionsHistory: JobTerminalTransportOptions[] = [];
  let reservationIndex = 0;
  let writeReceipt: (() => void) | null = null;
  let releaseReservation: ((value: CreateTerminalSessionResponse) => void) | null = null;
  const reservation = {
    sessionId: parseTerminalSessionId('session-1'),
    ticket: parseTerminalTicket('ticket-1'),
    expiresAt: '2026-08-25T12:00:00.000Z',
  };
  const adapter = {
    open: vi.fn(() => {
      trace.push('adapter:open');
    }),
    fit: vi.fn(() => {
      trace.push('adapter:fit');
      return options.fitDimensions === undefined
        ? { cols: 91, rows: 27 }
        : options.fitDimensions;
    }),
    setReady: vi.fn((ready: boolean) => {
      trace.push(`adapter:ready:${ready}`);
      if (ready && options.setReadyThrows) throw new Error('set ready failed');
      if (!ready && options.setReadyFalseThrows) throw new Error('clear ready failed');
    }),
    setActive: vi.fn((active: boolean) => {
      trace.push(`adapter:active:${active}`);
    }),
    setInputEnabled: vi.fn((enabled: boolean) => {
      trace.push(`adapter:input:${enabled}`);
      if (options.setInputEnabledThrows) throw new Error('set input failed');
    }),
    write: vi.fn((_data: Uint8Array, receipt: () => void) => {
      trace.push('adapter:write');
      writeReceipt = receipt;
      return true;
    }),
    clear: vi.fn(),
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearSearch: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(() => {
      trace.push('adapter:dispose');
    }),
  };
  const transport = {
    connect: vi.fn(() => {
      trace.push('transport:connect');
      if (options.connectThrows) throw new Error('connect failed');
      if (options.connectFailure) {
        transportOptions?.onClosed?.({ kind: 'connection-error' });
      }
    }),
    initialize: vi.fn((cols: number, rows: number) => {
      trace.push(`transport:initialize:${cols}x${rows}`);
      if (options.initializeThrows) throw new Error('initialize failed');
      if (options.initializeResult === false) return false;
      transportOptions?.onInputEnabledChange?.(true);
      return true;
    }),
    resize: vi.fn(() => true),
    sendData: vi.fn(() => true),
    sendBinary: vi.fn(() => true),
    close: vi.fn(() => {
      trace.push('transport:close');
      if (options.closeNotifies !== false) {
        transportOptions?.onInputEnabledChange?.(false);
        transportOptions?.onClosed?.({ kind: 'client-close' });
      }
    }),
    dispose: vi.fn(() => {
      trace.push('transport:dispose');
    }),
  };
  const createSession = vi.fn(async (_projectId, _runId, request, _signal?: AbortSignal) => {
    trace.push(`session:create:${request.cols}x${request.rows}`);
    if (options.reservationError) throw options.reservationError;
    if (!options.holdReservation) {
      const next = options.reservations?.[reservationIndex] ?? reservation;
      reservationIndex += 1;
      return next;
    }
    return new Promise<CreateTerminalSessionResponse>((resolve) => {
      releaseReservation = resolve;
    });
  });
  const controller = new JobTerminalController({
    projectId: 'prj-1',
    getAccessToken: () => (options.accessToken === undefined ? 'token' : options.accessToken),
    createSession,
    createAdapter: (createdOptions) => {
      trace.push('adapter:create');
      if (options.adapterFactoryThrows) throw new Error('adapter factory failed');
      adapterOptions = createdOptions;
      return adapter;
    },
    createTransport: (createdOptions) => {
      trace.push('transport:create');
      transportOptions = createdOptions;
      transportOptionsHistory.push(createdOptions);
      return transport;
    },
    registerRuntimeResource: options.registerRuntimeResource ?? (() => () => {}),
    invalidateAudits:
      options.invalidateAudits === undefined
        ? undefined
        : (projectId, runId) => {
            trace.push('audit:invalidate');
            return options.invalidateAudits?.(projectId, runId);
          },
  });
  controller.setRun(activeRun('run-1'));

  return {
    controller,
    trace,
    adapter,
    transport,
    createSession,
    reservation,
    getAdapterOptions: () => adapterOptions,
    getTransportOptions: () => transportOptions,
    getTransportOptionsHistory: () => transportOptionsHistory,
    releaseReservation: () => releaseReservation?.(reservation),
    completeWrite: () => writeReceipt?.(),
  };
}

describe('JobTerminalController open orchestration', () => {
  it('opens and fits xterm before reserving, then initializes only after matching ready', async () => {
    const harness = createOpenHarness();
    const element = document.createElement('div');

    await expect(harness.controller.open(element)).resolves.toBe(true);

    expect(harness.trace).toEqual([
      'adapter:create',
      'adapter:open',
      'adapter:active:true',
      'adapter:fit',
      'session:create:91x27',
      'transport:create',
      'transport:connect',
    ]);
    expect(harness.controller.getSnapshot().phase).toBe('connecting');
    expect(harness.createSession).toHaveBeenCalledWith(
      'prj-1',
      parseRunId('run-1'),
      { cols: 91, rows: 27 },
      expect.any(AbortSignal),
    );

    harness.getTransportOptions()?.onReady?.();

    expect(harness.transport.initialize).toHaveBeenCalledOnce();
    expect(harness.transport.initialize).toHaveBeenCalledWith(91, 27);
    expect(harness.adapter.setReady).toHaveBeenCalledWith(true);
    expect(harness.controller.getSnapshot().phase).toBe('ready');
    expect(harness.trace.slice(-3)).toEqual([
      'transport:initialize:91x27',
      'adapter:input:true',
      'adapter:ready:true',
    ]);
  });

  it('acknowledges output only from the xterm write completion callback', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const ack = vi.fn(() => true);

    harness.getTransportOptions()?.onOutput?.({
      data: new Uint8Array([1, 2, 3]),
      byteLength: 3,
      ack,
    });

    expect(harness.adapter.write).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    harness.completeWrite();
    expect(ack).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledWith(3);
  });

  it('coalesces a double open while the first reservation is pending', async () => {
    const harness = createOpenHarness({ holdReservation: true });
    const first = harness.controller.open(document.createElement('div'));
    await Promise.resolve();

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);
    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().phase).toBe('creating');

    harness.releaseReservation();
    await expect(first).resolves.toBe(true);
    expect(harness.transport.connect).toHaveBeenCalledOnce();
  });

  it('disposes the adapter without reserving when fitted dimensions are unavailable', async () => {
    const harness = createOpenHarness({ fitDimensions: null });

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'open-failed',
    });
  });

  it('leaves creating and fails closed when adapter construction throws before ownership', async () => {
    const harness = createOpenHarness({ adapterFactoryThrows: true });

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'open-failed',
    });
  });

  it('disposes every created resource and POSTs again after a failed connection', async () => {
    const harness = createOpenHarness({ connectThrows: true });

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);
    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.transport.dispose).toHaveBeenCalledTimes(2);
    expect(harness.adapter.dispose).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'open-failed',
    });
  });

  it('disposes xterm when transport reports a synchronous connect failure', async () => {
    const harness = createOpenHarness({ connectFailure: true });

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(false);

    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'connection-error',
    });
  });

  it('fails closed and disposes the generation when ready initialization fails', async () => {
    const harness = createOpenHarness({ initializeResult: false });
    await harness.controller.open(document.createElement('div'));

    harness.getTransportOptions()?.onReady?.();

    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'protocol-error',
    });
  });

  it('contains a throwing ready initialization and invalidates its callbacks and ticket', async () => {
    const behavior = { initializeThrows: true };
    const harness = createOpenHarness(behavior);
    await harness.controller.open(document.createElement('div'));
    const staleTransport = harness.getTransportOptions();

    expect(() => staleTransport?.onReady?.()).not.toThrow();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'protocol-error',
    });
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();

    staleTransport?.onReady?.();
    expect(harness.transport.initialize).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();

    behavior.initializeThrows = false;
    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(true);
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    staleTransport?.onReady?.();
    expect(harness.transport.initialize).toHaveBeenCalledOnce();
  });

  it('contains a throwing adapter ready transition and invalidates its callbacks and ticket', async () => {
    const behavior = { setReadyThrows: true };
    const harness = createOpenHarness(behavior);
    await harness.controller.open(document.createElement('div'));
    const staleTransport = harness.getTransportOptions();

    expect(() => staleTransport?.onReady?.()).not.toThrow();
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      failure: 'protocol-error',
    });
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();

    staleTransport?.onReady?.();
    expect(harness.adapter.setReady).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();

    behavior.setReadyThrows = false;
    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(true);
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    staleTransport?.onReady?.();
    expect(harness.adapter.setReady).toHaveBeenCalledOnce();
  });

  it('disposes xterm when reservation or captured authorization fails', async () => {
    const reservationFailure = createOpenHarness({ reservationError: new Error('offline') });
    await expect(
      reservationFailure.controller.open(document.createElement('div')),
    ).resolves.toBe(false);
    expect(reservationFailure.adapter.dispose).toHaveBeenCalledOnce();
    expect(reservationFailure.transport.connect).not.toHaveBeenCalled();

    const missingToken = createOpenHarness({ accessToken: null });
    await expect(missingToken.controller.open(document.createElement('div'))).resolves.toBe(false);
    expect(missingToken.adapter.dispose).toHaveBeenCalledOnce();
    expect(missingToken.transport.connect).not.toHaveBeenCalled();
  });
});

describe('JobTerminalController live lifecycle', () => {
  it('maps pause/resume and panel activity without closing the session', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();

    harness.getTransportOptions()?.onInputEnabledChange?.(false);
    expect(harness.controller.getSnapshot().phase).toBe('paused');
    harness.getTransportOptions()?.onInputEnabledChange?.(true);
    expect(harness.controller.getSnapshot().phase).toBe('ready');

    harness.controller.setActive(false);
    harness.controller.setActive(true);
    expect(harness.adapter.setActive).toHaveBeenLastCalledWith(true);
    expect(harness.transport.close).not.toHaveBeenCalled();
  });

  it('disables input and enters closing before one explicit transport close', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const phases: string[] = [];
    harness.controller.subscribe(() => {
      phases.push(harness.controller.getSnapshot().phase);
    });
    const start = harness.trace.length;

    expect(harness.controller.close()).toBe(true);
    expect(harness.controller.close()).toBe(false);

    expect(phases[0]).toBe('closing');
    expect(harness.trace.slice(start, start + 2)).toEqual([
      'adapter:input:false',
      'transport:close',
    ]);
    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().phase).toBe('closed');
  });

  it('disposes the closed generation before one audit invalidation across racing endings', async () => {
    const invalidateAudits = vi.fn();
    const harness = createOpenHarness({ invalidateAudits });
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const staleTransport = harness.getTransportOptions();
    const start = harness.trace.length;

    expect(harness.controller.close()).toBe(true);

    expect(harness.trace.slice(start)).toEqual([
      'adapter:input:false',
      'transport:close',
      'adapter:input:false',
      'adapter:ready:false',
      'transport:dispose',
      'adapter:dispose',
      'audit:invalidate',
    ]);

    staleTransport?.onClosed?.({ kind: 'server-error', code: 'PTY_EXEC_FAILED' });
    harness.controller.setRun(activeRun('run-1', 'STOPPING'));
    harness.controller.handlePageHide();
    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(invalidateAudits).toHaveBeenCalledOnce();
  });

  it('closes synchronously before disposing resources when the active run leaves RUNNING', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const phases: string[] = [];
    harness.controller.subscribe(() => {
      phases.push(harness.controller.getSnapshot().phase);
    });
    const start = harness.trace.length;

    harness.controller.setRun(activeRun('run-1', 'STOPPING'));

    expect(phases[0]).toBe('closing');
    expect(harness.trace.slice(start)).toEqual([
      'adapter:input:false',
      'transport:close',
      'adapter:input:false',
      'adapter:ready:false',
      'transport:dispose',
      'adapter:dispose',
    ]);
    expect(harness.controller.getSnapshot().phase).toBe('unavailable');
  });

  it('continues Run-left close and disposal when disabling adapter input throws', async () => {
    const behavior = { setInputEnabledThrows: false };
    const harness = createOpenHarness(behavior);
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const phases: string[] = [];
    harness.controller.subscribe(() => {
      phases.push(harness.controller.getSnapshot().phase);
    });
    behavior.setInputEnabledThrows = true;

    expect(() => harness.controller.setRun(activeRun('run-1', 'STOPPING'))).not.toThrow();

    expect(phases[0]).toBe('closing');
    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toEqual({
      phase: 'unavailable',
      runId: null,
      failure: null,
    });
  });

  it('maps exit without changing Run authority or accepting a second terminal callback', async () => {
    const invalidateAudits = vi.fn(() => {
      throw new Error('invalidate observer failed');
    });
    const harness = createOpenHarness({ invalidateAudits });
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();

    harness.getTransportOptions()?.onClosed?.({
      kind: 'server-exit',
      exitCode: 0,
      reason: 'SHELL_EXITED',
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'exited',
      runId: parseRunId('run-1'),
      failure: null,
    });

    harness.getTransportOptions()?.onClosed?.({ kind: 'server-error', code: 'PTY_EXEC_FAILED' });
    expect(harness.controller.getSnapshot().phase).toBe('exited');
    expect(invalidateAudits).toHaveBeenCalledOnce();
    expect(invalidateAudits).toHaveBeenCalledWith('prj-1', parseRunId('run-1'));
  });

  it('commits exit and invalidates once when clearing adapter ready throws', async () => {
    const invalidateAudits = vi.fn();
    const behavior = { setReadyFalseThrows: false, invalidateAudits };
    const harness = createOpenHarness(behavior);
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    const staleAdapter = harness.getAdapterOptions();
    behavior.setReadyFalseThrows = true;

    const exit = () =>
      harness.getTransportOptions()?.onClosed?.({
        kind: 'server-exit',
        exitCode: 0,
        reason: 'SHELL_EXITED',
      });
    expect(exit).not.toThrow();

    expect(harness.controller.getSnapshot()).toMatchObject({ phase: 'exited', failure: null });
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(invalidateAudits).toHaveBeenCalledOnce();
    expect(exit).not.toThrow();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(invalidateAudits).toHaveBeenCalledOnce();
    staleAdapter?.onData?.('stale');
    expect(harness.transport.sendData).not.toHaveBeenCalled();
  });

  it('maps a structured transport failure to terminal error', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();

    harness.getTransportOptions()?.onClosed?.({ kind: 'server-error', code: 'PTY_EXEC_FAILED' });

    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      runId: parseRunId('run-1'),
      failure: 'server-error',
    });
  });

  it('does not recover until explicit Open creates new IDs and ignores the old generation', async () => {
    const firstReservation: CreateTerminalSessionResponse = {
      sessionId: parseTerminalSessionId('session-old'),
      ticket: parseTerminalTicket('ticket-old'),
      expiresAt: '2026-08-25T12:00:00.000Z',
    };
    const secondReservation: CreateTerminalSessionResponse = {
      sessionId: parseTerminalSessionId('session-new'),
      ticket: parseTerminalTicket('ticket-new'),
      expiresAt: '2026-08-25T12:01:00.000Z',
    };
    const harness = createOpenHarness({ reservations: [firstReservation, secondReservation] });
    await harness.controller.open(document.createElement('div'));
    const oldTransport = harness.getTransportOptionsHistory()[0]!;
    const oldAdapter = harness.getAdapterOptions();
    oldTransport.onReady?.();

    oldTransport.onClosed?.({ kind: 'socket-close', code: 1006 });
    const staleAck = vi.fn(() => true);
    oldTransport.onReady?.();
    oldTransport.onInputEnabledChange?.(true);
    oldTransport.onOutput?.({ data: new Uint8Array([1]), byteLength: 1, ack: staleAck });
    oldAdapter?.onData?.('stale');

    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(harness.transport.connect).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(harness.transport.initialize).toHaveBeenCalledOnce();
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(harness.transport.sendData).not.toHaveBeenCalled();
    expect(staleAck).not.toHaveBeenCalled();

    await expect(harness.controller.open(document.createElement('div'))).resolves.toBe(true);
    const nextTransport = harness.getTransportOptionsHistory()[1]!;
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.transport.connect).toHaveBeenCalledTimes(2);
    expect(oldTransport.sessionId).toBe('session-old');
    expect(oldTransport.ticket).toBe('ticket-old');
    expect(nextTransport.sessionId).toBe('session-new');
    expect(nextTransport.ticket).toBe('ticket-new');

    oldTransport.onReady?.();
    oldTransport.onOutput?.({ data: new Uint8Array([2]), byteLength: 1, ack: staleAck });
    nextTransport.onReady?.();
    expect(harness.transport.initialize).toHaveBeenCalledTimes(2);
    expect(harness.adapter.write).not.toHaveBeenCalled();
    expect(staleAck).not.toHaveBeenCalled();
  });

  it('aborts a pending reservation and ignores stale generation callbacks on Run change', async () => {
    const harness = createOpenHarness({ holdReservation: true, closeNotifies: false });
    const opening = harness.controller.open(document.createElement('div'));
    await Promise.resolve();
    const staleAdapter = harness.getAdapterOptions();
    const reservationSignal = harness.createSession.mock.calls[0]?.[3];

    harness.controller.setRun(activeRun('run-2'));
    expect(reservationSignal?.aborted).toBe(true);
    harness.releaseReservation();
    await expect(opening).resolves.toBe(false);

    const ack = vi.fn(() => true);
    staleAdapter?.onData?.('stale');
    harness.getTransportOptions()?.onReady?.();
    harness.getTransportOptions()?.onOutput?.({
      data: new Uint8Array([1]),
      byteLength: 1,
      ack,
    });
    expect(harness.controller.getSnapshot()).toMatchObject({ phase: 'available', runId: 'run-2' });
    expect(harness.transport.sendData).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('pagehide closes and disposes the generation once', async () => {
    const harness = createOpenHarness();
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();

    harness.controller.handlePageHide();
    harness.controller.handlePageHide();

    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
  });

  it('pagehide still closes and disposes when disabling adapter input throws', async () => {
    const behavior = { setInputEnabledThrows: false };
    const harness = createOpenHarness(behavior);
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();
    behavior.setInputEnabledThrows = true;

    expect(() => harness.controller.handlePageHide()).not.toThrow();

    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.transport.dispose).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(() => harness.controller.handlePageHide()).not.toThrow();
  });

  it('registers connection close and workspace disposal as one runtime resource', async () => {
    let resource: Parameters<RegisterJobTerminalRuntimeResource>[0] | null = null;
    const unregister = vi.fn();
    const registerRuntimeResource: RegisterJobTerminalRuntimeResource = (created) => {
      resource = created;
      return unregister;
    };
    const harness = createOpenHarness({ registerRuntimeResource });
    await harness.controller.open(document.createElement('div'));
    harness.getTransportOptions()?.onReady?.();

    expect(resource).not.toBeNull();
    resource!.closeConnection();
    expect(harness.transport.close).toHaveBeenCalledOnce();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();

    resource!.disposeWorkspace();
    resource!.disposeWorkspace();
    expect(harness.adapter.dispose).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });
});
