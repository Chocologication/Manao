import { parseIsoTimestamp } from './run';

declare const terminalSessionIdBrand: unique symbol;
declare const terminalTicketBrand: unique symbol;
declare const terminalAuditIdBrand: unique symbol;

export type TerminalSessionId = string & { readonly [terminalSessionIdBrand]: true };
export type TerminalTicket = string & { readonly [terminalTicketBrand]: true };
export type TerminalAuditId = string & { readonly [terminalAuditIdBrand]: true };

export type CreateTerminalSessionRequest = { cols: number; rows: number };
export type CreateTerminalSessionResponse = { sessionId: TerminalSessionId; ticket: TerminalTicket; expiresAt: string };
export type TerminalAuditState = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
export type TerminalAuditEntry = { id: TerminalAuditId; sessionId: TerminalSessionId; command: string; state: TerminalAuditState; startedAt: string; finishedAt: string | null; exitCode: number | null };
export type TerminalAuditListResponse = { items: TerminalAuditEntry[]; nextCursor: string | null };
export type TerminalClientControl =
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.close' }
  | { type: 'terminal.output.credit'; bytes: number }
  | { type: 'terminal.output.ack'; bytes: number }
  | { type: 'terminal.pong'; nonce: string };
export type TerminalServerControl =
  | { type: 'terminal.ready'; sessionId: TerminalSessionId }
  | { type: 'terminal.input.pause' }
  | { type: 'terminal.input.resume' }
  | { type: 'terminal.ping'; nonce: string }
  | { type: 'terminal.exit'; exitCode: number | null; reason: TerminalExitReason }
  | { type: 'terminal.error'; code: TerminalErrorCode; retryable: false };
export type TerminalExitReason = 'SHELL_EXITED' | 'RUN_LEFT_RUNNING' | 'CLIENT_CLOSED' | 'CONNECTION_LOST' | 'BACKEND_ERROR';
export type TerminalErrorCode = 'PROTOCOL_ERROR' | 'SESSION_NOT_AVAILABLE' | 'INPUT_OVERFLOW' | 'OUTPUT_FLOW_TIMEOUT' | 'PTY_EXEC_FAILED';

export const MAX_TERMINAL_CONTROL_FRAME_BYTES = 8 * 1024;
export const MAX_TERMINAL_BINARY_FRAME_BYTES = 32 * 1024;
export const MAX_TERMINAL_OUTPUT_CREDIT_BYTES = 256 * 1024;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_NONCE_LENGTH = 256;
const encoder = new TextEncoder();

function invalidResponse(): never { throw new Error('Invalid terminal response'); }
function invalidFrame(): never { throw new Error('Invalid terminal frame'); }
function asRecord(value: unknown, invalid: () => never): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function requireKeys(record: Record<string, unknown>, keys: readonly string[], invalid: () => never): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
}
function parseOpaque(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_OPAQUE_ID_LENGTH) invalidResponse();
  return value;
}
function parseDimension(value: unknown, min: number, max: number, invalid: () => never): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function parseResponseIso(value: unknown): string {
  try { return parseIsoTimestamp(value); } catch { return invalidResponse(); }
}
function parseFrameOpaque(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NONCE_LENGTH) invalidFrame();
  return value;
}
function parseFrameSessionId(value: unknown): TerminalSessionId {
  if (typeof value !== 'string' || value === '' || value.length > MAX_OPAQUE_ID_LENGTH) invalidFrame();
  return value as TerminalSessionId;
}

