import type { ApiErrorCode } from '../contracts/api';
import {
  parseCreateTerminalSessionRequest,
  parseTerminalAuditId,
  parseTerminalAuditListResponse,
  parseTerminalSessionId,
  parseTerminalTicket,
  type CreateTerminalSessionRequest,
  type CreateTerminalSessionResponse,
  type TerminalAuditEntry,
  type TerminalAuditListResponse,
  type TerminalAuditState,
  type TerminalExitReason,
  type TerminalSessionId,
  type TerminalTicket,
} from '../contracts/terminal';
import { getActiveRun, subscribeMockRunBeforeTransition } from './runState';
import { canReadReadyProjectFiles, registerTerminalStateReset } from './state';

export const MOCK_TERMINAL_TICKET_PREFIX = 'mock-terminal-ticket-';
export const MOCK_TERMINAL_SESSION_PREFIX = 'mock-terminal-session-';
export const MOCK_TERMINAL_AUDIT_PREFIX = 'mock-terminal-audit-';
export const MOCK_TERMINAL_PERSISTENCE_KEY = 'ensoai.mock.terminal-scenario.v1';
export const TERMINAL_TICKET_TTL_MS = 30_000;
export const TERMINAL_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type TerminalScenario =
  | 'normal'
  | 'ticket-expired'
  | 'already-active'
  | 'server-pause'
  | 'disconnect'
  | 'shell-exit'
  | 'webgl-fallback'
  | 'audit'
  | 'stress';

const TERMINAL_SCENARIOS: ReadonlySet<TerminalScenario> = new Set([
  'normal',
  'ticket-expired',
  'already-active',
  'server-pause',
  'disconnect',
  'shell-exit',
  'webgl-fallback',
  'audit',
  'stress',
]);

export type MockTerminalErrorCode = Extract<
  ApiErrorCode,
  | 'VALIDATION_ERROR'
  | 'TERMINAL_NOT_AVAILABLE'
  | 'TERMINAL_SESSION_ALREADY_ACTIVE'
  | 'TERMINAL_TICKET_NOT_AVAILABLE'
>;

export type MockTerminalMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MockTerminalErrorCode };

type TerminalReservation = {
  userId: string;
  projectId: string;
  runId: string;
  sessionId: TerminalSessionId;
  ticket: TerminalTicket;
  expiresAtMs: number;
  dimensions: CreateTerminalSessionRequest;
  used: boolean;
};

export type MockLiveTerminalSession = {
  userId: string;
  projectId: string;
  runId: string;
  sessionId: TerminalSessionId;
  cols: number;
  rows: number;
  state: 'live';
};

export type ConsumeTerminalTicketInput = {
  userId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  ticket: string;
};

export type EndTerminalSessionInput = {
  userId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  reason: TerminalExitReason;
  exitCode: number | null;
};

export type MockEndedTerminalSession = Omit<MockLiveTerminalSession, 'state'> & {
  state: 'closed' | 'interrupted';
  reason: TerminalExitReason;
  exitCode: number | null;
};

export type MockTerminalStateEvent =
  | {
      type: 'reservation.invalidated';
      userId: string;
      projectId: string;
      runId: string;
      sessionId: TerminalSessionId;
    }
  | { type: 'session.ended'; session: MockEndedTerminalSession };

type TerminalAuditRecord = {
  seq: number;
  userId: string;
  projectId: string;
  runId: string;
  entry: TerminalAuditEntry;
};

export type ListTerminalAuditOptions = {
  limit?: number;
  cursor?: string | null;
  sessionId?: string;
};

let nextReservationSeq = 0;
let reservations = new Map<string, TerminalReservation>();
let liveSessions = new Map<string, MockLiveTerminalSession>();
let nextAuditSeq = 0;
let auditRecords: TerminalAuditRecord[] = [];
let terminalScenario: TerminalScenario = 'normal';
const terminalStateSubscribers = new Set<(event: MockTerminalStateEvent) => void>();

function terminalStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function isTerminalScenario(value: unknown): value is TerminalScenario {
  return typeof value === 'string' && TERMINAL_SCENARIOS.has(value as TerminalScenario);
}

