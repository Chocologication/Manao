import { ws } from 'msw';
import {
  parseLogClientFrame,
  type LogServerFrame,
} from '../contracts/log';
import { isRunTerminalState } from '../contracts/run';
import {
  LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS,
  LARGE_LOG_WHILE_DISCONNECTED_MARKER,
  LARGE_LOG_WHILE_DISCONNECTED_TEXT,
} from './largeLogPayload';
import {
  GAP_SKIPPED_MARKER,
  PERSISTED_OFFLINE_MARKER,
  PERSISTED_OFFLINE_TEXT,
  RECONNECT_LIVE_MARKER,
  RECONNECT_LIVE_TEXT,
} from './runFixtures';
import {
  appendLogChunk,
  getLogWindow,
  getMockRunNowMs,
  getRun,
  getRunScenario,
  subscribeMockRunEvents,
  type MockRunSubscriberEvent,
} from './runState';

export const MOCK_LOG_TICKET_PREFIX = 'mock-run-log-ticket-';
export const MOCK_LOG_TICKET_TTL_MS = 30_000;

export type MockLogTicketRecord = {
  ticket: string;
  userId: string;
  projectId: string;
  runId: string;
  expiresAtMs: number;
  used: boolean;
};

const runLogs = ws.link(/\/api\/v1\/ws\/run-logs/);

let tickets = new Map<string, MockLogTicketRecord>();
let logTicketUnavailable = false;
let nextTicketSeq = 0;

function cloneTicket(record: MockLogTicketRecord): MockLogTicketRecord {
  return {
    ticket: record.ticket,
    userId: record.userId,
    projectId: record.projectId,
    runId: record.runId,
    expiresAtMs: record.expiresAtMs,
    used: record.used,
  };
}

