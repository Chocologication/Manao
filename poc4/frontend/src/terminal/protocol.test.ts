import { describe, expect, it } from 'vitest';
import { decodeServerControl, encodeClientControl, encodeTerminalInput } from './protocol';

describe('terminal protocol', () => {
  it('encodes input as binary and control as JSON text', () => {
    expect(encodeTerminalInput('mvn test')).toBeInstanceOf(Uint8Array);
    expect(encodeClientControl({ type: 'terminal.resize', cols: 120, rows: 32 })).toBe(
      '{"type":"terminal.resize","cols":120,"rows":32}'
    );
  });

  it('accepts only known server controls', () => {
    expect(decodeServerControl('{"type":"terminal.ready","sessionId":"spike-1"}')).toEqual({
      type: 'terminal.ready',
      sessionId: 'spike-1',
    });
    expect(() => decodeServerControl('{"type":"unknown"}')).toThrow('Unknown terminal control');
  });
});
