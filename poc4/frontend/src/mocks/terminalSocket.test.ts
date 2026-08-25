import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseTerminalServerControlJson,
  type TerminalServerControl,
  type TerminalSessionId,
} from '../contracts/terminal';
import { getActiveRun, installVirtualRunClock, startRun, transitionRun } from './runState';
import { ALICE_SEED_PROJECT_ID, resetMockState } from './state';
import { getMockTerminalSocketDiagnostics } from './terminalSocket';
import {
  consumeTerminalTicketByTicket,
  endTerminalSession,
  getLiveTerminalSession,
  getTerminalReservationCount,
  issueTerminalReservation,
  listTerminalAudits,
  setTerminalScenario,
  subscribeTerminalStateEvents,
} from './terminalState';

const ALICE_ID = 'usr-alice';
const NOW = Date.parse('2026-08-25T10:00:00.000Z');
const SEED_REVISION = 'mock-rev-0001';
const CLOSE_TICKET_NOT_AVAILABLE = 4410;
const CLOSE_TICKET_EXPIRED = 4408;
const CLOSE_SESSION_ALREADY_ACTIVE = 4409;
const CLOSE_SESSION_NOT_AVAILABLE = 4410;
const CLOSE_PROTOCOL_ERROR = 4400;
const CLOSE_OUTPUT_FLOW_TIMEOUT = 4411;
const sockets: WebSocket[] = [];

function startRunningRun(): string {
  const started = startRun(ALICE_SEED_PROJECT_ID, {
    expectedWorkspaceRevision: SEED_REVISION,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.code);
  expect(transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, {
    state: 'RUNNING',
  }).ok).toBe(true);
  return started.value.run.id;
}

function issue(runId: string, cols = 80, rows = 24) {
  const result = issueTerminalReservation(
    ALICE_ID,
    ALICE_SEED_PROJECT_ID,
    runId,
    { cols, rows },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function terminalUrl(ticket?: string): string {
  const url = new URL('/api/v1/ws/terminals', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ticket !== undefined) url.searchParams.set('ticket', ticket);
  return url.href;
}

function openTerminal(ticket?: string): WebSocket {
  const socket = new WebSocket(terminalUrl(ticket));
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  return socket;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
    socket.addEventListener('close', (event) => {
      reject(new Error(`closed before open:${event.code}`));
    }, { once: true });
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  });
}

function initializeTerminal(socket: WebSocket, credit = 256 * 1024): void {
  socket.send(JSON.stringify({ type: 'terminal.resize', cols: 80, rows: 24 }));
  socket.send(JSON.stringify({ type: 'terminal.output.credit', bytes: credit }));
}

async function settleSocketEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

class ControlReader {
  private readonly buffered: TerminalServerControl[] = [];
  private readonly waiters: Array<(frame: TerminalServerControl) => void> = [];

