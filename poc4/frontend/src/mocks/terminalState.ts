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
import {
  getActiveRun,
  isMockRunTransitionInProgress,
  registerMockRunBeforeTransitionFinalizer,
} from './runState';
import { canReadReadyProjectFiles, registerTerminalStateReset } from './state';

export const MOCK_TERMINAL_TICKET_PREFIX = 'mock-terminal-ticket-';
export const MOCK_TERMINAL_SESSION_PREFIX = 'mock-terminal-session-';
export const MOCK_TERMINAL_AUDIT_PREFIX = 'mock-terminal-audit-';
export const MOCK_TERMINAL_PERSISTENCE_KEY = 'ensoai.mock.terminal-scenario.v1';
export const TERMINAL_TICKET_TTL_MS = 30_000;
export const TERMINAL_TICKET_REPLAY_GRACE_MS = 5_000;
export const TERMINAL_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type TerminalScenario =
  | 'normal'
  | 'ticket-expired'
  | 'ticket-unavailable'
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
  'ticket-unavailable',
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
  state: 'available' | 'used' | 'unavailable';
};

export type MockTerminalHandshakeClassification =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'TICKET_NOT_AVAILABLE'
        | 'TICKET_EXPIRED'
        | 'TICKET_ALREADY_USED'
        | 'SESSION_ALREADY_ACTIVE'
        | 'SESSION_NOT_AVAILABLE';
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
let reservationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let liveSessions = new Map<string, MockLiveTerminalSession>();
let nextAuditSeq = 0;
let auditRecords: TerminalAuditRecord[] = [];
let terminalScenario: TerminalScenario = 'normal';
const seededAuditScenarioRuns = new Set<string>();
const terminalStateSubscribers = new Set<(event: MockTerminalStateEvent) => void>();
const terminalFinalizationsInProgress = new Set<string>();

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

function terminalRunKey(projectId: string, runId: string): string {
  return `${projectId}\0${runId}`;
}

function scheduleReservationCleanup(reservation: TerminalReservation): void {
  const delayMs = Math.max(
    0,
    reservation.expiresAtMs + TERMINAL_TICKET_REPLAY_GRACE_MS - Date.now(),
  );
  const timer = setTimeout(() => {
    if (reservations.get(reservation.ticket) === reservation) {
      reservations.delete(reservation.ticket);
    }
    if (reservationCleanupTimers.get(reservation.ticket) === timer) {
      reservationCleanupTimers.delete(reservation.ticket);
    }
  }, delayMs);
  reservationCleanupTimers.set(reservation.ticket, timer);
}

function hasRunningAuthority(userId: string, projectId: string, runId: string): boolean {
  const activeRun = getActiveRun(projectId);
  return (
    !isMockRunTransitionInProgress(projectId, runId) &&
    !terminalFinalizationsInProgress.has(terminalRunKey(projectId, runId)) &&
    canReadReadyProjectFiles(userId, projectId) &&
    activeRun !== null &&
    activeRun.id === runId &&
    activeRun.state === 'RUNNING'
  );
}

function emitTerminalStateEvent(event: MockTerminalStateEvent): void {
  for (const listener of terminalStateSubscribers) {
    try {
      listener(event);
    } catch {
      // External observers run after the authoritative terminal state commit.
    }
  }
}

type PreparedReservationInvalidation = {
  ticket: string;
  event: Extract<MockTerminalStateEvent, { type: 'reservation.invalidated' }>;
};

function prepareReservationInvalidations(
  matches: (reservation: TerminalReservation) => boolean,
): PreparedReservationInvalidation[] {
  return [...reservations.entries()]
    .filter(
      ([, reservation]) =>
        reservation.state === 'available' &&
        Date.now() < reservation.expiresAtMs &&
        matches(reservation),
    )
    .map(([ticket, reservation]) => ({
      ticket,
      event: {
        type: 'reservation.invalidated',
        userId: reservation.userId,
        projectId: reservation.projectId,
        runId: reservation.runId,
        sessionId: reservation.sessionId,
      },
    }));
}

function buildAuditRecord(
  seq: number,
  userId: string,
  projectId: string,
  runId: string,
  entry: Omit<TerminalAuditEntry, 'id'>,
): TerminalAuditRecord {
  const parsed = parseTerminalAuditListResponse({
    items: [{ ...entry, id: parseTerminalAuditId(`${MOCK_TERMINAL_AUDIT_PREFIX}${seq}`) }],
    nextCursor: null,
  }).items[0];
  if (parsed === undefined) {
    throw new Error('Invalid mock terminal audit fixture');
  }
  return { seq, userId, projectId, runId, entry: parsed };
}

