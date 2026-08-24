import { http, HttpResponse } from 'msw';
import type { ApiErrorBody } from '../contracts/api';
import type { AuthUser } from '../contracts/auth';
import { getRun } from './runState';
import { canReadReadyProjectFiles, resolveUserByAccessToken } from './state';
import {
  isTerminalScenario,
  issueTerminalReservation,
  listTerminalAudits,
  setTerminalScenario,
  type MockTerminalErrorCode,
} from './terminalState';

const REQUEST_UNAUTHENTICATED: ApiErrorBody = {
  code: 'UNAUTHENTICATED',
  message: 'Authentication required',
  traceId: 'mock-trace-unauthenticated',
};

const FORBIDDEN: ApiErrorBody = {
  code: 'FORBIDDEN',
  message: 'Access denied',
  traceId: 'mock-trace-forbidden',
};

const VALIDATION_ERROR: ApiErrorBody = {
  code: 'VALIDATION_ERROR',
  message: 'Invalid terminal request',
  traceId: 'mock-trace-terminal-validation',
};

const RUN_NOT_FOUND: ApiErrorBody = {
  code: 'RUN_NOT_FOUND',
  message: 'Run not found',
  traceId: 'mock-trace-run-not-found',
};

const TERMINAL_NOT_AVAILABLE: ApiErrorBody = {
  code: 'TERMINAL_NOT_AVAILABLE',
  message: 'Terminal is not available',
  traceId: 'mock-trace-terminal-unavailable',
};

const TERMINAL_SESSION_ALREADY_ACTIVE: ApiErrorBody = {
  code: 'TERMINAL_SESSION_ALREADY_ACTIVE',
  message: 'Terminal session is already active',
  traceId: 'mock-trace-terminal-active',
};

function jsonError(status: number, body: ApiErrorBody) {
  return HttpResponse.json(body, { status });
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function authorize(request: Request): { user: AuthUser } | { response: ReturnType<typeof jsonError> } {
  const user = resolveUserByAccessToken(readBearerToken(request));
  return user === null
    ? { response: jsonError(401, REQUEST_UNAUTHENTICATED) }
    : { user };
}

function readParam(value: string | readonly string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

function authorizeReadyProject(
  request: Request,
  params: { projectId?: string | readonly string[] },
): { user: AuthUser; projectId: string } | { response: ReturnType<typeof jsonError> } {
  const auth = authorize(request);
  if ('response' in auth) return auth;
  const projectId = readParam(params.projectId);
  if (projectId === null || !canReadReadyProjectFiles(auth.user.id, projectId)) {
    return { response: jsonError(403, FORBIDDEN) };
  }
  return { user: auth.user, projectId };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function terminalMutationError(code: MockTerminalErrorCode) {
  switch (code) {
    case 'VALIDATION_ERROR':
      return jsonError(400, VALIDATION_ERROR);
    case 'TERMINAL_SESSION_ALREADY_ACTIVE':
      return jsonError(409, TERMINAL_SESSION_ALREADY_ACTIVE);
    case 'TERMINAL_NOT_AVAILABLE':
    case 'TERMINAL_TICKET_NOT_AVAILABLE':
      return jsonError(409, TERMINAL_NOT_AVAILABLE);
  }
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : undefined;
}

export const terminalHandlers = [
  http.post('/api/v1/projects/:projectId/runs/:runId/terminal-sessions', async ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) return access.response;
    const runId = readParam(params.runId);
    if (runId === null) return jsonError(409, TERMINAL_NOT_AVAILABLE);
    const result = issueTerminalReservation(
      access.user.id,
      access.projectId,
      runId,
      await readJsonBody(request),
    );
    if (!result.ok) return terminalMutationError(result.code);
    return HttpResponse.json(result.value, { status: 201 });
  }),

  http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) return access.response;
    const runId = readParam(params.runId);
    if (runId === null || getRun(access.projectId, runId) === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    const url = new URL(request.url);
    return HttpResponse.json(listTerminalAudits(access.user.id, access.projectId, runId, {
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor'),
    }));
  }),

  // Mock-only Stage 5 fixture selector. Production modules must never import this handler.
  http.post('/api/v1/session/terminal-scenario', async ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) return auth.response;
    const body = await readJsonBody(request);
    const scenario = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).scenario
      : undefined;
    if (!isTerminalScenario(scenario)) return jsonError(400, VALIDATION_ERROR);
    setTerminalScenario(scenario);
    return new HttpResponse(null, { status: 204 });
  }),
];
