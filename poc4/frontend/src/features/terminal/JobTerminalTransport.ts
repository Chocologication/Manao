import {
  MAX_TERMINAL_OUTPUT_CREDIT_BYTES,
  parseTerminalClientControl,
  parseTerminalServerControlJson,
  validateTerminalBinaryFrame,
  type TerminalClientControl,
  type TerminalErrorCode,
  type TerminalExitReason,
  type TerminalSessionId,
  type TerminalTicket,
} from '../../contracts/terminal';
import {
  TerminalInputPump,
  type TerminalInputPumpScheduler,
} from './TerminalInputPump';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const JOB_TERMINAL_PROTOCOL_CLOSE_CODE = 4400;
export const JOB_TERMINAL_HEARTBEAT_WATCHDOG_MS = 30_000;
export const JOB_TERMINAL_CLOSE_GRACE_MS = 2_000;

export type JobTerminalLocation = Pick<Location, 'protocol' | 'host'>;

export type TerminalWebSocketEvent = {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

export type TerminalWebSocketPort = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  addEventListener(type: string, listener: (event: TerminalWebSocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: TerminalWebSocketEvent) => void): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
};

export type JobTerminalTransportState =
  | 'idle'
  | 'connecting'
  | 'awaiting-ready'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'disposed';

export type JobTerminalClosedReason =
  | { kind: 'protocol-error' }
  | { kind: 'input-overflow' }
  | { kind: 'connection-error' }
  | { kind: 'client-close' }
  | { kind: 'socket-close'; code: number }
  | { kind: 'server-error'; code: TerminalErrorCode }
  | { kind: 'server-exit'; exitCode: number | null; reason: TerminalExitReason };

export type JobTerminalOutputFrame = {
  readonly data: Uint8Array;
  readonly byteLength: number;
  ack(bytes: number): boolean;
};

export type JobTerminalTransportOptions = {
  sessionId: TerminalSessionId;
  ticket: TerminalTicket;
  accessToken: string;
  location?: JobTerminalLocation;
  webSocketFactory?: (url: string) => TerminalWebSocketPort;
  scheduler?: TerminalInputPumpScheduler;
  getAccessToken?: () => string | null;
  onUnauthorized?: () => void;
  onStateChange?: (state: JobTerminalTransportState) => void;
  onInputEnabledChange?: (enabled: boolean) => void;
  onReady?: () => void;
  onOutput?: (frame: JobTerminalOutputFrame) => void;
  onClosed?: (reason: JobTerminalClosedReason) => void;
};

type PendingOutputAck = {
  readonly generation: number;
  readonly socket: TerminalWebSocketPort;
  readonly byteLength: number;
  acknowledged: boolean;
};

type TerminalSocketListeners = {
  open: (event: TerminalWebSocketEvent) => void;
  message: (event: TerminalWebSocketEvent) => void;
  error: (event: TerminalWebSocketEvent) => void;
  close: (event: TerminalWebSocketEvent) => void;
};

function assertLocation(location: JobTerminalLocation): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    throw new Error('Unsupported terminal origin protocol');
  }
  if (location.host === '' || /[/?#]/.test(location.host)) {
    throw new Error('Unsupported terminal origin host');
  }
}

