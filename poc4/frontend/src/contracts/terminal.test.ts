import { describe, expect, it } from 'vitest';
import {
  MAX_TERMINAL_BINARY_FRAME_BYTES,
  MAX_TERMINAL_CONTROL_FRAME_BYTES,
  parseCreateTerminalSessionRequest,
  parseCreateTerminalSessionResponse,
  parseTerminalAuditListResponse,
  parseTerminalClientControl,
  parseTerminalServerControl,
  parseTerminalServerControlJson,
  parseTerminalSessionId,
  validateTerminalBinaryFrame,
} from './terminal';

const STARTED_AT = '2026-08-25T10:00:00.000Z';
const FINISHED_AT = '2026-08-25T10:01:00.000Z';
const SESSION = 'session/opaque';

function audit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'audit-1', sessionId: SESSION, command: 'mvn test', state: 'RUNNING',
    startedAt: STARTED_AT, finishedAt: null, exitCode: null, ...overrides,
  };
}

describe('terminal HTTP contracts', () => {
  it('accepts opaque identifiers and exact session request and response keys', () => {
    expect(parseTerminalSessionId(' x/y ')).toBe(' x/y ');
    expect(parseCreateTerminalSessionRequest({ cols: 2, rows: 1 })).toEqual({ cols: 2, rows: 1 });
    expect(parseCreateTerminalSessionResponse({
      sessionId: SESSION, ticket: 'ticket/opaque', expiresAt: '2099-08-25T10:00:30.000Z',
    })).toEqual({ sessionId: SESSION, ticket: 'ticket/opaque', expiresAt: '2099-08-25T10:00:30.000Z' });
  });

  it.each([
    ['empty opaque id', () => parseTerminalSessionId('')],
    ['oversized opaque id', () => parseTerminalSessionId('x'.repeat(257))],
    ['extra request key', () => parseCreateTerminalSessionRequest({ cols: 80, rows: 24, command: 'sh' })],
    ['invalid cols', () => parseCreateTerminalSessionRequest({ cols: 1, rows: 24 })],
    ['invalid rows', () => parseCreateTerminalSessionRequest({ cols: 80, rows: 201 })],
    ['unsafe dimensions', () => parseCreateTerminalSessionRequest({ cols: Number.MAX_SAFE_INTEGER + 1, rows: 24 })],
    ['response url', () => parseCreateTerminalSessionResponse({ sessionId: SESSION, ticket: 't', expiresAt: STARTED_AT, url: '/ws' })],
    ['response path', () => parseCreateTerminalSessionResponse({ sessionId: SESSION, ticket: 't', expiresAt: STARTED_AT, path: '/ws' })],
    ['response host', () => parseCreateTerminalSessionResponse({ sessionId: SESSION, ticket: 't', expiresAt: STARTED_AT, host: 'x' })],
    ['expired ticket', () => parseCreateTerminalSessionResponse({ sessionId: SESSION, ticket: 't', expiresAt: '2020-01-01T00:00:00.000Z' }, new Date('2026-08-25T10:00:00.000Z'))],
  ])('rejects %s', (_label, parse) => expect(parse).toThrow('Invalid terminal response'));
});

describe('terminal audit contract', () => {
  it('accepts descending unique audits and opaque cursor', () => {
    const newer = audit({ id: 'audit-2', startedAt: '2026-08-25T11:00:00.000Z' });
    const older = audit({ id: 'audit-1', state: 'SUCCEEDED', startedAt: STARTED_AT, finishedAt: FINISHED_AT, exitCode: 0 });
    expect(parseTerminalAuditListResponse({ items: [newer, older], nextCursor: 'cursor/opaque' })).toEqual({ items: [newer, older], nextCursor: 'cursor/opaque' });
  });

  it.each([
    ['running finished', audit({ finishedAt: FINISHED_AT })],
    ['running exit', audit({ exitCode: 0 })],
    ['success nonzero', audit({ state: 'SUCCEEDED', finishedAt: FINISHED_AT, exitCode: 1 })],
    ['failure missing exit', audit({ state: 'FAILED', finishedAt: FINISHED_AT, exitCode: null })],
    ['interrupted before start', audit({ state: 'INTERRUPTED', finishedAt: '2026-08-25T09:00:00.000Z', exitCode: null })],
    ['control command', audit({ command: 'line\nnext' })],
    ['empty command', audit({ command: '' })],
    ['oversized command', audit({ command: 'x'.repeat(4097) })],
    ['unknown state', audit({ state: 'QUEUED' })],
  ])('rejects %s audit', (_label, value) => expect(() => parseTerminalAuditListResponse({ items: [value], nextCursor: null })).toThrow('Invalid terminal response'));

  it('rejects duplicate ids, ascending timestamps, and invalid cursors', () => {
    expect(() => parseTerminalAuditListResponse({ items: [audit(), audit()], nextCursor: null })).toThrow('Invalid terminal response');
    expect(() => parseTerminalAuditListResponse({ items: [audit(), audit({ id: 'audit-2', startedAt: '2026-08-25T11:00:00.000Z' })], nextCursor: null })).toThrow('Invalid terminal response');
    expect(() => parseTerminalAuditListResponse({ items: [], nextCursor: '' })).toThrow('Invalid terminal response');
  });
});