  constructor(socket: WebSocket, sessionId: TerminalSessionId) {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const frame = parseTerminalServerControlJson(event.data, sessionId);
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.buffered.push(frame);
      else waiter(frame);
    });
  }

  next(): Promise<TerminalServerControl> {
    const frame = this.buffered.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  snapshot(): readonly TerminalServerControl[] {
    return this.buffered;
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  resetMockState();
  installVirtualRunClock(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  await Promise.resolve();
});

describe('mock terminal WebSocket handshake', () => {
  it('rejects missing, wrong, expired, used and revoked tickets without live state or audit', async () => {
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    for (const ticket of [undefined, 'mock-terminal-ticket-wrong']) {
      const socket = openTerminal(ticket);
      expect(await waitForClose(socket)).toBe(CLOSE_TICKET_NOT_AVAILABLE);
    }

    const expired = issue(runId);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW + 30_000);
    const expiredSocket = openTerminal(expired.ticket);
    expect(await waitForClose(expiredSocket)).toBe(CLOSE_TICKET_EXPIRED);
    nowSpy.mockRestore();

    const used = issue(runId);
    expect(consumeTerminalTicketByTicket(used.ticket).ok).toBe(true);
    const usedSocket = openTerminal(used.ticket);
    expect(await waitForClose(usedSocket)).toBe(CLOSE_SESSION_ALREADY_ACTIVE);
    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: used.sessionId,
      reason: 'CLIENT_CLOSED',
      exitCode: null,
    }).ok).toBe(true);

    const revoked = issue(runId);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
    const revokedSocket = openTerminal(revoked.ticket);
    expect(await waitForClose(revokedSocket)).toBe(CLOSE_SESSION_NOT_AVAILABLE);

    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toHaveLength(1);
    expect(getMockTerminalSocketDiagnostics().execCreated).toBe(diagnosticsBefore.execCreated);
  });

  it('rejects a second live session and scenario handshake failures without consuming tickets', async () => {
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    const first = issue(runId);
    const second = issue(runId);
    expect(consumeTerminalTicketByTicket(first.ticket).ok).toBe(true);
    const activeSocket = openTerminal(second.ticket);
    expect(await waitForClose(activeSocket)).toBe(CLOSE_SESSION_ALREADY_ACTIVE);
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: first.sessionId,
      reason: 'CLIENT_CLOSED',
      exitCode: null,
    }).ok).toBe(true);

    setTerminalScenario('ticket-expired');
    const scenarioTicket = issue(runId);
    const expiredSocket = openTerminal(scenarioTicket.ticket);
    expect(await waitForClose(expiredSocket)).toBe(CLOSE_TICKET_EXPIRED);
    const missingSocket = openTerminal('mock-terminal-ticket-missing-under-scenario');
    expect(await waitForClose(missingSocket)).toBe(CLOSE_TICKET_NOT_AVAILABLE);
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
    expect(getMockTerminalSocketDiagnostics().execCreated).toBe(diagnosticsBefore.execCreated);
  });

  it('rejects an authority-lost reservation with 4410 before ready or resource creation', async () => {
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    const reservation = issue(runId);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
    const socket = openTerminal(reservation.ticket);
    const frames: unknown[] = [];
    socket.addEventListener('message', (event) => frames.push(event.data));

    expect(await waitForClose(socket)).toBe(CLOSE_SESSION_NOT_AVAILABLE);
    expect(frames).toEqual([]);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toEqual([]);
    expect(getMockTerminalSocketDiagnostics()).toEqual(diagnosticsBefore);
  });

  it('maps a valid reservation that becomes unavailable at handshake to 4410', async () => {
    setTerminalScenario('ticket-unavailable');
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const frames: unknown[] = [];
    socket.addEventListener('message', (event) => frames.push(event.data));

    expect(await waitForClose(socket)).toBe(CLOSE_SESSION_NOT_AVAILABLE);
    expect(frames).toEqual([]);
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toEqual([]);
    expect(getMockTerminalSocketDiagnostics()).toEqual(diagnosticsBefore);
  });

  it('disconnects with 1011 only after ready and initialization, then settles INTERRUPTED', async () => {
    setTerminalScenario('disconnect');
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect(await controls.next()).toEqual({
      type: 'terminal.ready',
      sessionId: reservation.sessionId,
    });
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toMatchObject({
      sessionId: reservation.sessionId,
      state: 'live',
    });
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toMatchObject([
      { sessionId: reservation.sessionId, state: 'RUNNING' },
    ]);
    const closeCode = await Promise.race([
      (async () => {
        const closed = waitForClose(socket);
        initializeTerminal(socket);
        return closed;
      })(),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 500)),
    ]);

    expect(closeCode).toBe(1011);
    await settleSocketEvents();
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
      sessionId: reservation.sessionId,
    }).items).toMatchObject([{ state: 'INTERRUPTED', exitCode: null }]);
    expect(getMockTerminalSocketDiagnostics()).toEqual({
      execCreated: diagnosticsBefore.execCreated + 1,
      execDestroyed: diagnosticsBefore.execDestroyed + 1,
      activeConnections: diagnosticsBefore.activeConnections,
    });
  });

  it('rejects duplicate ticket and extra query parameters without consuming either reservation', async () => {
    const runId = startRunningRun();
    const reservations = [issue(runId), issue(runId)];
    const urls = reservations.map((reservation, index) => {
      const url = new URL(terminalUrl(reservation.ticket));
      if (index === 0) url.searchParams.append('ticket', 'mock-terminal-ticket-other');
      else url.searchParams.set('sessionId', reservation.sessionId);
      return url.href;
    });

    for (const url of urls) {
      const socket = new WebSocket(url);
      sockets.push(socket);
      const closeCode = await Promise.race([
        waitForClose(socket),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 100)),
      ]);
      expect(closeCode).toBe(CLOSE_TICKET_NOT_AVAILABLE);
    }
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(2);
  });

  it('consumes one ticket before publishing one ready and a RUNNING audit', async () => {
    const diagnosticsBefore = getMockTerminalSocketDiagnostics();
    const runId = startRunningRun();
    const reservation = issue(runId, 132, 43);
    const socket = openTerminal(reservation.ticket);
    const reader = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);

    expect(await reader.next()).toEqual({
      type: 'terminal.ready',
      sessionId: reservation.sessionId,
    });
    await Promise.resolve();
    expect(reader.snapshot().filter((frame) => frame.type === 'terminal.ready')).toHaveLength(0);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toMatchObject({
      sessionId: reservation.sessionId,
      cols: 132,
      rows: 43,
      state: 'live',
    });
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toMatchObject([
      { sessionId: reservation.sessionId, state: 'RUNNING' },
    ]);
    expect(getMockTerminalSocketDiagnostics().execCreated - diagnosticsBefore.execCreated).toBe(1);
  });
});

