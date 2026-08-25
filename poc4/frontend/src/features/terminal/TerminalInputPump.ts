const textEncoder = new TextEncoder();

export function encodeTerminalData(data: string): Uint8Array {
  return textEncoder.encode(data);
}

export function encodeTerminalBinary(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export const TERMINAL_INPUT_FRAME_BYTES = 16 * 1024;
export const TERMINAL_INPUT_QUEUE_CAP_BYTES = 1024 * 1024;
export const TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES = 256 * 1024;
export const TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES = 64 * 1024;
const TERMINAL_INPUT_DRAIN_INTERVAL_MS = 50;
const SOCKET_OPEN = 1;

export type TerminalInputSocketPort = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: ArrayBuffer): void;
};

export type TerminalInputPumpScheduler = {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
};

export type TerminalInputPumpOptions = {
  socket: TerminalInputSocketPort;
  scheduler?: TerminalInputPumpScheduler;
  onPauseChange?: (paused: boolean) => void;
  onOverflow?: (attemptedBytes: number) => void;
  onSendError?: () => void;
};

const defaultScheduler: TerminalInputPumpScheduler = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class TerminalInputPump {
  private readonly socket: TerminalInputSocketPort;
  private readonly scheduler: TerminalInputPumpScheduler;
  private readonly onPauseChange: ((paused: boolean) => void) | undefined;
  private readonly onOverflow: ((attemptedBytes: number) => void) | undefined;
  private readonly onSendError: (() => void) | undefined;
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private serverPaused = false;
  private bufferPaused = false;
  private paused = false;
  private disposed = false;
  private drainTimer: unknown = null;

  constructor(options: TerminalInputPumpOptions) {
    this.socket = options.socket;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onPauseChange = options.onPauseChange;
    this.onOverflow = options.onOverflow;
    this.onSendError = options.onSendError;
  }

  get queuedByteLength(): number {
    return this.queuedBytes;
  }

  enqueueData(data: string): boolean {
    return this.enqueue(encodeTerminalData(data));
  }

  enqueueBinary(data: string): boolean {
    return this.enqueue(encodeTerminalBinary(data));
  }

  setServerPaused(paused: boolean): void {
    if (this.disposed || this.serverPaused === paused) return;
    this.serverPaused = paused;
    if (paused) {
      this.clearDrainTimer();
      this.setPaused(true);
      return;
    }
    this.bufferPaused = true;
    this.drain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.clearDrainTimer();
    this.setPaused(true);
  }

  private enqueue(bytes: Uint8Array): boolean {
    if (this.disposed) return false;
    if (bytes.byteLength === 0) return true;
    const attemptedBytes = this.queuedBytes + bytes.byteLength;
    if (attemptedBytes > TERMINAL_INPUT_QUEUE_CAP_BYTES) {
      this.dispose();
      this.onOverflow?.(attemptedBytes);
      return false;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_INPUT_FRAME_BYTES) {
      const frame = bytes.slice(offset, offset + TERMINAL_INPUT_FRAME_BYTES);
      this.queue.push(frame);
      this.queuedBytes += frame.byteLength;
    }
    this.drain();
    return !this.disposed;
  }

  private drain(): void {
    if (this.disposed) return;
    if (this.serverPaused) {
      this.setPaused(true);
      return;
    }
    if (this.socket.readyState !== SOCKET_OPEN) {
      this.setPaused(true);
      this.scheduleDrain();
      return;
    }
    if (this.bufferPaused) {
      if (this.socket.bufferedAmount >= TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES) {
        this.setPaused(true);
        this.scheduleDrain();
        return;
      }
      this.bufferPaused = false;
    }
    while (this.queue.length > 0) {
      if (this.socket.bufferedAmount >= TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES) {
        this.bufferPaused = true;
        this.setPaused(true);
        this.scheduleDrain();
        return;
      }
      const frame = this.queue.shift();
      if (frame === undefined) break;
      this.queuedBytes -= frame.byteLength;
      try {
        const payload = new ArrayBuffer(frame.byteLength);
        new Uint8Array(payload).set(frame);
        this.socket.send(payload);
      } catch {
        this.dispose();
        this.onSendError?.();
        return;
      }
    }
    if (this.socket.bufferedAmount >= TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES) {
      this.bufferPaused = true;
      this.setPaused(true);
      this.scheduleDrain();
      return;
    }
    this.setPaused(false);
  }

  private scheduleDrain(): void {
    if (this.disposed || this.serverPaused || this.drainTimer !== null) return;
    this.drainTimer = this.scheduler.setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, TERMINAL_INPUT_DRAIN_INTERVAL_MS);
  }

  private clearDrainTimer(): void {
    if (this.drainTimer === null) return;
    this.scheduler.clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.onPauseChange?.(paused);
  }
}