export function setTerminalScenario(scenario: TerminalScenario): void {
  terminalScenario = scenario;
  terminalStorage()?.setItem(
    MOCK_TERMINAL_PERSISTENCE_KEY,
    JSON.stringify({ version: 1, scenario }),
  );
}

export function getTerminalScenario(): TerminalScenario {
  return terminalScenario;
}

function liveSessionKey(userId: string, projectId: string, runId: string): string {
  return `${userId}\0${projectId}\0${runId}`;
}

function hasRunningAuthority(userId: string, projectId: string, runId: string): boolean {
  const activeRun = getActiveRun(projectId);
  return (
    canReadReadyProjectFiles(userId, projectId) &&
    activeRun !== null &&
    activeRun.id === runId &&
    activeRun.state === 'RUNNING'
  );
}

function emitTerminalStateEvent(event: MockTerminalStateEvent): void {
  for (const listener of terminalStateSubscribers) {
    listener(event);
  }
}

function invalidateUnusedReservations(
  matches: (reservation: TerminalReservation) => boolean,
): void {
  for (const [ticket, reservation] of reservations) {
    if (!reservation.used && matches(reservation)) {
      reservations.delete(ticket);
      emitTerminalStateEvent({
        type: 'reservation.invalidated',
        userId: reservation.userId,
        projectId: reservation.projectId,
        runId: reservation.runId,
        sessionId: reservation.sessionId,
      });
    }
  }
}

function appendAuditRecord(
  userId: string,
  projectId: string,
  runId: string,
  entry: Omit<TerminalAuditEntry, 'id'>,
): TerminalAuditEntry {
  nextAuditSeq += 1;
  const parsed = parseTerminalAuditListResponse({
    items: [{ ...entry, id: parseTerminalAuditId(`${MOCK_TERMINAL_AUDIT_PREFIX}${nextAuditSeq}`) }],
    nextCursor: null,
  }).items[0];
  if (parsed === undefined) {
    throw new Error('Invalid mock terminal audit fixture');
  }
  auditRecords.push({ seq: nextAuditSeq, userId, projectId, runId, entry: parsed });
  return parsed;
}

function settleAuditForSession(session: MockEndedTerminalSession): void {
  const record = auditRecords.find(
    (candidate) =>
      candidate.userId === session.userId &&
      candidate.projectId === session.projectId &&
      candidate.runId === session.runId &&
      candidate.entry.sessionId === session.sessionId &&
      candidate.entry.state === 'RUNNING',
  );
  if (record === undefined) return;
  let state: TerminalAuditState;
  let exitCode: number | null;
  if (session.reason === 'SHELL_EXITED' && session.exitCode === 0) {
    state = 'SUCCEEDED';
    exitCode = 0;
  } else if (session.reason === 'SHELL_EXITED' || session.reason === 'BACKEND_ERROR') {
    state = 'FAILED';
    exitCode = session.exitCode ?? 1;
  } else {
    state = 'INTERRUPTED';
    exitCode = null;
  }
  const parsed = parseTerminalAuditListResponse({
    items: [{
      ...record.entry,
      state,
      finishedAt: new Date(Date.now()).toISOString(),
      exitCode,
    }],
    nextCursor: null,
  }).items[0];
  if (parsed !== undefined) record.entry = parsed;
}

