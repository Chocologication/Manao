import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSession, type TerminalAdapter } from './TerminalSession';
import { WebSocketTerminalTransport } from './WebSocketTerminalTransport';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  binaryType = '';
  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close');
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(new Event(type));
    }
  }
}

let created: FakeWebSocket[] = [];

function createFakeTerminal(): TerminalAdapter {
  return {
    open: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    getSize: () => ({ cols: 80, rows: 24 }),
  };
}

describe('WebSocketTerminalTransport remote close', () => {
  beforeEach(() => {
    created = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disposes the terminal once when the remote socket closes', () => {
    const terminal = createFakeTerminal();
    const transport = new WebSocketTerminalTransport('ws://127.0.0.1:4174/terminal');
    const session = new TerminalSession(terminal, transport);
    transport.onClose(() => session.dispose());

    session.open(document.createElement('div'));
    const socket = created[0];
    expect(socket).toBeDefined();
    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch('close');

    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    session.dispose();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not treat local close as a remote disconnect', () => {
    const onClose = vi.fn();
    const transport = new WebSocketTerminalTransport('ws://127.0.0.1:4174/terminal');
    transport.onClose(onClose);
    transport.connect();
    transport.close();
    transport.close();

    expect(onClose).not.toHaveBeenCalled();
  });
});
