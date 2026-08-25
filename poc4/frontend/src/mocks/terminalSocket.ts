import { ws } from 'msw';
import {
  MAX_TERMINAL_CONTROL_FRAME_BYTES,
  MAX_TERMINAL_OUTPUT_CREDIT_BYTES,
  parseTerminalClientControl,
  validateTerminalBinaryFrame,
  type TerminalExitReason,
  type TerminalServerControl,
} from '../contracts/terminal';
import {
  classifyTerminalTicketForHandshake,
  consumeTerminalTicketByTicket,
  endTerminalSession,
  getTerminalScenario,
  subscribeTerminalStateEvents,
} from './terminalState';

export const TERMINAL_SOCKET_CLOSE_CODES = {
  PROTOCOL_ERROR: 4400,
  UNAUTHENTICATED: 4401,
  TICKET_EXPIRED: 4408,
  SESSION_ALREADY_ACTIVE: 4409,
  SESSION_NOT_AVAILABLE: 4410,
  OUTPUT_FLOW_TIMEOUT: 4411,
} as const;

export const TERMINAL_OUTPUT_ACK_TIMEOUT_MS = 5_000;
export const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;
export const TERMINAL_HEARTBEAT_TIMEOUT_MS = 5_000;
export const MOCK_TERMINAL_STRESS_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MOCK_TERMINAL_STRESS_FRAME_BYTES = 32 * 1024;
export const MOCK_TERMINAL_STRESS_FINAL_MARKER = 'ensoai-stage5-terminal-stress-final-marker';

let mockExecCreated = 0;
let mockExecDestroyed = 0;
let activeConnections = 0;
const activeConnectionResetters = new Set<() => void>();

export function getMockTerminalSocketDiagnostics(): {
  execCreated: number;
  execDestroyed: number;
  activeConnections: number;
} {
  return { execCreated: mockExecCreated, execDestroyed: mockExecDestroyed, activeConnections };
}

class MockTerminalExec {
  private destroyed = false;

  constructor() {
    mockExecCreated += 1;
    activeConnections += 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    mockExecDestroyed += 1;
    activeConnections -= 1;
  }
}

const controlEncoder = new TextEncoder();

function parseClientControlFrame(text: string) {
  if (controlEncoder.encode(text).byteLength > MAX_TERMINAL_CONTROL_FRAME_BYTES) {
    throw new Error('Invalid terminal frame');
  }
  return parseTerminalClientControl(JSON.parse(text) as unknown);
}

function parseClientBinaryFrame(value: unknown): ArrayBuffer {
  validateTerminalBinaryFrame(value);
  return value as ArrayBuffer;
}

function sameOriginTerminalEndpoint(): string {
  const endpoint = new URL('/api/v1/ws/terminals', globalThis.location.href);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.href;
}

const terminals = ws.link(sameOriginTerminalEndpoint());

function handshakeCloseCode(
  code: Exclude<ReturnType<typeof classifyTerminalTicketForHandshake>, { ok: true }>['code'],
): number {
  switch (code) {
    case 'TICKET_NOT_AVAILABLE':
      return TERMINAL_SOCKET_CLOSE_CODES.SESSION_NOT_AVAILABLE;
    case 'TICKET_EXPIRED':
      return TERMINAL_SOCKET_CLOSE_CODES.TICKET_EXPIRED;
    case 'TICKET_ALREADY_USED':
    case 'SESSION_ALREADY_ACTIVE':
      return TERMINAL_SOCKET_CLOSE_CODES.SESSION_ALREADY_ACTIVE;
    case 'SESSION_NOT_AVAILABLE':
      return TERMINAL_SOCKET_CLOSE_CODES.SESSION_NOT_AVAILABLE;
  }
}