export function buildJobTerminalWebSocketUrl(
  location: JobTerminalLocation,
  ticket: TerminalTicket,
): string {
  assertLocation(location);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/v1/ws/terminals?ticket=${encodeURIComponent(ticket)}`;
}

function createBrowserSocket(url: string): TerminalWebSocketPort {
  return new WebSocket(url) as unknown as TerminalWebSocketPort;
}

function notifySafely<Args extends readonly unknown[]>(
  callback: ((...args: Args) => void) | undefined,
  ...args: Args
): void {
  try {
    callback?.(...args);
  } catch {
    // Observer failures cannot interrupt transport state or resource cleanup.
  }
}

export class JobTerminalTransport {
  private readonly sessionId: TerminalSessionId;
  private readonly ticket: TerminalTicket;
  private readonly capturedAccessToken: string;
  private readonly location: JobTerminalLocation;
  private readonly webSocketFactory: (url: string) => TerminalWebSocketPort;
  private readonly scheduler: TerminalInputPumpScheduler;
  private readonly getAccessToken: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly onStateChange: ((state: JobTerminalTransportState) => void) | undefined;
  private readonly onInputEnabledChange: ((enabled: boolean) => void) | undefined;
  private readonly onReady: (() => void) | undefined;
  private readonly onOutput: ((frame: JobTerminalOutputFrame) => void) | undefined;
  private readonly onClosed: ((reason: JobTerminalClosedReason) => void) | undefined;
  private readonly pendingOutputAcks: PendingOutputAck[] = [];
  private state: JobTerminalTransportState = 'idle';
  private socket: TerminalWebSocketPort | null = null;
  private socketListeners: TerminalSocketListeners | null = null;
  private inputPump: TerminalInputPump | null = null;
  private generation = 0;
  private initialized = false;
  private inputEnabled = false;
  private serverPaused = false;
  private pendingOutputBytes = 0;
  private heartbeatWatchdogTimer: unknown = null;
  private heartbeatWatchdogToken = 0;
  private closeGraceTimer: unknown = null;
  private closeGraceToken = 0;
  private terminalCloseSent = false;

  constructor(options: JobTerminalTransportOptions) {
    this.sessionId = options.sessionId;
    this.ticket = options.ticket;
    this.capturedAccessToken = options.accessToken;
    this.location = options.location ?? globalThis.location;
    this.webSocketFactory = options.webSocketFactory ?? createBrowserSocket;
    this.scheduler = options.scheduler ?? {
      setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
      clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    this.getAccessToken = options.getAccessToken ?? (() => options.accessToken);
    this.onUnauthorized = options.onUnauthorized;
    this.onStateChange = options.onStateChange;
    this.onInputEnabledChange = options.onInputEnabledChange;
    this.onReady = options.onReady;
    this.onOutput = options.onOutput;
    this.onClosed = options.onClosed;
  }

  get currentState(): JobTerminalTransportState {
    return this.state;
  }

  connect(): void {
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'disposed') return;
    if (this.state !== 'idle') {
      this.failProtocol();
      return;
    }
    let url: string;
    try {
      url = buildJobTerminalWebSocketUrl(this.location, this.ticket);
    } catch {
      this.finish({ kind: 'protocol-error' });
      return;
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.transition('connecting');
    if (!this.isConnectingGeneration(generation)) return;
    let socket: TerminalWebSocketPort | null = null;
    try {
      socket = this.webSocketFactory(url);
      socket.binaryType = 'arraybuffer';
    } catch {
      if (socket !== null) this.closeUnownedSocket(socket);
      this.finish({ kind: 'connection-error' });
      return;
    }
    if (!this.isConnectingGeneration(generation)) {
      this.closeUnownedSocket(socket);
      return;
    }
    const listeners: TerminalSocketListeners = {
      open: () => this.handleOpen(generation, socket),
      message: (event) => this.handleMessage(generation, socket, event),
      error: () => this.handleError(generation, socket),
      close: (event) => this.handleClose(generation, socket, event),
    };
    if (!this.isConnectingGeneration(generation)) {
      this.closeUnownedSocket(socket);
      return;
    }
    this.socket = socket;
    this.socketListeners = listeners;
    try {
      socket.addEventListener('open', listeners.open);
      socket.addEventListener('message', listeners.message);
      socket.addEventListener('error', listeners.error);
      socket.addEventListener('close', listeners.close);
    } catch {
      this.finish({ kind: 'connection-error' });
    }
  }

  initialize(cols: number, rows: number): boolean {
    if (this.state !== 'ready' || this.initialized || this.socket?.readyState !== SOCKET_OPEN) {
      this.failProtocol();
      return false;
    }
    const generation = this.generation;
    const socket = this.socket;
    this.initialized = true;
    this.serverPaused = false;
    this.inputPump = new TerminalInputPump({
      socket,
      scheduler: this.scheduler,
      onPauseChange: (paused) => {
        if (this.isCurrent(generation, socket)) this.setInputEnabled(!paused);
      },
      onOverflow: () => this.finishCurrent(generation, socket, { kind: 'input-overflow' }),
      onSendError: () => this.finishCurrent(generation, socket, { kind: 'connection-error' }),
    });
    if (
      !this.sendControl({ type: 'terminal.resize', cols, rows }) ||
      !this.sendControl({
        type: 'terminal.output.credit',
        bytes: MAX_TERMINAL_OUTPUT_CREDIT_BYTES,
      })
    ) {
      return false;
    }
    this.setInputEnabled(true);
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (this.state !== 'ready' || !this.initialized) {
      this.failProtocol();
      return false;
    }
    return this.sendControl({ type: 'terminal.resize', cols, rows });
  }

  sendData(data: string): boolean {
    if (this.state !== 'ready' || !this.initialized || this.inputPump === null) {
      this.failProtocol();
      return false;
    }
    return this.inputPump.enqueueData(data);
  }

  sendBinary(data: string): boolean {
    if (this.state !== 'ready' || !this.initialized || this.inputPump === null) {
      this.failProtocol();
      return false;
    }
    return this.inputPump.enqueueBinary(data);
  }

  close(): void {
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'disposed') return;
    this.beginUserClose();
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.commitTeardown('disposed', true, 1000, false);
    notifySafely(this.onStateChange, 'disposed');
  }

  private handleOpen(generation: number, socket: TerminalWebSocketPort): void {
    if (!this.isCurrent(generation, socket)) return;
    if (this.state === 'closing') {
      this.sendTerminalCloseOnce(generation, socket);
      return;
    }
    if (this.state !== 'connecting') return;
    this.transition('awaiting-ready');
  }

  private handleMessage(
    generation: number,
    socket: TerminalWebSocketPort,
    event: TerminalWebSocketEvent,
  ): void {
    if (!this.isCurrent(generation, socket)) return;
    if (this.state === 'closing') {
      this.handleClosingMessage(event);
      return;
    }
    if (this.state === 'awaiting-ready') {
      if (typeof event.data !== 'string') {
        this.failProtocol();
        return;
      }
      try {
        const control = parseTerminalServerControlJson(event.data, this.sessionId);
        if (control.type !== 'terminal.ready') throw new Error('Invalid terminal frame');
      } catch {
        this.failProtocol();
        return;
      }
      this.transition('ready');
      if (!this.isReadyGeneration(generation, socket)) return;
      if (!this.restartHeartbeatWatchdog(generation, socket)) return;
      if (!this.isReadyGeneration(generation, socket)) return;
      notifySafely(this.onReady);
      return;
    }
    if (this.state !== 'ready') {
      this.failProtocol();
      return;
    }
    if (typeof event.data !== 'string') {
      this.handleOutput(generation, socket, event.data);
      return;
    }
    let control;
    try {
      control = parseTerminalServerControlJson(event.data, this.sessionId);
    } catch {
      this.failProtocol();
      return;
    }
    if (control.type === 'terminal.ready') {
      this.failProtocol();
      return;
    }
    if (control.type === 'terminal.input.pause') {
      if (!this.initialized || this.inputPump === null || this.serverPaused) {
        this.failProtocol();
      } else {
        this.serverPaused = true;
        this.inputPump.setServerPaused(true);
      }
      return;
    }
    if (control.type === 'terminal.input.resume') {
      if (!this.initialized || this.inputPump === null || !this.serverPaused) {
        this.failProtocol();
      } else {
        this.serverPaused = false;
        this.inputPump.setServerPaused(false);
      }
      return;
    }
    if (control.type === 'terminal.ping') {
      if (!this.initialized) this.failProtocol();
      else if (this.sendControl({ type: 'terminal.pong', nonce: control.nonce })) {
        this.restartHeartbeatWatchdog(generation, socket);
      }
      return;
    }
    if (control.type === 'terminal.exit') {
      this.finish({
        kind: 'server-exit',
        exitCode: control.exitCode,
        reason: control.reason,
      });
      return;
    }
    this.finish({ kind: 'server-error', code: control.code });
  }

  private handleOutput(
    generation: number,
    socket: TerminalWebSocketPort,
    value: unknown,
  ): void {
    if (!this.initialized || this.onOutput === undefined) {
      this.failProtocol();
      return;
    }
    try {
      validateTerminalBinaryFrame(value);
    } catch {
      this.failProtocol();
      return;
    }
    const buffer = value as ArrayBuffer;
    if (
      buffer.byteLength === 0 ||
      this.pendingOutputBytes + buffer.byteLength > MAX_TERMINAL_OUTPUT_CREDIT_BYTES
    ) {
      this.failProtocol();
      return;
    }
    const pending: PendingOutputAck = {
      generation,
      socket,
      byteLength: buffer.byteLength,
      acknowledged: false,
    };
    this.pendingOutputAcks.push(pending);
    this.pendingOutputBytes += pending.byteLength;
    try {
      this.onOutput({
        data: new Uint8Array(buffer.slice(0)),
        byteLength: buffer.byteLength,
        ack: (bytes) => this.acknowledgeOutput(pending, bytes),
      });
    } catch {
      this.failProtocol();
    }
  }

  private acknowledgeOutput(pending: PendingOutputAck, bytes: number): boolean {
    if (!this.isCurrent(pending.generation, pending.socket)) return false;
    if (
      this.state !== 'ready' ||
      !this.initialized ||
      pending.acknowledged ||
      this.pendingOutputAcks[0] !== pending ||
      bytes !== pending.byteLength
    ) {
      this.failProtocol();
      return false;
    }
    pending.acknowledged = true;
    this.pendingOutputAcks.shift();
    this.pendingOutputBytes -= pending.byteLength;
    return (
      this.sendControl({ type: 'terminal.output.ack', bytes }) &&
      this.sendControl({ type: 'terminal.output.credit', bytes })
    );
  }

  private handleError(generation: number, socket: TerminalWebSocketPort): void {
    this.finishCurrent(
      generation,
      socket,
      this.state === 'closing' ? { kind: 'client-close' } : { kind: 'connection-error' },
    );
  }

  private handleClose(
    generation: number,
    socket: TerminalWebSocketPort,
    event: TerminalWebSocketEvent,
  ): void {
    if (!this.isCurrent(generation, socket)) return;
    if (this.state === 'closing') {
      this.finish(
        { kind: 'client-close' },
        false,
        1000,
        event.code === 4401,
      );
      return;
    }
    this.finish(
      { kind: 'socket-close', code: event.code ?? 1006 },
      false,
      1000,
      event.code === 4401,
    );
  }

  private handleClosingMessage(event: TerminalWebSocketEvent): void {
    if (typeof event.data !== 'string') return;
    try {
      const control = parseTerminalServerControlJson(event.data, this.sessionId);
      if (control.type === 'terminal.exit') this.finish({ kind: 'client-close' });
    } catch {
      // User-close grace ignores late frames and still forces closure at its deadline.
    }
  }

  private sendControl(control: TerminalClientControl): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      this.finish({ kind: 'connection-error' });
      return false;
    }
    try {
      const exact = parseTerminalClientControl(control);
      socket.send(JSON.stringify(exact));
      return true;
    } catch {
      this.failProtocol();
      return false;
    }
  }

  private failProtocol(): void {
    this.finish({ kind: 'protocol-error' }, true, JOB_TERMINAL_PROTOCOL_CLOSE_CODE);
  }

  private beginUserClose(): void {
    const socket = this.socket;
    if (socket === null) {
      this.finish({ kind: 'client-close' });
      return;
    }
    const generation = this.generation;
    const notifyInputDisabled = this.inputEnabled;
    const inputPump = this.inputPump;
    this.state = 'closing';
    this.initialized = false;
    this.serverPaused = false;
    this.pendingOutputAcks.length = 0;
    this.pendingOutputBytes = 0;
    this.inputEnabled = false;
    this.inputPump = null;
    this.clearHeartbeatWatchdog();
    if (notifyInputDisabled) notifySafely(this.onInputEnabledChange, false);
    try {
      inputPump?.dispose();
    } catch {
      // The close control and grace deadline remain authoritative.
    }
    if (!this.sendTerminalCloseOnce(generation, socket)) return;
    if (!this.startCloseGrace(generation, socket)) return;
    if (this.isCurrent(generation, socket) && this.state === 'closing') {
      notifySafely(this.onStateChange, 'closing');
    }
  }

  private sendTerminalCloseOnce(
    generation: number,
    socket: TerminalWebSocketPort,
  ): boolean {
    if (!this.isCurrent(generation, socket) || this.state !== 'closing') return false;
    if (this.terminalCloseSent) return true;
    if (socket.readyState === SOCKET_CONNECTING) return true;
    if (socket.readyState !== SOCKET_OPEN) {
      this.finish({ kind: 'client-close' }, false);
      return false;
    }
    this.terminalCloseSent = true;
    try {
      socket.send(JSON.stringify(parseTerminalClientControl({ type: 'terminal.close' })));
      return true;
    } catch {
      this.finish({ kind: 'client-close' });
      return false;
    }
  }

  private startCloseGrace(
    generation: number,
    socket: TerminalWebSocketPort,
  ): boolean {
    this.clearCloseGrace();
    const token = this.closeGraceToken;
    let timer: unknown;
    try {
      timer = this.scheduler.setTimeout(() => {
        if (
          token !== this.closeGraceToken ||
          !this.isCurrent(generation, socket) ||
          this.state !== 'closing'
        ) {
          return;
        }
        this.closeGraceTimer = null;
        this.closeGraceToken += 1;
        this.finish({ kind: 'client-close' });
      }, JOB_TERMINAL_CLOSE_GRACE_MS);
    } catch {
      this.finishCurrent(generation, socket, { kind: 'client-close' });
      return false;
    }
    if (
      token !== this.closeGraceToken ||
      !this.isCurrent(generation, socket) ||
      this.state !== 'closing'
    ) {
      try {
        this.scheduler.clearTimeout(timer);
      } catch {
        // A stale grace callback remains inert through token and generation checks.
      }
      return false;
    }
    this.closeGraceTimer = timer;
    return true;
  }

  private clearCloseGrace(): void {
    this.closeGraceToken += 1;
    if (this.closeGraceTimer === null) return;
    const timer = this.closeGraceTimer;
    this.closeGraceTimer = null;
    try {
      this.scheduler.clearTimeout(timer);
    } catch {
      // Token and generation checks still invalidate a timer the scheduler cannot clear.
    }
  }

  private restartHeartbeatWatchdog(
    generation: number,
    socket: TerminalWebSocketPort,
  ): boolean {
    this.clearHeartbeatWatchdog();
    const token = this.heartbeatWatchdogToken;
    let timer: unknown;
    try {
      timer = this.scheduler.setTimeout(() => {
        if (
          token !== this.heartbeatWatchdogToken ||
          !this.isCurrent(generation, socket)
        ) {
          return;
        }
        this.heartbeatWatchdogTimer = null;
        this.heartbeatWatchdogToken += 1;
        this.finish({ kind: 'connection-error' });
      }, JOB_TERMINAL_HEARTBEAT_WATCHDOG_MS);
    } catch {
      this.finishCurrent(generation, socket, { kind: 'connection-error' });
      return false;
    }
    if (token !== this.heartbeatWatchdogToken || !this.isCurrent(generation, socket)) {
      try {
        this.scheduler.clearTimeout(timer);
      } catch {
        // A stale watchdog callback remains inert through its token and generation checks.
      }
      return false;
    }
    this.heartbeatWatchdogTimer = timer;
    return true;
  }

  private clearHeartbeatWatchdog(): void {
    this.heartbeatWatchdogToken += 1;
    if (this.heartbeatWatchdogTimer === null) return;
    const timer = this.heartbeatWatchdogTimer;
    this.heartbeatWatchdogTimer = null;
    try {
      this.scheduler.clearTimeout(timer);
    } catch {
      // Token and generation checks still invalidate a timer the scheduler cannot clear.
    }
  }

  private finishCurrent(
    generation: number,
    socket: TerminalWebSocketPort,
    reason: JobTerminalClosedReason,
  ): void {
    if (this.isCurrent(generation, socket)) this.finish(reason);
  }

  private finish(
    reason: JobTerminalClosedReason,
    closeSocket = true,
    closeCode = 1000,
    checkUnauthorized = false,
    sendTerminalClose = false,
  ): void {
    if (this.state === 'closed' || this.state === 'disposed') return;
    this.commitTeardown('closed', closeSocket, closeCode, sendTerminalClose);
    if (checkUnauthorized) this.notifyUnauthorizedIfCurrent();
    notifySafely(this.onStateChange, 'closed');
    notifySafely(this.onClosed, reason);
  }

  private commitTeardown(
    state: Extract<JobTerminalTransportState, 'closed' | 'disposed'>,
    closeSocket: boolean,
    closeCode: number,
    sendTerminalClose: boolean,
  ): void {
    const notifyInputDisabled = this.inputEnabled;
    const inputPump = this.inputPump;
    const socket = this.socket;
    this.generation += 1;
    this.clearHeartbeatWatchdog();
    this.clearCloseGrace();
    this.initialized = false;
    this.serverPaused = false;
    this.terminalCloseSent = false;
    this.pendingOutputAcks.length = 0;
    this.pendingOutputBytes = 0;
    this.inputEnabled = false;
    this.inputPump = null;
    this.socket = null;
    this.state = state;
    if (notifyInputDisabled) notifySafely(this.onInputEnabledChange, false);
    try {
      inputPump?.dispose();
    } catch {
      // Remaining resources still close when the pump rejects disposal.
    }
    if (sendTerminalClose && socket?.readyState === SOCKET_OPEN) {
      try {
        socket.send(JSON.stringify(parseTerminalClientControl({ type: 'terminal.close' })));
      } catch {
        // Socket closure remains authoritative when the final control send fails.
      }
    }
    if (
      closeSocket &&
      socket !== null &&
      (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)
    ) {
      try {
        socket.close(closeCode);
      } catch {
        // Local state is already terminal even when the browser rejects close().
      }
    }
    this.removeSocketListeners(socket);
  }

  private removeSocketListeners(socket: TerminalWebSocketPort | null): void {
    const listeners = this.socketListeners;
    this.socketListeners = null;
    if (socket === null || listeners === null) return;
    for (const [type, listener] of [
      ['open', listeners.open],
      ['message', listeners.message],
      ['error', listeners.error],
      ['close', listeners.close],
    ] as const) {
      try {
        socket.removeEventListener(type, listener);
      } catch {
        // One browser listener cannot retain the other generation observers.
      }
    }
  }

  private notifyUnauthorizedIfCurrent(): void {
    let currentToken: string | null;
    try {
      currentToken = this.getAccessToken();
    } catch {
      return;
    }
    if (this.capturedAccessToken === currentToken) {
      notifySafely(this.onUnauthorized);
    }
  }

  private isReadyGeneration(generation: number, socket: TerminalWebSocketPort): boolean {
    return this.state === 'ready' && this.isCurrent(generation, socket);
  }

  private isCurrent(generation: number, socket: TerminalWebSocketPort): boolean {
    return generation === this.generation && socket === this.socket;
  }

  private isConnectingGeneration(generation: number): boolean {
    return generation === this.generation && this.state === 'connecting';
  }

  private closeUnownedSocket(socket: TerminalWebSocketPort): void {
    try {
      socket.close(1000);
    } catch {
      // The socket is not transport-owned, so local terminal state is already authoritative.
    }
  }

  private setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;
    this.inputEnabled = enabled;
    notifySafely(this.onInputEnabledChange, enabled);
  }

  private transition(state: JobTerminalTransportState): void {
    if (this.state === state) return;
    this.state = state;
    notifySafely(this.onStateChange, state);
  }
}
