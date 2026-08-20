import {
  decodeServerControl,
  encodeClientControl,
  encodeTerminalInput,
  type TerminalServerControl,
} from './protocol';
import type { TerminalTransport } from './TerminalSession';

export class WebSocketTerminalTransport implements TerminalTransport {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private closed = false;
  private readonly outputListeners = new Set<(data: Uint8Array) => void>();
  private readonly controlListeners = new Set<(control: TerminalServerControl) => void>();
  private readonly errorListeners = new Set<(event: Event) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.closed || this.socket) return;
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', (event) => this.handleError(event));
    socket.addEventListener('close', () => this.handleClose());
    this.socket = socket;
  }

  sendInput(data: string): void {
    if (!this.canSend()) return;
    this.socket!.send(encodeTerminalInput(data));
  }

  resize(cols: number, rows: number): void {
    if (!this.canSend()) return;
    this.socket!.send(encodeClientControl({ type: 'terminal.resize', cols, rows }));
  }

  onOutput(listener: (data: Uint8Array) => void): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  onControl(listener: (control: TerminalServerControl) => void): () => void {
    this.controlListeners.add(listener);
    return () => {
      this.controlListeners.delete(listener);
    };
  }

  onError(listener: (event: Event) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.outputListeners.clear();
    this.controlListeners.clear();
    this.errorListeners.clear();
    this.closeListeners.clear();
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeClientControl({ type: 'terminal.close' }));
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  private canSend(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  private handleMessage(event: MessageEvent): void {
    if (this.closed) return;
    if (typeof event.data === 'string') {
      try {
        const control = decodeServerControl(event.data);
        for (const listener of [...this.controlListeners]) listener(control);
      } catch {
        return;
      }
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      for (const listener of [...this.outputListeners]) listener(bytes);
    }
  }

  private handleError(event: Event): void {
    if (this.closed) return;
    for (const listener of [...this.errorListeners]) listener(event);
  }

  private handleClose(): void {
    if (this.closed) return;
    for (const listener of [...this.closeListeners]) listener();
  }
}
