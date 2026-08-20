import { describe, expect, it, vi } from 'vitest';
import { TerminalSession, type TerminalAdapter, type TerminalTransport } from './TerminalSession';

function createFakeTerminal(): TerminalAdapter {
  return {
    open: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    getSize: () => ({ cols: 80, rows: 24 }),
  };
}

function createFakeTransport(): TerminalTransport & { emitOutput(data: Uint8Array): void } {
  let outputListener: ((data: Uint8Array) => void) | null = null;
  return {
    connect: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onOutput: vi.fn((listener) => {
      outputListener = listener;
      return () => { outputListener = null; };
    }),
    emitOutput: (data) => outputListener?.(data),
  };
}

describe('TerminalSession', () => {
  it('closes transport and disposes terminal exactly once', () => {
    const terminal = createFakeTerminal();
    const transport = createFakeTransport();
    const session = new TerminalSession(terminal, transport);

    session.open(document.createElement('div'));
    session.dispose();
    session.dispose();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not forward output after disposal', () => {
    const terminal = createFakeTerminal();
    const transport = createFakeTransport();
    const session = new TerminalSession(terminal, transport);
    session.open(document.createElement('div'));
    session.dispose();
    transport.emitOutput(new Uint8Array([65]));
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('forwards resize only while active', () => {
    const terminal = createFakeTerminal();
    const transport = createFakeTransport();
    const session = new TerminalSession(terminal, transport);
    session.open(document.createElement('div'));
    session.resize(120, 32);
    session.dispose();
    session.resize(140, 40);
    expect(transport.resize).toHaveBeenCalledTimes(1);
    expect(transport.resize).toHaveBeenCalledWith(120, 32);
  });
});