describe('mock PTY binary direction', () => {
  it('echoes arbitrary input bytes as ordered binary frames without JSON reinterpretation', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    const output: Uint8Array[] = [];
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) output.push(new Uint8Array(event.data));
    });
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    initializeTerminal(socket);

    const ptyMarker = 'PTY#9';
    const fragments = [
      new Uint8Array([0x00, 0x01, 0x1b, 0x7f]),
      new Uint8Array([0xf0, 0x9f]),
      new Uint8Array([80, 84, 89, 35, 57]),
    ];
    for (const fragment of fragments) socket.send(fragment.buffer.slice(0));
    await settleSocketEvents();

    expect(output.map((frame) => [...frame])).toEqual(
      fragments.map((fragment) => [...fragment]),
    );
    const terminalOutput = output.map((frame) => new TextDecoder().decode(frame)).join('');
    expect(terminalOutput).toContain(ptyMarker);
    expect(terminalOutput).not.toMatch(/AUDIT#9|RUN#9/);
    expect(controls.snapshot()).toEqual([]);
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items)
      .not.toContainEqual(expect.objectContaining({ command: expect.stringContaining(ptyMarker) }));
  });

  it('fails closed on binary before initialization and binary above 32 KiB', async () => {
    const runId = startRunningRun();
    const beforeInit = issue(runId);
    const first = openTerminal(beforeInit.ticket);
    const firstControls = new ControlReader(first, beforeInit.sessionId);
    await waitForOpen(first);
    expect((await firstControls.next()).type).toBe('terminal.ready');
    const firstClose = waitForClose(first);
    first.send(new Uint8Array([0x00]).buffer);
    expect(await firstClose).toBe(CLOSE_PROTOCOL_ERROR);

    const oversizedReservation = issue(runId);
    const oversized = openTerminal(oversizedReservation.ticket);
    const oversizedControls = new ControlReader(oversized, oversizedReservation.sessionId);
    await waitForOpen(oversized);
    expect((await oversizedControls.next()).type).toBe('terminal.ready');
    initializeTerminal(oversized);
    const oversizedClose = waitForClose(oversized);
    oversized.send(new ArrayBuffer(32 * 1024 + 1));
    expect(await oversizedClose).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it('fails closed on control above 8 KiB and unknown or duplicate initial control', async () => {
    const runId = startRunningRun();
    const cases: string[][] = [
      [JSON.stringify({ type: 'terminal.close', padding: 'x'.repeat(8 * 1024) })],
      [JSON.stringify({ type: 'terminal.ready' })],
      [
        JSON.stringify({ type: 'terminal.resize', cols: 80, rows: 24 }),
        JSON.stringify({ type: 'terminal.resize', cols: 80, rows: 24 }),
      ],
    ];

    for (const controls of cases) {
      const reservation = issue(runId);
      const socket = openTerminal(reservation.ticket);
      const reader = new ControlReader(socket, reservation.sessionId);
      await waitForOpen(socket);
      expect((await reader.next()).type).toBe('terminal.ready');
      const closed = waitForClose(socket);
      for (const control of controls) socket.send(control);
      expect(await closed).toBe(CLOSE_PROTOCOL_ERROR);
    }
  });
});

