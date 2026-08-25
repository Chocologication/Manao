import { describe, expect, it, vi } from 'vitest';
import { parseTerminalSessionId, parseTerminalTicket } from '../../contracts/terminal';
import {
  buildJobTerminalWebSocketUrl,
  JobTerminalTransport,
  type JobTerminalLocation,
  type JobTerminalOutputFrame,
  type JobTerminalTransportOptions,
  type TerminalWebSocketPort,
} from './JobTerminalTransport';

type SocketEvent = { data?: unknown; code?: number; reason?: string };

class FakeTerminalSocket implements TerminalWebSocketPort {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code?: number }> = [];
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  private readonly trace: string[] | null;

  constructor(trace: string[] | null = null) {
    this.trace = trace;
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.trace?.push(`socket:remove:${type}`);
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as { type?: string };
      this.trace?.push(`socket:send:${frame.type ?? 'unknown'}`);
    }
    this.sent.push(typeof data === 'string' ? data : data.slice(0));
  }

  close(code?: number): void {
    this.trace?.push('socket:close');
    this.closes.push({ code });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  error(): void {
    this.emit('error', {});
  }

  remoteClose(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const SESSION_ID = parseTerminalSessionId('session-1');
const TICKET = parseTerminalTicket('short ticket?&');
const LOCATION: JobTerminalLocation = { protocol: 'https:', host: 'workbench.example:8443' };

function controlFrames(socket: FakeTerminalSocket): unknown[] {
  return socket.sent
    .filter((frame): frame is string => typeof frame === 'string')
    .map((frame) => JSON.parse(frame) as unknown);
}

function binaryFrames(socket: FakeTerminalSocket): number[][] {
  return socket.sent
    .filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer)
    .map((frame) => [...new Uint8Array(frame)]);
}

function createManualScheduler() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  return {
    scheduler: {
      setTimeout(handler: () => void) {
        const id = nextId;
        nextId += 1;
        tasks.set(id, handler);
        return id;
      },
      clearTimeout(id: unknown) {
        tasks.delete(Number(id));
      },
    },
    pendingCount: () => tasks.size,
  };
}

function createHarness(overrides: Partial<JobTerminalTransportOptions> = {}) {
  const sockets: FakeTerminalSocket[] = [];
  const states: string[] = [];
  const inputEnabled: boolean[] = [];
  const onReady = vi.fn();
  const onClosed = vi.fn();
  const transport = new JobTerminalTransport({
    sessionId: SESSION_ID,
    ticket: TICKET,
    accessToken: 'jwt-secret-that-must-not-leak',
    location: LOCATION,
    webSocketFactory: (url) => {
      const socket = new FakeTerminalSocket();
      sockets.push(socket);
      expect(url).toBe(
        'wss://workbench.example:8443/api/v1/ws/terminals?ticket=short%20ticket%3F%26',
      );
      expect(url).not.toContain('session-1');
      expect(url).not.toContain('jwt-secret');
      return socket;
    },
    onStateChange: (state) => states.push(state),
    onInputEnabledChange: (enabled) => inputEnabled.push(enabled),
    onReady,
    onClosed,
    ...overrides,
  });
  return { transport, sockets, states, inputEnabled, onReady, onClosed };
}

function ready(socket: FakeTerminalSocket): void {
  socket.open();
  socket.message(JSON.stringify({ type: 'terminal.ready', sessionId: SESSION_ID }));
}