function appendAuditRecord(
  userId: string,
  projectId: string,
  runId: string,
  entry: Omit<TerminalAuditEntry, 'id'>,
): TerminalAuditEntry {
  const record = buildAuditRecord(nextAuditSeq + 1, userId, projectId, runId, entry);
  nextAuditSeq = record.seq;
  auditRecords.push(record);
  return record.entry;
}

function seedPaginatedAuditScenario(userId: string, projectId: string, runId: string): void {
  const key = `${userId}\u0000${projectId}\u0000${runId}`;
  if (seededAuditScenarioRuns.has(key)) return;
  seededAuditScenarioRuns.add(key);
  const now = Date.now();
  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index + 1).padStart(2, '0');
    appendAuditRecord(userId, projectId, runId, {
      sessionId: parseTerminalSessionId(`${MOCK_TERMINAL_SESSION_PREFIX}audit-${suffix}`),
      command: index === 0 ? 'ensoai-stage5-audit-marker' : `mvn -q test -Daudit=${suffix}`,
      state: 'SUCCEEDED',
      startedAt: new Date(now - (index + 1) * 1_000).toISOString(),
      finishedAt: new Date(now - (index + 1) * 1_000 + 500).toISOString(),
      exitCode: 0,
    });
  }
}

type PreparedAuditSettlement = { record: TerminalAuditRecord; entry: TerminalAuditEntry };

function prepareAuditSettlement(
  session: MockEndedTerminalSession,
): PreparedAuditSettlement | null {
  const record = auditRecords.find(
    (candidate) =>
      candidate.userId === session.userId &&
      candidate.projectId === session.projectId &&
      candidate.runId === session.runId &&
      candidate.entry.sessionId === session.sessionId &&
      candidate.entry.state === 'RUNNING',
  );
  if (record === undefined) return null;
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
  if (parsed === undefined) {
    throw new Error('Invalid mock terminal audit settlement');
  }
  return { record, entry: parsed };
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
  const reservation: TerminalReservation = {
    userId,
    projectId,
    runId,
    sessionId,
    ticket,
    expiresAtMs,
    dimensions,
    state: 'available',
  };
  reservations.set(ticket, reservation);
  scheduleReservationCleanup(reservation);
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
    reservation.state !== 'available' ||
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
  const live: MockLiveTerminalSession = {
    userId: reservation.userId,
    projectId: reservation.projectId,
    runId: reservation.runId,
    sessionId: reservation.sessionId,
    cols: reservation.dimensions.cols,
    rows: reservation.dimensions.rows,
    state: 'live',
  };
  if (terminalScenario === 'audit') {
    seedPaginatedAuditScenario(live.userId, live.projectId, live.runId);
  }
  const audit = buildAuditRecord(nextAuditSeq + 1, live.userId, live.projectId, live.runId, {
    sessionId: live.sessionId,
    command: terminalScenario === 'stress' ? 'ensoai-stage5-terminal-stress' : 'mvn test',
    state: 'RUNNING',
    startedAt: new Date(Date.now()).toISOString(),
    finishedAt: null,
    exitCode: null,
  });
  reservation.state = 'used';
  liveSessions.set(key, live);
  nextAuditSeq = audit.seq;
  auditRecords.push(audit);
  return { ok: true, value: { ...live } };
}

export function classifyTerminalTicketForHandshake(
  ticket: string,
): MockTerminalHandshakeClassification {
  const reservation = reservations.get(ticket);
  if (reservation === undefined) {
    return { ok: false, code: 'TICKET_NOT_AVAILABLE' };
  }
  if (reservation.state === 'used') {
    return { ok: false, code: 'TICKET_ALREADY_USED' };
  }
  if (reservation.state === 'unavailable') {
    return { ok: false, code: 'SESSION_NOT_AVAILABLE' };
  }
  if (Date.now() >= reservation.expiresAtMs) {
    return { ok: false, code: 'TICKET_EXPIRED' };
  }
  if (!hasRunningAuthority(reservation.userId, reservation.projectId, reservation.runId)) {
    return { ok: false, code: 'SESSION_NOT_AVAILABLE' };
  }
  if (liveSessions.has(liveSessionKey(reservation.userId, reservation.projectId, reservation.runId))) {
    return { ok: false, code: 'SESSION_ALREADY_ACTIVE' };
  }
  return { ok: true };
}