export function issueLogTicket(
  userId: string,
  projectId: string,
  runId: string,
): { ticket: string; expiresAt: string } {
  nextTicketSeq += 1;
  const ticket = `${MOCK_LOG_TICKET_PREFIX}${String(nextTicketSeq).padStart(6, '0')}`;
  const expiresAtMs = getMockRunNowMs() + MOCK_LOG_TICKET_TTL_MS;
  tickets.set(ticket, {
    ticket,
    userId,
    projectId,
    runId,
    expiresAtMs,
    used: false,
  });
  return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function getMockLogTicketRecords(): MockLogTicketRecord[] {
  return [...tickets.values()].map(cloneTicket);
}

export function setLogTicketUnavailable(value: boolean): void {
  logTicketUnavailable = value;
}

export function isLogTicketUnavailable(): boolean {
  return logTicketUnavailable;
}

export function resetLogTickets(): void {
  tickets = new Map();
  nextTicketSeq = 0;
  logTicketUnavailable = false;
  for (const client of [...runLogs.clients]) {
    client.close();
  }
}

function consumeTicket(raw: string | null): { record: MockLogTicketRecord } | { code: number } {
  if (raw === null || raw === '') {
    return { code: 4401 };
  }
  const record = tickets.get(raw);
  if (record === undefined) {
    return { code: 4401 };
  }
  if (record.used) {
    return { code: 4409 };
  }
  if (getMockRunNowMs() >= record.expiresAtMs) {
    return { code: 4408 };
  }
  if (getRun(record.projectId, record.runId) === null) {
    return { code: 4403 };
  }
  record.used = true;
  return { record };
}

function sendFrame(client: { send(data: string): void }, frame: LogServerFrame): void {
  client.send(JSON.stringify(frame));
}

function eventRunId(event: MockRunSubscriberEvent): string {
  return event.type === 'stream.heartbeat' ? event.runId : event.run.id;
}

function toWireFrame(event: MockRunSubscriberEvent): LogServerFrame {
  if (event.type === 'log.append') {
    return { type: 'log.append', chunk: event.chunk, window: event.window };
  }
  if (event.type === 'run.state') {
    return { type: 'run.state', run: event.run };
  }
  if (event.type === 'log.complete') {
    return { type: 'log.complete', lastSeq: event.lastSeq };
  }
  return { type: 'stream.heartbeat', serverTime: event.serverTime };
}

export const runLogsSocketHandler = runLogs.addEventListener('connection', ({ client }) => {
  const consumed = consumeTicket(client.url.searchParams.get('ticket'));
  if ('code' in consumed) {
    client.close(consumed.code);
    return;
  }
  const { record } = consumed;
  let subscribed = false;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const shutdown = (code?: number): void => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    queueMicrotask(() => {
      if (code === undefined) {
        client.close();
        return;
      }
      client.close(code);
    });
  };

  client.addEventListener('close', () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
  });

  client.addEventListener('message', (event) => {
    if (closed) {
      return;
    }
    if (subscribed) {
      sendFrame(client, { type: 'stream.error', code: 'PROTOCOL_ERROR', retryable: false });
      shutdown();
      return;
    }
    if (typeof event.data !== 'string') {
      sendFrame(client, { type: 'stream.error', code: 'PROTOCOL_ERROR', retryable: false });
      shutdown();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      sendFrame(client, { type: 'stream.error', code: 'PROTOCOL_ERROR', retryable: false });
      shutdown();
      return;
    }
    let subscribe: ReturnType<typeof parseLogClientFrame>;
    try {
      subscribe = parseLogClientFrame(parsed);
    } catch {
      sendFrame(client, { type: 'stream.error', code: 'PROTOCOL_ERROR', retryable: false });
      shutdown();
      return;
    }
    subscribed = true;
    const run = getRun(record.projectId, record.runId);
    const logWindow = getLogWindow(record.projectId, record.runId);
    if (run === null || logWindow === null) {
      sendFrame(client, { type: 'stream.error', code: 'RUN_NOT_FOUND', retryable: false });
      shutdown(4403);
      return;
    }
    const lastSeq = subscribe.lastSeq;
    const chunks =
      lastSeq === null ? logWindow.chunks : logWindow.chunks.filter((chunk) => chunk.seq > lastSeq);
    sendFrame(client, { type: 'log.replay', chunks, window: logWindow.window });
    sendFrame(client, { type: 'run.state', run });
    if (isRunTerminalState(run.state)) {
      sendFrame(client, { type: 'log.complete', lastSeq: run.lastLogSeq });
    }
    const scenario = getRunScenario();
    if (scenario === 'disconnect') {
      const hasOffline = logWindow.chunks.some((chunk) =>
        chunk.text.includes(PERSISTED_OFFLINE_MARKER),
      );
      if (!hasOffline) {
        sendFrame(client, { type: 'stream.error', code: 'STREAM_UNAVAILABLE', retryable: true });
        shutdown(1011);
        appendLogChunk(record.projectId, record.runId, PERSISTED_OFFLINE_TEXT);
        return;
      }
    }
    let duplicatedLive = false;
    let largeLogLiveAppends = 0;
    unsubscribe = subscribeMockRunEvents((live) => {
      if (closed || live.projectId !== record.projectId || eventRunId(live) !== record.runId) {
        return;
      }
      if (
        live.type === 'log.append' &&
        scenario === 'gap' &&
        live.chunk.text.includes(GAP_SKIPPED_MARKER)
      ) {
        return;
      }
      const frame = toWireFrame(live);
      sendFrame(client, frame);
      if (live.type === 'log.append' && !duplicatedLive && scenario !== 'large-log') {
        duplicatedLive = true;
        sendFrame(client, frame);
      }
      if (live.type === 'log.append' && scenario === 'large-log') {
        largeLogLiveAppends += 1;
        if (largeLogLiveAppends >= LARGE_LOG_DISCONNECT_AFTER_LIVE_CHUNKS) {
          sendFrame(client, { type: 'stream.error', code: 'STREAM_UNAVAILABLE', retryable: true });
          shutdown(1011);
          const latest = getLogWindow(record.projectId, record.runId);
          const alreadyPersisted = latest?.chunks.some((chunk) =>
            chunk.text.includes(LARGE_LOG_WHILE_DISCONNECTED_MARKER),
          );
          if (alreadyPersisted !== true) {
            appendLogChunk(record.projectId, record.runId, LARGE_LOG_WHILE_DISCONNECTED_TEXT);
          }
        }
      }
    });
    if (scenario === 'disconnect') {
      const latest = getLogWindow(record.projectId, record.runId);
      const hasReconnectLive = latest?.chunks.some((chunk) =>
        chunk.text.includes(RECONNECT_LIVE_MARKER),
      );
      if (hasReconnectLive !== true) {
        appendLogChunk(record.projectId, record.runId, RECONNECT_LIVE_TEXT);
      }
    }
  });
});