describe('JobTerminalTransport generation and handshake', () => {
  it('maps an HTTP origin to the fixed ws endpoint', () => {
    expect(buildJobTerminalWebSocketUrl(
      { protocol: 'http:', host: 'localhost:4173' },
      parseTerminalTicket('ticket/with space'),
    )).toBe('ws://localhost:4173/api/v1/ws/terminals?ticket=ticket%2Fwith%20space');
  });

  it('opens exactly the fixed same-origin URL and waits for the exact ready session', () => {
    const harness = createHarness();

    harness.transport.connect();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.binaryType).toBe('arraybuffer');
    expect(harness.states).toEqual(['connecting']);

    ready(harness.sockets[0]!);
    expect(harness.states).toEqual(['connecting', 'awaiting-ready', 'ready']);
    expect(harness.onReady).toHaveBeenCalledTimes(1);
    expect(harness.sockets[0]?.sent).toEqual([]);
  });

  it('fails closed on pre-ready, malformed, mismatched or duplicate ready frames', () => {
    const frames = [
      new ArrayBuffer(1),
      JSON.stringify({ type: 'terminal.input.pause' }),
      JSON.stringify({ type: 'terminal.ready', sessionId: 'other-session' }),
      JSON.stringify({ type: 'terminal.ready', sessionId: SESSION_ID, extra: true }),
    ];

    for (const frame of frames) {
      const harness = createHarness();
      harness.transport.connect();
      const socket = harness.sockets[0]!;
      socket.open();
      socket.message(frame);
      expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
      expect(socket.closes).toEqual([{ code: 4400 }]);
    }

    const duplicate = createHarness();
    duplicate.transport.connect();
    const socket = duplicate.sockets[0]!;
    ready(socket);
    socket.message(JSON.stringify({ type: 'terminal.ready', sessionId: SESSION_ID }));
    expect(duplicate.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
  });

  it('initializes once, answers heartbeat, and gates the input pump on server pause', () => {
    const harness = createHarness();
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);

    expect(harness.transport.initialize(100, 30)).toBe(true);
    expect(controlFrames(socket)).toEqual([
      { type: 'terminal.resize', cols: 100, rows: 30 },
      { type: 'terminal.output.credit', bytes: 256 * 1024 },
    ]);
    expect(harness.inputEnabled).toEqual([true]);

    socket.message(JSON.stringify({ type: 'terminal.ping', nonce: 'ping-1' }));
    expect(controlFrames(socket).at(-1)).toEqual({ type: 'terminal.pong', nonce: 'ping-1' });

    socket.message(JSON.stringify({ type: 'terminal.input.pause' }));
    expect(harness.inputEnabled).toEqual([true, false]);
    expect(harness.transport.sendBinary(String.fromCharCode(0x00, 0xff, 0x1b))).toBe(true);
    expect(binaryFrames(socket)).toEqual([]);

    socket.message(JSON.stringify({ type: 'terminal.input.resume' }));
    expect(binaryFrames(socket)).toEqual([[0x00, 0xff, 0x1b]]);
    expect(harness.inputEnabled).toEqual([true, false, true]);
    expect(harness.transport.initialize(80, 24)).toBe(false);
    expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
  });

  it('makes every old socket event and callback a no-op after dispose', () => {
    const harness = createHarness();
    harness.transport.connect();
    const socket = harness.sockets[0]!;

    harness.transport.dispose();
    socket.open();
    socket.message(JSON.stringify({ type: 'terminal.ready', sessionId: SESSION_ID }));
    socket.error();
    socket.remoteClose(1011, 'secret reason');

    expect(harness.states).toEqual(['connecting', 'disposed']);
    expect(harness.onReady).not.toHaveBeenCalled();
    expect(harness.onClosed).not.toHaveBeenCalled();
    expect(harness.inputEnabled).toEqual([]);
    expect(harness.sockets).toHaveLength(1);
  });
});