describe('terminal output credit and acknowledgement', () => {
  it('treats a zero-byte binary input as a no-op without output or ack timeout', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    const output: ArrayBuffer[] = [];
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) output.push(event.data);
    });
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    initializeTerminal(socket, 1);
    socket.send(new ArrayBuffer(0));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(output).toEqual([]);
    expect(controls.snapshot()).not.toContainEqual({
      type: 'terminal.error',
      code: 'OUTPUT_FLOW_TIMEOUT',
      retryable: false,
    });
  });

  it('holds output until credit is sufficient and accepts the exact frame ack', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    const output: Uint8Array[] = [];
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) output.push(new Uint8Array(event.data));
    });
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    initializeTerminal(socket, 4);
    socket.send(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer);
    await settleSocketEvents();
    expect(output).toEqual([]);

    socket.send(JSON.stringify({ type: 'terminal.output.credit', bytes: 2 }));
    await settleSocketEvents();
    expect(output.map((frame) => [...frame])).toEqual([[0, 1, 2, 3, 4, 5]]);
    socket.send(JSON.stringify({ type: 'terminal.output.ack', bytes: 6 }));
    await settleSocketEvents();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('fails closed when ack does not exactly match the oldest output frame', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    initializeTerminal(socket, 16);
    socket.send(new Uint8Array([1, 2, 3, 4]).buffer);
    await settleSocketEvents();

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: 'terminal.output.ack', bytes: 3 }));
    expect(await closed).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it('caps granted plus outstanding output at 256 KiB', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    initializeTerminal(socket);
    for (let index = 0; index < 8; index += 1) {
      socket.send(new ArrayBuffer(32 * 1024));
    }
    await settleSocketEvents();

    socket.send(JSON.stringify({ type: 'terminal.output.credit', bytes: 1 }));
    await settleSocketEvents();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('closes with OUTPUT_FLOW_TIMEOUT when sent output is not acknowledged', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    initializeTerminal(socket, 4);
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const closed = waitForClose(socket);
    socket.send(new Uint8Array([1, 2, 3, 4]).buffer);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(controls.snapshot()).toContainEqual({
      type: 'terminal.error',
      code: 'OUTPUT_FLOW_TIMEOUT',
      retryable: false,
    });
    expect(await closed).toBe(CLOSE_OUTPUT_FLOW_TIMEOUT);
  });
});

describe('terminal input pause', () => {
  it('pauses the server fixture then resumes input without losing binary bytes', async () => {
    setTerminalScenario('server-pause');
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    const output: Uint8Array[] = [];
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) output.push(new Uint8Array(event.data));
    });
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    initializeTerminal(socket, 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.snapshot()).toContainEqual({ type: 'terminal.input.pause' });

    await vi.advanceTimersByTimeAsync(250);
    expect(controls.snapshot()).toContainEqual({ type: 'terminal.input.resume' });
    socket.send(new Uint8Array([0x00, 0xff, 0x1b, 0x7f]).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(output.map((frame) => [...frame])).toEqual([[0x00, 0xff, 0x1b, 0x7f]]);
  });
});