export function parseTerminalSessionId(value: unknown): TerminalSessionId { return parseOpaque(value) as TerminalSessionId; }
export function parseTerminalTicket(value: unknown): TerminalTicket { return parseOpaque(value) as TerminalTicket; }
export function parseTerminalAuditId(value: unknown): TerminalAuditId { return parseOpaque(value) as TerminalAuditId; }
export function parseCreateTerminalSessionRequest(value: unknown): CreateTerminalSessionRequest {
  const record = asRecord(value, invalidResponse);
  requireKeys(record, ['cols', 'rows'], invalidResponse);
  return { cols: parseDimension(record.cols, 2, 500, invalidResponse), rows: parseDimension(record.rows, 1, 200, invalidResponse) };
}
export function parseCreateTerminalSessionResponse(value: unknown, now = new Date()): CreateTerminalSessionResponse {
  const record = asRecord(value, invalidResponse);
  requireKeys(record, ['sessionId', 'ticket', 'expiresAt'], invalidResponse);
  const expiresAt = parseResponseIso(record.expiresAt);
  if (Date.parse(expiresAt) <= now.getTime()) invalidResponse();
  return { sessionId: parseTerminalSessionId(record.sessionId), ticket: parseTerminalTicket(record.ticket), expiresAt };
}
function parseAuditState(value: unknown): TerminalAuditState {
  if (value === 'RUNNING' || value === 'SUCCEEDED' || value === 'FAILED' || value === 'INTERRUPTED') return value;
  return invalidResponse();
}
function parseNullableExit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidResponse();
  return value;
}
function parseAudit(value: unknown): TerminalAuditEntry {
  const record = asRecord(value, invalidResponse);
  requireKeys(record, ['id', 'sessionId', 'command', 'state', 'startedAt', 'finishedAt', 'exitCode'], invalidResponse);
  if (typeof record.command !== 'string' || record.command === '' || record.command.length > 4096 || /[\u0000-\u001f\u007f]/.test(record.command)) invalidResponse();
  const state = parseAuditState(record.state);
  const startedAt = parseResponseIso(record.startedAt);
  const finishedAt = record.finishedAt === null ? null : parseResponseIso(record.finishedAt);
  const exitCode = parseNullableExit(record.exitCode);
  if (state === 'RUNNING' && (finishedAt !== null || exitCode !== null)) invalidResponse();
  if (state !== 'RUNNING' && (finishedAt === null || Date.parse(finishedAt) < Date.parse(startedAt))) invalidResponse();
  if (state === 'SUCCEEDED' && exitCode !== 0) invalidResponse();
  if (state === 'FAILED' && exitCode === null) invalidResponse();
  return { id: parseTerminalAuditId(record.id), sessionId: parseTerminalSessionId(record.sessionId), command: record.command, state, startedAt, finishedAt, exitCode };
}
export function parseTerminalAuditListResponse(value: unknown): TerminalAuditListResponse {
  const record = asRecord(value, invalidResponse);
  requireKeys(record, ['items', 'nextCursor'], invalidResponse);
  if (!Array.isArray(record.items)) invalidResponse();
  const items = record.items.map(parseAudit);
  const seen = new Set<string>(); let previous: number | null = null;
  for (const item of items) { const time = Date.parse(item.startedAt); if (seen.has(item.id) || (previous !== null && previous < time)) invalidResponse(); seen.add(item.id); previous = time; }
  if (record.nextCursor !== null && (typeof record.nextCursor !== 'string' || record.nextCursor === '' || record.nextCursor.length > MAX_OPAQUE_ID_LENGTH)) invalidResponse();
  return { items, nextCursor: record.nextCursor };
}
function frameRecord(value: unknown): Record<string, unknown> { return asRecord(value, invalidFrame); }
function frameKeys(record: Record<string, unknown>, keys: readonly string[]): void { requireKeys(record, keys, invalidFrame); }
function frameBytes(value: unknown): number { return parseDimension(value, 1, MAX_TERMINAL_OUTPUT_CREDIT_BYTES, invalidFrame); }
export function parseTerminalClientControl(value: unknown): TerminalClientControl {
  const record = frameRecord(value);
  if (record.type === 'terminal.resize') { frameKeys(record, ['type', 'cols', 'rows']); return { type: record.type, cols: parseDimension(record.cols, 2, 500, invalidFrame), rows: parseDimension(record.rows, 1, 200, invalidFrame) }; }
  if (record.type === 'terminal.close') { frameKeys(record, ['type']); return { type: record.type }; }
  if (record.type === 'terminal.output.credit' || record.type === 'terminal.output.ack') { frameKeys(record, ['type', 'bytes']); return { type: record.type, bytes: frameBytes(record.bytes) }; }
  if (record.type === 'terminal.pong') { frameKeys(record, ['type', 'nonce']); return { type: record.type, nonce: parseFrameOpaque(record.nonce) }; }
  return invalidFrame();
}
export function parseTerminalServerControl(value: unknown, expectedSessionId: TerminalSessionId): TerminalServerControl {
  const record = frameRecord(value);
  if (record.type === 'terminal.ready') { frameKeys(record, ['type', 'sessionId']); const sessionId = parseFrameSessionId(record.sessionId); if (sessionId !== expectedSessionId) invalidFrame(); return { type: record.type, sessionId }; }
  if (record.type === 'terminal.input.pause' || record.type === 'terminal.input.resume') { frameKeys(record, ['type']); return { type: record.type }; }
  if (record.type === 'terminal.ping') { frameKeys(record, ['type', 'nonce']); return { type: record.type, nonce: parseFrameOpaque(record.nonce) }; }
  if (record.type === 'terminal.exit') { frameKeys(record, ['type', 'exitCode', 'reason']); if (!['SHELL_EXITED', 'RUN_LEFT_RUNNING', 'CLIENT_CLOSED', 'CONNECTION_LOST', 'BACKEND_ERROR'].includes(String(record.reason))) invalidFrame(); const exitCode = record.exitCode === null ? null : parseDimension(record.exitCode, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, invalidFrame); return { type: record.type, exitCode, reason: record.reason as TerminalExitReason }; }
  if (record.type === 'terminal.error') { frameKeys(record, ['type', 'code', 'retryable']); if (!['PROTOCOL_ERROR', 'SESSION_NOT_AVAILABLE', 'INPUT_OVERFLOW', 'OUTPUT_FLOW_TIMEOUT', 'PTY_EXEC_FAILED'].includes(String(record.code)) || record.retryable !== false) invalidFrame(); return { type: record.type, code: record.code as TerminalErrorCode, retryable: false }; }
  return invalidFrame();
}
export function parseTerminalServerControlJson(text: unknown, expectedSessionId: TerminalSessionId): TerminalServerControl {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_TERMINAL_CONTROL_FRAME_BYTES) invalidFrame();
  try { return parseTerminalServerControl(JSON.parse(text), expectedSessionId); } catch (error) { if (error instanceof Error && error.message === 'Invalid terminal frame') throw error; return invalidFrame(); }
}
export function validateTerminalBinaryFrame(value: unknown): void {
  if (!(value instanceof ArrayBuffer) || value.byteLength > MAX_TERMINAL_BINARY_FRAME_BYTES) invalidFrame();
}