describe('JobTerminalTransport output acknowledgement', () => {
  it('delivers binary frames in order and replenishes credit only after the consumer acks', () => {
    const output: JobTerminalOutputFrame[] = [];
    const harness = createHarness({ onOutput: (frame) => output.push(frame) });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    socket.message(new Uint8Array([0x00, 0xff, 0x1b]).buffer);
    socket.message(new Uint8Array([0xe4, 0xb8, 0xad]).buffer);

    expect(output.map((frame) => ({
      bytes: [...frame.data],
      byteLength: frame.byteLength,
    }))).toEqual([
      { bytes: [0x00, 0xff, 0x1b], byteLength: 3 },
      { bytes: [0xe4, 0xb8, 0xad], byteLength: 3 },
    ]);
    expect(controlFrames(socket)).toEqual([
      { type: 'terminal.resize', cols: 80, rows: 24 },
      { type: 'terminal.output.credit', bytes: 256 * 1024 },
    ]);

    expect(output[0]?.ack(3)).toBe(true);
    expect(output[1]?.ack(3)).toBe(true);
    expect(controlFrames(socket).slice(2)).toEqual([
      { type: 'terminal.output.ack', bytes: 3 },
      { type: 'terminal.output.credit', bytes: 3 },
      { type: 'terminal.output.ack', bytes: 3 },
      { type: 'terminal.output.credit', bytes: 3 },
    ]);
  });

  it('fails closed on a mismatched, duplicate, or out-of-order frame ack', () => {
    const mismatchOutput: JobTerminalOutputFrame[] = [];
    const mismatch = createHarness({ onOutput: (frame) => mismatchOutput.push(frame) });
    mismatch.transport.connect();
    ready(mismatch.sockets[0]!);
    mismatch.transport.initialize(80, 24);
    mismatch.sockets[0]!.message(new Uint8Array([1, 2, 3]).buffer);
    expect(mismatchOutput[0]?.ack(2)).toBe(false);
    expect(mismatch.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });

    const duplicateOutput: JobTerminalOutputFrame[] = [];
    const duplicate = createHarness({ onOutput: (frame) => duplicateOutput.push(frame) });
    duplicate.transport.connect();
    ready(duplicate.sockets[0]!);
    duplicate.transport.initialize(80, 24);
    duplicate.sockets[0]!.message(new Uint8Array([1]).buffer);
    expect(duplicateOutput[0]?.ack(1)).toBe(true);
    expect(duplicateOutput[0]?.ack(1)).toBe(false);
    expect(duplicate.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });

    const orderedOutput: JobTerminalOutputFrame[] = [];
    const ordered = createHarness({ onOutput: (frame) => orderedOutput.push(frame) });
    ordered.transport.connect();
    ready(ordered.sockets[0]!);
    ordered.transport.initialize(80, 24);
    ordered.sockets[0]!.message(new Uint8Array([1]).buffer);
    ordered.sockets[0]!.message(new Uint8Array([2]).buffer);
    expect(orderedOutput[1]?.ack(1)).toBe(false);
    expect(ordered.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
  });

  it('rejects output before initialization and invalid zero or oversized binary frames', () => {
    const cases = [new ArrayBuffer(0), new ArrayBuffer(32 * 1024 + 1)];

    const beforeInitialize = createHarness({ onOutput: vi.fn() });
    beforeInitialize.transport.connect();
    ready(beforeInitialize.sockets[0]!);
    beforeInitialize.sockets[0]!.message(new ArrayBuffer(1));
    expect(beforeInitialize.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });

    for (const frame of cases) {
      const harness = createHarness({ onOutput: vi.fn() });
      harness.transport.connect();
      ready(harness.sockets[0]!);
      harness.transport.initialize(80, 24);
      harness.sockets[0]!.message(frame);
      expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
    }
  });

  it('fails closed if unacknowledged output exceeds the granted 256 KiB window', () => {
    const output: JobTerminalOutputFrame[] = [];
    const harness = createHarness({ onOutput: (frame) => output.push(frame) });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    for (let index = 0; index < 8; index += 1) socket.message(new ArrayBuffer(32 * 1024));
    expect(output).toHaveLength(8);
    expect(harness.transport.currentState).toBe('ready');

    socket.message(new ArrayBuffer(32 * 1024));
    expect(output).toHaveLength(8);
    expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'protocol-error' });
  });

  it('turns a captured output ack into a no-op after its generation is disposed', () => {
    const output: JobTerminalOutputFrame[] = [];
    const harness = createHarness({ onOutput: (frame) => output.push(frame) });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);
    socket.message(new Uint8Array([1, 2, 3]).buffer);
    const controlsBeforeDispose = controlFrames(socket);

    harness.transport.dispose();
    expect(output[0]?.ack(3)).toBe(false);
    expect(controlFrames(socket)).toEqual(controlsBeforeDispose);
    expect(harness.onClosed).not.toHaveBeenCalled();
  });
});

