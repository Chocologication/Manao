import { http, HttpResponse } from 'msw';
import type { ApiErrorBody } from '../contracts/api';
import type { AuthUser, LoginRequest } from '../contracts/auth';
import {
  createOwnedProject,
  expireCurrentToken,
  listOwnedProjectSummaries,
  loginWithCredentials,
  readOwnedProjectSummary,
  resolveUserByAccessToken,
} from './state';

const LOGIN_UNAUTHENTICATED: ApiErrorBody = {
  code: 'UNAUTHENTICATED',
  message: 'Invalid username or password',
  traceId: 'mock-trace-login',
};

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

const PROJECT_LIMIT_REACHED: ApiErrorBody = {
  code: 'PROJECT_LIMIT_REACHED',
  message: 'Project limit reached',
  traceId: 'mock-trace-project-limit',
};

const VALIDATION_ERROR: ApiErrorBody = {
  code: 'VALIDATION_ERROR',
  message: 'Invalid project name',
  traceId: 'mock-trace-validation',
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

function isLoginRequest(value: unknown): value is LoginRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.username === 'string' && typeof record.password === 'string';
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const handlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = await readJsonBody(request);
    if (!isLoginRequest(body)) {
      return jsonError(401, LOGIN_UNAUTHENTICATED);
    }
    const session = loginWithCredentials(body.username, body.password);
    if (session === null) {
      return jsonError(401, LOGIN_UNAUTHENTICATED);
    }
    return HttpResponse.json(session);
  }),

  // Mock-only: invalidate the presented token so the next real GET 401s.
  http.post('/api/v1/session/expire', ({ request }) => {
    if (!expireCurrentToken(readBearerToken(request))) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/v1/projects', ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    return HttpResponse.json({
      items: listOwnedProjectSummaries(auth.user.id),
      limit: 3,
    });
  }),

  http.post('/api/v1/projects', async ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const body = await readJsonBody(request);
    const name =
      body !== null &&
      typeof body === 'object' &&
      'name' in body &&
      typeof body.name === 'string'
        ? body.name
        : null;
    if (name === null) {
      return jsonError(400, VALIDATION_ERROR);
    }
    const result = createOwnedProject(auth.user.id, name);
    if (result.status === 'limit') {
      return jsonError(409, PROJECT_LIMIT_REACHED);
    }
    return HttpResponse.json(result.project, { status: 202 });
  }),

  http.get('/api/v1/projects/:projectId', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = params.projectId;
    const id = Array.isArray(projectId) ? projectId[0] : projectId;
    if (typeof id !== 'string' || id.length === 0) {
      return jsonError(403, FORBIDDEN);
    }
    const project = readOwnedProjectSummary(auth.user.id, id);
    if (project === null) {
      // Same generic 403 for unknown and non-owned ids; do not leak existence.
      return jsonError(403, FORBIDDEN);
    }
    return HttpResponse.json(project);
  }),
];
