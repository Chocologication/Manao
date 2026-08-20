export type Disposable = { dispose(): void };

export interface TerminalAdapter {
  open(container: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): Disposable;
  getSize(): { cols: number; rows: number };
  dispose(): void;
}

export interface TerminalTransport {
  connect(): void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(listener: (data: Uint8Array) => void): () => void;
  close(): void;
}

export class TerminalSession {
  private readonly terminal: TerminalAdapter;
  private readonly transport: TerminalTransport;
  private active = false;
  private disposed = false;
  private dataDisposable: Disposable | null = null;
  private unsubscribeOutput: (() => void) | null = null;

  constructor(terminal: TerminalAdapter, transport: TerminalTransport) {
    this.terminal = terminal;
    this.transport = transport;
  }

  open(container: HTMLElement): void {
    if (this.disposed || this.active) return;
    this.active = true;
    this.terminal.open(container);
    this.dataDisposable = this.terminal.onData((data) => {
      if (!this.active) return;
      this.transport.sendInput(data);
    });
    this.unsubscribeOutput = this.transport.onOutput((data) => {
      if (!this.active) return;
      this.terminal.write(data);
    });
    this.transport.connect();
  }

  resize(cols: number, rows: number): void {
    if (!this.active) return;
    this.transport.resize(cols, rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.dataDisposable?.dispose();
    this.dataDisposable = null;
    this.unsubscribeOutput?.();
    this.unsubscribeOutput = null;
    this.transport.close();
    this.terminal.dispose();
  }
}