describe('terminal WebSocket controls', () => {
  it('parses every client and server control with exact keys', () => {
    expect(parseTerminalClientControl({ type: 'terminal.resize', cols: 80, rows: 24 })).toEqual({ type: 'terminal.resize', cols: 80, rows: 24 });
    expect(parseTerminalClientControl({ type: 'terminal.close' })).toEqual({ type: 'terminal.close' });
    expect(parseTerminalClientControl({ type: 'terminal.output.credit', bytes: 262144 })).toEqual({ type: 'terminal.output.credit', bytes: 262144 });
    expect(parseTerminalClientControl({ type: 'terminal.output.ack', bytes: 1 })).toEqual({ type: 'terminal.output.ack', bytes: 1 });
    expect(parseTerminalClientControl({ type: 'terminal.pong', nonce: 'n' })).toEqual({ type: 'terminal.pong', nonce: 'n' });
    expect(parseTerminalServerControl({ type: 'terminal.ready', sessionId: SESSION }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.ready', sessionId: SESSION });
    expect(parseTerminalServerControl({ type: 'terminal.input.pause' }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.input.pause' });
    expect(parseTerminalServerControl({ type: 'terminal.input.resume' }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.input.resume' });
    expect(parseTerminalServerControl({ type: 'terminal.ping', nonce: 'n' }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.ping', nonce: 'n' });
    expect(parseTerminalServerControl({ type: 'terminal.exit', exitCode: null, reason: 'CLIENT_CLOSED' }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.exit', exitCode: null, reason: 'CLIENT_CLOSED' });
    expect(parseTerminalServerControl({ type: 'terminal.error', code: 'PTY_EXEC_FAILED', retryable: false }, parseTerminalSessionId(SESSION))).toEqual({ type: 'terminal.error', code: 'PTY_EXEC_FAILED', retryable: false });
  });

  it.each([
    ['unknown client', () => parseTerminalClientControl({ type: 'terminal.open' })],
    ['extra client key', () => parseTerminalClientControl({ type: 'terminal.close', x: 1 })],
    ['invalid resize', () => parseTerminalClientControl({ type: 'terminal.resize', cols: 501, rows: 24 })],
    ['invalid credit', () => parseTerminalClientControl({ type: 'terminal.output.credit', bytes: 262145 })],
    ['empty nonce', () => parseTerminalClientControl({ type: 'terminal.pong', nonce: '' })],
    ['empty ready session', () => parseTerminalServerControl({ type: 'terminal.ready', sessionId: '' }, parseTerminalSessionId(SESSION))],
    ['oversized ready session', () => parseTerminalServerControl({ type: 'terminal.ready', sessionId: 'x'.repeat(257) }, parseTerminalSessionId(SESSION))],
    ['mismatched ready', () => parseTerminalServerControl({ type: 'terminal.ready', sessionId: 'other' }, parseTerminalSessionId(SESSION))],
    ['retryable server error', () => parseTerminalServerControl({ type: 'terminal.error', code: 'PTY_EXEC_FAILED', retryable: true }, parseTerminalSessionId(SESSION))],
    ['unknown server code', () => parseTerminalServerControl({ type: 'terminal.error', code: 'OTHER', retryable: false }, parseTerminalSessionId(SESSION))],
    ['invalid exit reason', () => parseTerminalServerControl({ type: 'terminal.exit', exitCode: 0, reason: 'OTHER' }, parseTerminalSessionId(SESSION))],
    ['oversized json', () => parseTerminalServerControlJson('x'.repeat(MAX_TERMINAL_CONTROL_FRAME_BYTES + 1), parseTerminalSessionId(SESSION))],
  ])('rejects %s', (_label, parse) => expect(parse).toThrow('Invalid terminal frame'));

  it('validates binary bytes independently from JSON controls', () => {
    expect(validateTerminalBinaryFrame(new ArrayBuffer(MAX_TERMINAL_BINARY_FRAME_BYTES))).toBeUndefined();
    expect(() => validateTerminalBinaryFrame(new ArrayBuffer(MAX_TERMINAL_BINARY_FRAME_BYTES + 1))).toThrow('Invalid terminal frame');
    expect(() => validateTerminalBinaryFrame('not-binary')).toThrow('Invalid terminal frame');
  });
});