export const terminalSocketHandler = terminals.addEventListener('connection', ({ client }) => {
  const rejectHandshake = (code: number): void => {
    setTimeout(() => client.close(code), 0);
  };
  const queryKeys = [...client.url.searchParams.keys()];
  const ticketValues = client.url.searchParams.getAll('ticket');
  const ticket = ticketValues[0];
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'ticket' ||
    ticketValues.length !== 1 ||
    ticket === undefined ||
    ticket === ''
  ) {
    rejectHandshake(TERMINAL_SOCKET_CLOSE_CODES.SESSION_NOT_AVAILABLE);
    return;
  }
  const classification = classifyTerminalTicketForHandshake(ticket);
  if (!classification.ok) {
    rejectHandshake(handshakeCloseCode(classification.code));
    return;
  }

  const scenario = getTerminalScenario();
  if (scenario === 'ticket-expired') {
    rejectHandshake(TERMINAL_SOCKET_CLOSE_CODES.TICKET_EXPIRED);
    return;
  }
  if (scenario === 'ticket-unavailable') {
    rejectHandshake(TERMINAL_SOCKET_CLOSE_CODES.SESSION_NOT_AVAILABLE);
    return;
  }
  if (scenario === 'already-active') {
    rejectHandshake(TERMINAL_SOCKET_CLOSE_CODES.SESSION_ALREADY_ACTIVE);
    return;
  }
  const consumed = consumeTerminalTicketByTicket(ticket);
  if (!consumed.ok) {
    rejectHandshake(
      consumed.code === 'TERMINAL_SESSION_ALREADY_ACTIVE'
        ? TERMINAL_SOCKET_CLOSE_CODES.SESSION_ALREADY_ACTIVE
        : TERMINAL_SOCKET_CLOSE_CODES.SESSION_NOT_AVAILABLE,
    );
    return;
  }

  const session = consumed.value;
  const exec = new MockTerminalExec();
  let terminated = false;
  let unsubscribe: (() => void) | null = null;
  let resetConnection: (() => void) | null = null;
  let initialResize = false;
  let initialCredit = false;
  let initialized = false;
  let inputPaused = false;
  let availableCredit = 0;
  let outstandingBytes = 0;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let fixtureTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPongNonce: string | null = null;
  let nextPingSequence = 0;
  const outstandingFrames: number[] = [];
  const outputQueue: ArrayBuffer[] = [];

  const sendControl = (frame: TerminalServerControl): void => {
    if (terminated) return;
    client.send(JSON.stringify(frame));
  };

  const releaseResources = (): void => {
    if (ackTimer !== null) clearTimeout(ackTimer);
    ackTimer = null;
    if (fixtureTimer !== null) clearTimeout(fixtureTimer);
    fixtureTimer = null;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (pongTimer !== null) clearTimeout(pongTimer);
    pongTimer = null;
    pendingPongNonce = null;
    if (resetConnection !== null) activeConnectionResetters.delete(resetConnection);
    resetConnection = null;
    unsubscribe?.();
    unsubscribe = null;
    exec.destroy();
  };

  const closeAfterStateSettlement = (
    reason: TerminalExitReason,
    exitCode: number | null,
    frame: TerminalServerControl | null,
    closeCode: number,
  ): void => {
    if (terminated) return;
    if (frame !== null) client.send(JSON.stringify(frame));
    terminated = true;
    releaseResources();
    endTerminalSession({
      userId: session.userId,
      projectId: session.projectId,
      runId: session.runId,
      sessionId: session.sessionId,
      reason,
      exitCode,
    });
    queueMicrotask(() => client.close(closeCode));
  };

  resetConnection = () => {
    closeAfterStateSettlement('CONNECTION_LOST', null, null, 1000);
  };
  activeConnectionResetters.add(resetConnection);

  const protocolError = (): void => {
    closeAfterStateSettlement(
      'BACKEND_ERROR',
      null,
      { type: 'terminal.error', code: 'PROTOCOL_ERROR', retryable: false },
      TERMINAL_SOCKET_CLOSE_CODES.PROTOCOL_ERROR,
    );
  };

  const inputOverflow = (): void => {
    closeAfterStateSettlement(
      'BACKEND_ERROR',
      null,
      { type: 'terminal.error', code: 'INPUT_OVERFLOW', retryable: false },
      TERMINAL_SOCKET_CLOSE_CODES.PROTOCOL_ERROR,
    );
  };

  const restartAckTimer = (): void => {
    if (ackTimer !== null) clearTimeout(ackTimer);
    ackTimer = outstandingFrames.length === 0
      ? null
      : setTimeout(() => {
          closeAfterStateSettlement(
            'BACKEND_ERROR',
            null,
            { type: 'terminal.error', code: 'OUTPUT_FLOW_TIMEOUT', retryable: false },
            TERMINAL_SOCKET_CLOSE_CODES.OUTPUT_FLOW_TIMEOUT,
          );
        }, TERMINAL_OUTPUT_ACK_TIMEOUT_MS);
  };

  const flushOutput = (): void => {
    while (!terminated && outputQueue.length > 0) {
      const next = outputQueue[0];
      if (next === undefined || next.byteLength > availableCredit) return;
      outputQueue.shift();
      availableCredit -= next.byteLength;
      outstandingBytes += next.byteLength;
      outstandingFrames.push(next.byteLength);
      client.send(next);
      if (ackTimer === null) restartAckTimer();
    }
  };

  const scheduleHeartbeat = (): void => {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (terminated || pendingPongNonce !== null) return;
      nextPingSequence += 1;
      pendingPongNonce = `${session.sessionId}:${String(nextPingSequence)}`;
      sendControl({ type: 'terminal.ping', nonce: pendingPongNonce });
      pongTimer = setTimeout(() => {
        pongTimer = null;
        protocolError();
      }, TERMINAL_HEARTBEAT_TIMEOUT_MS);
    }, TERMINAL_HEARTBEAT_INTERVAL_MS);
  };

  const beginInitializedSession = (): void => {
    if (initialized || !initialResize || !initialCredit) return;
    initialized = true;
    scheduleHeartbeat();
    if (scenario === 'shell-exit') {
      queueMicrotask(() => {
        closeAfterStateSettlement(
          'SHELL_EXITED',
          0,
          { type: 'terminal.exit', exitCode: 0, reason: 'SHELL_EXITED' },
          1000,
        );
      });
      return;
    }
    if (scenario === 'disconnect') {
      fixtureTimer = setTimeout(() => {
        fixtureTimer = null;
        closeAfterStateSettlement('CONNECTION_LOST', null, null, 1011);
      }, 250);
      return;
    }
    if (scenario === 'stress') {
      const payload = new Uint8Array(MOCK_TERMINAL_STRESS_FRAME_BYTES).fill(0x73);
      for (
        let generated = 0;
        generated < MOCK_TERMINAL_STRESS_OUTPUT_BYTES;
        generated += MOCK_TERMINAL_STRESS_FRAME_BYTES
      ) {
        outputQueue.push(payload.slice().buffer);
      }
      outputQueue.push(new TextEncoder().encode(MOCK_TERMINAL_STRESS_FINAL_MARKER).buffer);
      flushOutput();
    }
    if (scenario !== 'server-pause' && scenario !== 'stress') return;
    inputPaused = true;
    sendControl({ type: 'terminal.input.pause' });
    fixtureTimer = setTimeout(() => {
      fixtureTimer = null;
      inputPaused = false;
      sendControl({ type: 'terminal.input.resume' });
    }, 250);
  };

  unsubscribe = subscribeTerminalStateEvents((event) => {
    if (
      terminated ||
      event.type !== 'session.ended' ||
      event.session.sessionId !== session.sessionId
    ) {
      return;
    }
    client.send(JSON.stringify({
      type: 'terminal.exit',
      exitCode: event.session.exitCode,
      reason: event.session.reason,
    } satisfies TerminalServerControl));
    terminated = true;
    releaseResources();
    queueMicrotask(() => client.close(1000));
  });

  client.addEventListener('close', () => {
    if (terminated) return;
    terminated = true;
    releaseResources();
    endTerminalSession({
      userId: session.userId,
      projectId: session.projectId,
      runId: session.runId,
      sessionId: session.sessionId,
      reason: 'CONNECTION_LOST',
      exitCode: null,
    });
  });

  client.addEventListener('message', (event) => {
    if (terminated) return;
    if (typeof event.data === 'string') {
      let control;
      try {
        control = parseClientControlFrame(event.data);
      } catch {
        protocolError();
        return;
      }
      if (control.type === 'terminal.close') {
        closeAfterStateSettlement(
          'CLIENT_CLOSED',
          null,
          { type: 'terminal.exit', exitCode: null, reason: 'CLIENT_CLOSED' },
          1000,
        );
        return;
      }
      if (control.type === 'terminal.resize') {
        if (initialResize && !initialCredit) {
          protocolError();
          return;
        }
        initialResize = true;
        beginInitializedSession();
        return;
      }
      if (control.type === 'terminal.output.credit') {
        if (initialCredit && !initialResize) {
          protocolError();
          return;
        }
        if (
          availableCredit + outstandingBytes + control.bytes >
          MAX_TERMINAL_OUTPUT_CREDIT_BYTES
        ) {
          protocolError();
          return;
        }
        initialCredit = true;
        availableCredit += control.bytes;
        beginInitializedSession();
        flushOutput();
        return;
      }
      if (control.type === 'terminal.output.ack') {
        const expected = outstandingFrames[0];
        if (expected === undefined || control.bytes !== expected) {
          protocolError();
          return;
        }
        outstandingFrames.shift();
        outstandingBytes -= control.bytes;
        restartAckTimer();
        return;
      }
      if (control.type === 'terminal.pong') {
        if (pendingPongNonce === null || control.nonce !== pendingPongNonce) {
          protocolError();
          return;
        }
        if (pongTimer !== null) clearTimeout(pongTimer);
        pongTimer = null;
        pendingPongNonce = null;
        scheduleHeartbeat();
        return;
      }
      protocolError();
      return;
    }
    let binary: ArrayBuffer;
    try {
      binary = parseClientBinaryFrame(event.data);
    } catch {
      protocolError();
      return;
    }
    if (!initialized) {
      protocolError();
      return;
    }
    if (binary.byteLength === 0) return;
    if (inputPaused) {
      inputOverflow();
      return;
    }
    if (scenario === 'stress') return;
    outputQueue.push(binary.slice(0));
    flushOutput();
  });

  sendControl({ type: 'terminal.ready', sessionId: session.sessionId });
});

export function resetTerminalSockets(): void {
  for (const reset of [...activeConnectionResetters]) reset();
  for (const client of [...terminals.clients]) client.close(1000);
  activeConnectionResetters.clear();
  mockExecCreated = 0;
  mockExecDestroyed = 0;
  activeConnections = 0;
}