describe('JobTerminalTransport terminal close policy', () => {
  it('tears down an open generation in the exact security order', () => {
    const trace: string[] = [];
    const socket = new FakeTerminalSocket(trace);
    const clock = createManualScheduler();
    const harness = createHarness({
      scheduler: {
        ...clock.scheduler,
        clearTimeout: (id) => {
          trace.push('pump:stop');
          clock.scheduler.clearTimeout(id);
        },
      },
      webSocketFactory: () => socket,
      onInputEnabledChange: (enabled) => trace.push(`input:${enabled}`),
      onStateChange: (state) => trace.push(`observer:state:${state}`),
      onClosed: () => trace.push('observer:closed'),
    });
    harness.transport.connect();
    ready(socket);
    harness.transport.initialize(80, 24);
    const start = trace.length;
    socket.bufferedAmount = 256 * 1024;
    harness.transport.sendData('queued');
    expect(clock.pendingCount()).toBe(1);

    harness.transport.close();

    expect(trace.slice(start)).toEqual([
      'input:false',
      'pump:stop',
      'socket:send:terminal.close',
      'socket:close',
      'socket:remove:open',
      'socket:remove:message',
      'socket:remove:error',
      'socket:remove:close',
      'observer:state:closed',
      'observer:closed',
    ]);
  });

  it('commits teardown before an input observer can reenter close', () => {
    let activeTransport: JobTerminalTransport | null = null;
    const onClosed = vi.fn();
    const harness = createHarness({
      onInputEnabledChange: (enabled) => {
        if (!enabled) activeTransport?.close();
      },
      onClosed,
    });
    activeTransport = harness.transport;
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    harness.transport.close();

    expect(controlFrames(socket).filter((frame) => (
      typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'terminal.close'
    ))).toHaveLength(1);
    expect(socket.closes).toEqual([{ code: 1000 }]);
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('sends terminal.close once for an explicit close and never creates another socket', () => {
    const harness = createHarness();
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    harness.transport.close();
    harness.transport.close();
    harness.transport.connect();

    expect(controlFrames(socket).at(-1)).toEqual({ type: 'terminal.close' });
    expect(controlFrames(socket).filter((frame) => (
      typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'terminal.close'
    ))).toHaveLength(1);
    expect(socket.closes).toEqual([{ code: 1000 }]);
    expect(harness.onClosed).toHaveBeenCalledTimes(1);
    expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'client-close' });
    expect(harness.sockets).toHaveLength(1);
  });

  it('ends a post-handshake socket generation without reconnecting or exposing close reason text', () => {
    const consoleSpies = [console.log, console.warn, console.error].map((method) =>
      vi.spyOn(console, method.name as 'log' | 'warn' | 'error').mockImplementation(() => {}),
    );
    const harness = createHarness();
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    socket.remoteClose(1011, 'ticket=short-ticket session=session-1 jwt=jwt-secret');
    socket.message(JSON.stringify({ type: 'terminal.ping', nonce: 'late' }));
    harness.transport.connect();

    expect(harness.onClosed).toHaveBeenCalledTimes(1);
    expect(harness.onClosed).toHaveBeenCalledWith({ kind: 'socket-close', code: 1011 });
    expect(JSON.stringify(harness.onClosed.mock.calls)).not.toContain('ticket=');
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.states.at(-1)).toBe('closed');
  });

  it('treats exit, server error, and socket error as terminal generations', () => {
    const serverFrames = [
      {
        frame: { type: 'terminal.exit', exitCode: 0, reason: 'SHELL_EXITED' },
        closed: { kind: 'server-exit', exitCode: 0, reason: 'SHELL_EXITED' },
      },
      {
        frame: { type: 'terminal.error', code: 'PTY_EXEC_FAILED', retryable: false },
        closed: { kind: 'server-error', code: 'PTY_EXEC_FAILED' },
      },
    ];
    for (const item of serverFrames) {
      const harness = createHarness();
      harness.transport.connect();
      const socket = harness.sockets[0]!;
      ready(socket);
      socket.message(JSON.stringify(item.frame));
      harness.transport.connect();
      expect(harness.onClosed).toHaveBeenCalledWith(item.closed);
      expect(harness.sockets).toHaveLength(1);
    }

    const errored = createHarness();
    errored.transport.connect();
    const socket = errored.sockets[0]!;
    ready(socket);
    socket.error();
    socket.remoteClose(1006, 'late close');
    expect(errored.onClosed).toHaveBeenCalledTimes(1);
    expect(errored.onClosed).toHaveBeenCalledWith({ kind: 'connection-error' });
    expect(errored.sockets).toHaveLength(1);
  });

  it('runs unauthorized cleanup only for the access token captured by that generation', () => {
    let currentToken = 'alice-token';
    const currentUnauthorized = vi.fn();
    const current = createHarness({
      accessToken: 'alice-token',
      getAccessToken: () => currentToken,
      onUnauthorized: currentUnauthorized,
    });
    current.transport.connect();
    current.sockets[0]!.remoteClose(4401);
    expect(currentUnauthorized).toHaveBeenCalledTimes(1);

    const staleUnauthorized = vi.fn();
    const stale = createHarness({
      accessToken: 'alice-token',
      getAccessToken: () => currentToken,
      onUnauthorized: staleUnauthorized,
    });
    stale.transport.connect();
    currentToken = 'bob-token';
    stale.sockets[0]!.remoteClose(4401, 'UNAUTHENTICATED alice-token');
    expect(staleUnauthorized).not.toHaveBeenCalled();
  });
});

