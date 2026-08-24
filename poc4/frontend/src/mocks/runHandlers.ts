import { http, HttpResponse } from 'msw';
import type { ApiErrorBody } from '../contracts/api';
import type { AuthUser } from '../contracts/auth';
import {
  getActiveRun,
  getRun,
  listRuns,
  startRun,
  stopRun,
  type MockRunErrorCode,
} from './runState';
import { isLogTicketUnavailable, issueLogTicket } from './runSocket';
import { canReadReadyProjectFiles, resolveUserByAccessToken } from './state';

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
  message: 'Invalid project name',
  traceId: 'mock-trace-validation',
};

const WORKSPACE_REVISION_CONFLICT: ApiErrorBody = {
  code: 'WORKSPACE_REVISION_CONFLICT',
  message: 'Workspace revision conflict',
  traceId: 'mock-trace-revision-conflict',
};

const RUN_ALREADY_ACTIVE: ApiErrorBody = {
  code: 'RUN_ALREADY_ACTIVE',
  message: 'A run is already active',
  traceId: 'mock-trace-run-already-active',
};

const RUN_STATE_CONFLICT: ApiErrorBody = {
  code: 'RUN_STATE_CONFLICT',
  message: 'Run state conflict',
  traceId: 'mock-trace-run-state-conflict',
};

const RUN_NOT_FOUND: ApiErrorBody = {
  code: 'RUN_NOT_FOUND',
  message: 'Run not found',
  traceId: 'mock-trace-run-not-found',
};

const LOG_TICKET_NOT_AVAILABLE: ApiErrorBody = {
  code: 'LOG_TICKET_NOT_AVAILABLE',
  message: 'Log ticket not available',
  traceId: 'mock-trace-log-ticket-unavailable',
};

function jsonError(status: number, body: ApiErrorBody) {
  return HttpResponse.json(body, { status });
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function authorize(
  request: Request,
): { user: AuthUser } | { response: ReturnType<typeof jsonError> } {
  const user = resolveUserByAccessToken(readBearerToken(request));
  if (user === null) {
    return { response: jsonError(401, REQUEST_UNAUTHENTICATED) };
  }
  return { user };
}

function readParam(value: string | readonly string[] | undefined): string | null {
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return id;
}

function authorizeReadyProject(
  request: Request,
  params: { projectId?: string | readonly string[] },
): { user: AuthUser; projectId: string } | { response: ReturnType<typeof jsonError> } {
  const auth = authorize(request);
  if ('response' in auth) {
    return auth;
  }
  const projectId = readParam(params.projectId);
  if (projectId === null || !canReadReadyProjectFiles(auth.user.id, projectId)) {
    return { response: jsonError(403, FORBIDDEN) };
  }
  return { user: auth.user, projectId };
}

function runMutationError(code: MockRunErrorCode) {
  switch (code) {
    case 'VALIDATION_ERROR':
      return jsonError(400, VALIDATION_ERROR);
    case 'WORKSPACE_REVISION_CONFLICT':
      return jsonError(409, WORKSPACE_REVISION_CONFLICT);
    case 'RUN_ALREADY_ACTIVE':
      return jsonError(409, RUN_ALREADY_ACTIVE);
    case 'RUN_STATE_CONFLICT':
      return jsonError(409, RUN_STATE_CONFLICT);
    case 'RUN_NOT_FOUND':
      return jsonError(404, RUN_NOT_FOUND);
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') {
    return 20;
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return 20;
  }
  return limit;
}

export const runHandlers = [
  http.get('/api/v1/projects/:projectId/runs/active', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    return HttpResponse.json({ run: getActiveRun(access.projectId) });
  }),

  http.get('/api/v1/projects/:projectId/runs/:runId', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    const runId = readParam(params.runId);
    if (runId === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    const run = getRun(access.projectId, runId);
    if (run === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    return HttpResponse.json(run);
  }),

  http.get('/api/v1/projects/:projectId/runs', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    const url = new URL(request.url);
    return HttpResponse.json(
      listRuns(access.projectId, {
        limit: parseLimit(url.searchParams.get('limit')),
        cursor: url.searchParams.get('cursor'),
      }),
    );
  }),

  http.post('/api/v1/projects/:projectId/runs/:runId/stop', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    const runId = readParam(params.runId);
    if (runId === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    const result = stopRun(access.projectId, runId);
    if (!result.ok) {
      return runMutationError(result.code);
    }
    return HttpResponse.json(result.value.run);
  }),

  http.post('/api/v1/projects/:projectId/runs/:runId/log-ticket', ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    const runId = readParam(params.runId);
    if (runId === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    const run = getRun(access.projectId, runId);
    if (run === null) {
      return jsonError(404, RUN_NOT_FOUND);
    }
    if (isLogTicketUnavailable()) {
      return jsonError(503, LOG_TICKET_NOT_AVAILABLE);
    }
    return HttpResponse.json(issueLogTicket(access.user.id, access.projectId, run.id));
  }),

  http.post('/api/v1/projects/:projectId/runs', async ({ request, params }) => {
    const access = authorizeReadyProject(request, params);
    if ('response' in access) {
      return access.response;
    }
    const result = startRun(access.projectId, await readJsonBody(request));
    if (!result.ok) {
      return runMutationError(result.code);
    }
    return HttpResponse.json(result.value.run, { status: 202 });
  }),
];