describe('terminal heartbeat', () => {
  it('keeps the session live for the exact pong and rejects a duplicate pong', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    initializeTerminal(socket, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const ping = controls.snapshot().find((frame) => frame.type === 'terminal.ping');
    expect(ping).toMatchObject({ type: 'terminal.ping', nonce: expect.any(String) });
    if (ping?.type !== 'terminal.ping') throw new Error('missing ping');

    socket.send(JSON.stringify({ type: 'terminal.pong', nonce: ping.nonce }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: 'terminal.pong', nonce: ping.nonce }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await closed).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it('fails closed when pong is not received before the heartbeat deadline', async () => {
    const runId = startRunningRun();
    const reservation = issue(runId);
    const socket = openTerminal(reservation.ticket);
    const controls = new ControlReader(socket, reservation.sessionId);
    await waitForOpen(socket);
    expect((await controls.next()).type).toBe('terminal.ready');
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    initializeTerminal(socket, 1);
    const closed = waitForClose(socket);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(controls.snapshot()).toContainEqual({
      type: 'terminal.error',
      code: 'PROTOCOL_ERROR',
      retryable: false,
    });
    expect(await closed).toBe(CLOSE_PROTOCOL_ERROR);
  });
});

describe('terminal destroy and audit finalization', () => {
  function expectOneDestroy(before: { execCreated: number; execDestroyed: number }): void {
    const after = getMockTerminalSocketDiagnostics() as ReturnType<
      typeof getMockTerminalSocketDiagnostics
    > & { activeConnections: number };
    expect(after.execCreated - before.execCreated).toBe(1);
    expect(after.execDestroyed - before.execDestroyed).toBe(1);
    expect(after.activeConnections).toBe(0);
  }

  it('destroys once for terminal.close, browser disconnect and protocol error', async () => {
    const runId = startRunningRun();
    for (const ending of ['terminal.close', 'browser.close', 'protocol.error'] as const) {
      const before = getMockTerminalSocketDiagnostics();
      const reservation = issue(runId);
      const socket = openTerminal(reservation.ticket);
      const controls = new ControlReader(socket, reservation.sessionId);
      await waitForOpen(socket);
      expect((await controls.next()).type).toBe('terminal.ready');
      const closed = waitForClose(socket);
      if (ending === 'terminal.close') {
        socket.send(JSON.stringify({ type: 'terminal.close' }));
        expect(await controls.next()).toEqual({
          type: 'terminal.exit',
          exitCode: null,
          reason: 'CLIENT_CLOSED',
        });
      } else if (ending === 'browser.close') {
        socket.close();
      } else {
        socket.send(new Uint8Array([1]).buffer);
        expect(await controls.next()).toEqual({
          type: 'terminal.error',
          code: 'PROTOCOL_ERROR',
          retryable: false,
        });
      }
      await closed;
      await settleSocketEvents();
      expectOneDestroy(before);
      const audit = listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        sessionId: reservation.sessionId,
      }).items[0];
      expect(audit?.state).not.toBe('RUNNING');
    }
  });

  it('survives a throwing observer and closes exactly once when Run leaves RUNNING', async () => {
    const runId = startRunningRun();
    const throwing = subscribeTerminalStateEvents(() => {
      throw new Error('observer failure');
    });
    try {
      const before = getMockTerminalSocketDiagnostics();
      const reservation = issue(runId);
      const socket = openTerminal(reservation.ticket);
      const controls = new ControlReader(socket, reservation.sessionId);
      await waitForOpen(socket);
      expect((await controls.next()).type).toBe('terminal.ready');
      initializeTerminal(socket, 1);
      const closed = waitForClose(socket);

      expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
      expect(await controls.next()).toEqual({
        type: 'terminal.exit',
        exitCode: null,
        reason: 'RUN_LEFT_RUNNING',
      });
      expect(await closed).toBe(1000);
      expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('STOPPING');
      expectOneDestroy(before);
      expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        sessionId: reservation.sessionId,
      }).items[0]?.state).toBe('INTERRUPTED');
    } finally {
      throwing();
    }
  });

  it('settles shell exit without duplicate cleanup', async () => {
    const runId = startRunningRun();
    setTerminalScenario('shell-exit');
    const shellBefore = getMockTerminalSocketDiagnostics();
    const shellReservation = issue(runId);
    const shell = openTerminal(shellReservation.ticket);
    const shellControls = new ControlReader(shell, shellReservation.sessionId);
    await waitForOpen(shell);
    expect((await shellControls.next()).type).toBe('terminal.ready');
    const shellClosed = waitForClose(shell);
    initializeTerminal(shell, 1);
    await settleSocketEvents();
    expect(shellControls.snapshot()).toContainEqual({
      type: 'terminal.exit',
      exitCode: 0,
      reason: 'SHELL_EXITED',
    });
    expect(await shellClosed).toBe(1000);
    expectOneDestroy(shellBefore);
    expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
      sessionId: shellReservation.sessionId,
    }).items[0]?.state).toBe('SUCCEEDED');
  });
});