export function issueTerminalReservation(
  userId: string,
  projectId: string,
  runId: string,
  body: unknown,
): MockTerminalMutationResult<CreateTerminalSessionResponse> {
  let dimensions: CreateTerminalSessionRequest;
  try {
    dimensions = parseCreateTerminalSessionRequest(body);
  } catch {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
  if (!hasRunningAuthority(userId, projectId, runId)) {
    return { ok: false, code: 'TERMINAL_NOT_AVAILABLE' };
  }
  if (liveSessions.has(liveSessionKey(userId, projectId, runId))) {
    return { ok: false, code: 'TERMINAL_SESSION_ALREADY_ACTIVE' };
  }
  nextReservationSeq += 1;
  const suffix = String(nextReservationSeq);
  const sessionId = parseTerminalSessionId(`${MOCK_TERMINAL_SESSION_PREFIX}${suffix}`);
  const ticket = parseTerminalTicket(`${MOCK_TERMINAL_TICKET_PREFIX}${suffix}`);
  const expiresAtMs = Date.now() + TERMINAL_TICKET_TTL_MS;
  reservations.set(ticket, {
    userId,
    projectId,
    runId,
    sessionId,
    ticket,
    expiresAtMs,
    dimensions,
    used: false,
  });
  return {
    ok: true,
    value: {
      sessionId,
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
}

export function consumeTerminalTicket(
  input: ConsumeTerminalTicketInput,
): MockTerminalMutationResult<MockLiveTerminalSession> {
  const reservation = reservations.get(input.ticket);
  if (
    reservation === undefined ||
    reservation.used ||
    Date.now() >= reservation.expiresAtMs ||
    reservation.userId !== input.userId ||
    reservation.projectId !== input.projectId ||
    reservation.runId !== input.runId ||
    reservation.sessionId !== input.sessionId ||
    !hasRunningAuthority(input.userId, input.projectId, input.runId)
  ) {
    return { ok: false, code: 'TERMINAL_TICKET_NOT_AVAILABLE' };
  }
  const key = liveSessionKey(input.userId, input.projectId, input.runId);
  if (liveSessions.has(key)) {
    return { ok: false, code: 'TERMINAL_SESSION_ALREADY_ACTIVE' };
  }
  reservation.used = true;
  const live: MockLiveTerminalSession = {
    userId: reservation.userId,
    projectId: reservation.projectId,
    runId: reservation.runId,
    sessionId: reservation.sessionId,
    cols: reservation.dimensions.cols,
    rows: reservation.dimensions.rows,
    state: 'live',
  };
  liveSessions.set(key, live);
  appendAuditRecord(live.userId, live.projectId, live.runId, {
    sessionId: live.sessionId,
    command: terminalScenario === 'stress' ? 'ensoai-stage5-terminal-stress' : 'mvn test',
    state: 'RUNNING',
    startedAt: new Date(Date.now()).toISOString(),
    finishedAt: null,
    exitCode: null,
  });
  return { ok: true, value: { ...live } };
}

export function endTerminalSession(
  input: EndTerminalSessionInput,
): MockTerminalMutationResult<MockEndedTerminalSession> {
  const key = liveSessionKey(input.userId, input.projectId, input.runId);
  const live = liveSessions.get(key);
  if (live === undefined || live.sessionId !== input.sessionId) {
    return { ok: false, code: 'TERMINAL_NOT_AVAILABLE' };
  }
  liveSessions.delete(key);
  invalidateUnusedReservations(
    (reservation) =>
      reservation.userId === input.userId &&
      reservation.projectId === input.projectId &&
      reservation.runId === input.runId,
  );
  const state = input.reason === 'CONNECTION_LOST' ? 'interrupted' : 'closed';
  const ended: MockEndedTerminalSession = {
    ...live,
    state,
    reason: input.reason,
    exitCode: input.exitCode,
  };
  settleAuditForSession(ended);
  emitTerminalStateEvent({ type: 'session.ended', session: { ...ended } });
  return { ok: true, value: ended };
}

export function subscribeTerminalStateEvents(
  listener: (event: MockTerminalStateEvent) => void,
): () => void {
  terminalStateSubscribers.add(listener);
  return () => {
    terminalStateSubscribers.delete(listener);
  };
}

function handleRunLeavingRunning(projectId: string, runId: string): void {
  invalidateUnusedReservations(
    (reservation) => reservation.projectId === projectId && reservation.runId === runId,
  );
  for (const live of [...liveSessions.values()]) {
    if (live.projectId === projectId && live.runId === runId) {
      endTerminalSession({
        userId: live.userId,
        projectId,
        runId,
        sessionId: live.sessionId,
        reason: 'RUN_LEFT_RUNNING',
        exitCode: null,
      });
    }
  }
}

export function seedTerminalAuditFixtures(
  userId: string,
  projectId: string,
  runId: string,
): void {
  const now = Date.now();
  const fixtures: Array<{
    suffix: string;
    command: string;
    state: TerminalAuditState;
    startedAtMs: number;
    finishedAtMs: number | null;
    exitCode: number | null;
  }> = [
    { suffix: 'running', command: 'mvn test', state: 'RUNNING', startedAtMs: now - 60_000, finishedAtMs: null, exitCode: null },
    { suffix: 'success', command: 'mvn test', state: 'SUCCEEDED', startedAtMs: now - 120_000, finishedAtMs: now - 110_000, exitCode: 0 },
    { suffix: 'failure', command: 'mvn verify', state: 'FAILED', startedAtMs: now - 180_000, finishedAtMs: now - 170_000, exitCode: 1 },
    { suffix: 'interrupted', command: 'ensoai-stage5-terminal-stress', state: 'INTERRUPTED', startedAtMs: now - 240_000, finishedAtMs: now - 230_000, exitCode: null },
    { suffix: 'expired', command: 'mvn test', state: 'FAILED', startedAtMs: now - TERMINAL_AUDIT_RETENTION_MS - 1, finishedAtMs: now - TERMINAL_AUDIT_RETENTION_MS, exitCode: 1 },
  ];
  for (const fixture of fixtures) {
    appendAuditRecord(userId, projectId, runId, {
      sessionId: parseTerminalSessionId(`${MOCK_TERMINAL_SESSION_PREFIX}fixture-${fixture.suffix}`),
      command: fixture.command,
      state: fixture.state,
      startedAt: new Date(fixture.startedAtMs).toISOString(),
      finishedAt: fixture.finishedAtMs === null
        ? null
        : new Date(fixture.finishedAtMs).toISOString(),
      exitCode: fixture.exitCode,
    });
  }
}

export function listTerminalAudits(
  userId: string,
  projectId: string,
  runId: string,
  options: ListTerminalAuditOptions = {},
): TerminalAuditListResponse {
  const limit =
    typeof options.limit === 'number' &&
    Number.isSafeInteger(options.limit) &&
    options.limit >= 1 &&
    options.limit <= 50
      ? options.limit
      : 50;
  const cutoffMs = Date.now() - TERMINAL_AUDIT_RETENTION_MS;
  const sorted = auditRecords
    .filter(
      (record) =>
        record.userId === userId &&
        record.projectId === projectId &&
        record.runId === runId &&
        (options.sessionId === undefined || record.entry.sessionId === options.sessionId) &&
        Date.parse(record.entry.startedAt) >= cutoffMs,
    )
    .sort((left, right) => {
      const started = Date.parse(right.entry.startedAt) - Date.parse(left.entry.startedAt);
      return started === 0 ? right.seq - left.seq : started;
    });
  let start = 0;
  if (typeof options.cursor === 'string' && options.cursor !== '') {
    const index = sorted.findIndex((record) => record.entry.id === options.cursor);
    start = index < 0 ? sorted.length : index + 1;
  }
  const page = sorted.slice(start, start + limit);
  const last = page[page.length - 1];
  return parseTerminalAuditListResponse({
    items: page.map((record) => structuredClone(record.entry)),
    nextCursor:
      start + limit < sorted.length && last !== undefined ? last.entry.id : null,
  });
}

export function getLiveTerminalSession(
  userId: string,
  projectId: string,
  runId: string,
): MockLiveTerminalSession | null {
  const live = liveSessions.get(liveSessionKey(userId, projectId, runId));
  return live === undefined ? null : { ...live };
}

export function getUnusedTerminalReservationCount(
  userId: string,
  projectId: string,
  runId: string,
): number {
  return [...reservations.values()].filter(
    (reservation) =>
      !reservation.used &&
      Date.now() < reservation.expiresAtMs &&
      reservation.userId === userId &&
      reservation.projectId === projectId &&
      reservation.runId === runId,
  ).length;
}

export function resetTerminalState(): void {
  nextReservationSeq = 0;
  reservations = new Map();
  liveSessions = new Map();
  nextAuditSeq = 0;
  auditRecords = [];
  terminalScenario = 'normal';
  terminalStorage()?.removeItem(MOCK_TERMINAL_PERSISTENCE_KEY);
  terminalStateSubscribers.clear();
}

registerTerminalStateReset(resetTerminalState);
subscribeMockRunBeforeTransition((event) => {
  handleRunLeavingRunning(event.projectId, event.runId);
});