describe('JobTerminalTransport observer-safe teardown', () => {
  it('closes and clears the pump when current-token lookup throws on 4401', () => {
    const clock = createManualScheduler();
    const onUnauthorized = vi.fn();
    const onClosed = vi.fn();
    const harness = createHarness({
      scheduler: clock.scheduler,
      getAccessToken: () => {
        throw new Error('token lookup failed');
      },
      onUnauthorized,
      onClosed,
    });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);
    socket.bufferedAmount = 256 * 1024;
    harness.transport.sendData('queued');
    expect(clock.pendingCount()).toBe(1);

    expect(() => socket.remoteClose(4401)).not.toThrow();

    expect(harness.transport.currentState).toBe('closed');
    expect(clock.pendingCount()).toBe(0);
    expect(harness.inputEnabled).toEqual([true, false]);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith({ kind: 'socket-close', code: 4401 });
    const sentAfterClose = socket.sent.length;
    socket.message(JSON.stringify({ type: 'terminal.ping', nonce: 'late' }));
    expect(socket.sent).toHaveLength(sentAfterClose);
  });

  it('finishes every other notification when unauthorized cleanup throws', () => {
    const onUnauthorized = vi.fn(() => {
      throw new Error('unauthorized observer failed');
    });
    const onClosed = vi.fn();
    const harness = createHarness({
      accessToken: 'alice-token',
      getAccessToken: () => 'alice-token',
      onUnauthorized,
      onClosed,
    });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    expect(() => socket.remoteClose(4401)).not.toThrow();

    expect(harness.transport.currentState).toBe('closed');
    expect(harness.states.at(-1)).toBe('closed');
    expect(harness.inputEnabled).toEqual([true, false]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith({ kind: 'socket-close', code: 4401 });
  });

  it('closes the socket and invalidates old output when input-disabled notification throws', () => {
    const output: JobTerminalOutputFrame[] = [];
    const onClosed = vi.fn();
    const onInputEnabledChange = vi.fn((enabled: boolean) => {
      if (!enabled) throw new Error('input observer failed');
    });
    const harness = createHarness({
      onInputEnabledChange,
      onOutput: (frame) => output.push(frame),
      onClosed,
    });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);
    socket.message(new Uint8Array([1]).buffer);

    expect(() => harness.transport.close()).not.toThrow();

    expect(harness.transport.currentState).toBe('closed');
    expect(socket.closes).toEqual([{ code: 1000 }]);
    expect(onInputEnabledChange.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
    expect(onClosed).toHaveBeenCalledWith({ kind: 'client-close' });
    expect(output[0]?.ack(1)).toBe(false);
  });

  it('isolates throwing state and closed observers after teardown commits', () => {
    const onStateChange = vi.fn((state: string) => {
      if (state === 'closed') throw new Error('state observer failed');
    });
    const onClosed = vi.fn(() => {
      throw new Error('closed observer failed');
    });
    const harness = createHarness({ onStateChange, onClosed });
    harness.transport.connect();
    const socket = harness.sockets[0]!;
    ready(socket);
    harness.transport.initialize(80, 24);

    expect(() => harness.transport.close()).not.toThrow();

    expect(harness.transport.currentState).toBe('closed');
    expect(socket.closes).toEqual([{ code: 1000 }]);
    expect(onStateChange).toHaveBeenCalledWith('closed');
    expect(onClosed).toHaveBeenCalledWith({ kind: 'client-close' });
  });
});
