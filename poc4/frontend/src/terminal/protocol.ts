export type TerminalClientControl =
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.close' };

export type TerminalServerControl =
  | { type: 'terminal.ready'; sessionId: string }
  | { type: 'terminal.exit'; exitCode: number | null }
  | { type: 'terminal.error'; code: string };

const encoder = new TextEncoder();

export const encodeTerminalInput = (data: string): Uint8Array =>
  new Uint8Array(encoder.encode(data));
export const encodeClientControl = (control: TerminalClientControl): string =>
  JSON.stringify(control);

export function decodeServerControl(data: string): TerminalServerControl {
  const value = JSON.parse(data) as Record<string, unknown>;
  if (value.type === 'terminal.ready' && typeof value.sessionId === 'string') {
    return { type: 'terminal.ready', sessionId: value.sessionId };
  }
  if (value.type === 'terminal.exit' && (typeof value.exitCode === 'number' || value.exitCode === null)) {
    return { type: 'terminal.exit', exitCode: value.exitCode };
  }
  if (value.type === 'terminal.error' && typeof value.code === 'string') {
    return { type: 'terminal.error', code: value.code };
  }
  throw new Error('Unknown terminal control');
}