export function consumeTerminalTicketByTicket(
  ticket: string,
): MockTerminalMutationResult<MockLiveTerminalSession> {
  const reservation = reservations.get(ticket);
  if (reservation === undefined) {
    return { ok: false, code: 'TERMINAL_TICKET_NOT_AVAILABLE' };
  }
  return consumeTerminalTicket({
    userId: reservation.userId,
    projectId: reservation.projectId,
    runId: reservation.runId,
    sessionId: reservation.sessionId,
    ticket,
  });
}

export function endTerminalSession(
  input: EndTerminalSessionInput,
): MockTerminalMutationResult<MockEndedTerminalSession> {
  const key = liveSessionKey(input.userId, input.projectId, input.runId);
  const live = liveSessions.get(key);
  if (live === undefined || live.sessionId !== input.sessionId) {
    return { ok: false, code: 'TERMINAL_NOT_AVAILABLE' };
  }
  const invalidations = prepareReservationInvalidations(
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
  const settlement = prepareAuditSettlement(ended);
  for (const invalidation of invalidations) {
    const reservation = reservations.get(invalidation.ticket);
    if (reservation !== undefined) reservation.state = 'unavailable';
  }
  liveSessions.delete(key);
  if (settlement !== null) settlement.record.entry = settlement.entry;
  for (const invalidation of invalidations) {
    emitTerminalStateEvent(invalidation.event);
  }
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

function finalizeTerminalRunTransition(projectId: string, runId: string): void {
  const key = terminalRunKey(projectId, runId);
  if (terminalFinalizationsInProgress.has(key)) return;
  terminalFinalizationsInProgress.add(key);
  try {
    finalizeTerminalRunTransitionOnce(projectId, runId);
  } finally {
    terminalFinalizationsInProgress.delete(key);
  }
}

function finalizeTerminalRunTransitionOnce(projectId: string, runId: string): void {
  const invalidations = prepareReservationInvalidations(
    (reservation) => reservation.projectId === projectId && reservation.runId === runId,
  );
  const ended = [...liveSessions.values()]
    .filter((live) => live.projectId === projectId && live.runId === runId)
    .map((live): MockEndedTerminalSession => ({
      ...live,
      state: 'closed',
      reason: 'RUN_LEFT_RUNNING',
      exitCode: null,
    }));
  const settlements = ended.map((session) => prepareAuditSettlement(session));

  for (const invalidation of invalidations) {
    const reservation = reservations.get(invalidation.ticket);
    if (reservation !== undefined) reservation.state = 'unavailable';
  }
  for (const session of ended) {
    liveSessions.delete(liveSessionKey(session.userId, session.projectId, session.runId));
  }
  for (const settlement of settlements) {
    if (settlement !== null) settlement.record.entry = settlement.entry;
  }
  for (const invalidation of invalidations) {
    emitTerminalStateEvent(invalidation.event);
  }
  for (const session of ended) {
    emitTerminalStateEvent({ type: 'session.ended', session: { ...session } });
  }
}

export function registerTerminalRunFinalizer(): void {
  registerMockRunBeforeTransitionFinalizer((event) => {
    finalizeTerminalRunTransition(event.projectId, event.runId);
  });
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
      reservation.state === 'available' &&
      Date.now() < reservation.expiresAtMs &&
      reservation.userId === userId &&
      reservation.projectId === projectId &&
      reservation.runId === runId,
  ).length;
}

export function getTerminalReservationCount(
  userId: string,
  projectId: string,
  runId: string,
): number {
  return [...reservations.values()].filter(
    (reservation) =>
      reservation.state === 'available' &&
      reservation.userId === userId &&
      reservation.projectId === projectId &&
      reservation.runId === runId,
  ).length;
}

export function getTerminalReservationBackingStoreDiagnostics(): {
  records: number;
  timers: number;
} {
  return { records: reservations.size, timers: reservationCleanupTimers.size };
}

export function resetTerminalState(): void {
  for (const timer of reservationCleanupTimers.values()) clearTimeout(timer);
  nextReservationSeq = 0;
  reservations = new Map();
  reservationCleanupTimers = new Map();
  liveSessions = new Map();
  nextAuditSeq = 0;
  auditRecords = [];
  seededAuditScenarioRuns.clear();
  terminalScenario = 'normal';
  terminalStorage()?.removeItem(MOCK_TERMINAL_PERSISTENCE_KEY);
  terminalStateSubscribers.clear();
  terminalFinalizationsInProgress.clear();
  registerTerminalRunFinalizer();
}

registerTerminalStateReset(resetTerminalState);
registerTerminalRunFinalizer();
